/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileMeta, TransferProgress, TransferState } from "../types";
import { encryptChunk, decryptChunk, importKeyFromHex } from "./crypto";
import { saveChunkToDB, compileFilesFromDB, clearRoomFromDB } from "./db";
import { calculateSpeedAndETA, getWebSocketURL, getIceConfig } from "./webrtc-helper";

const CHUNK_SIZE = 1048576; // 1MB LAN-optimized chunking size

// Pause sending once this much data is queued on the data channel, resume once
// it drains to bufferedAmountLowThreshold.
const BUFFER_HIGH_WATER_MARK = 1024 * 1024;
const BUFFER_LOW_WATER_MARK = 65536;

/**
 * How long to let ICE negotiate before falling back to the WebSocket relay.
 *
 * The old value was 2s, which is fine on a LAN but shorter than a normal
 * STUN-assisted handshake, so WAN transfers were pushed onto the slow relay
 * path almost every time. We now wait longer and, crucially, only give up when
 * ICE has actually stopped making progress.
 */
const ICE_NEGOTIATION_TIMEOUT_MS = 12000;

/**
 * Generates an unguessable client identifier.
 *
 * Peer IDs are routing targets on a shared signalling server, so the previous
 * 6 characters of Math.random() (~31 bits, non-cryptographic) were weak enough
 * to enumerate. This yields 128 bits from the platform CSPRNG.
 */
export function generateClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ----------------------------------------------------
// Binary Framing Protocol for high-performance WS relay
// Format: [1-byte msgType] [1-byte targetLen] [N-bytes targetId] [1-byte senderLen] [M-bytes senderId] [4-bytes fileIndex] [4-bytes chunkIndex] [remaining payload]
// ----------------------------------------------------

export function encodeBinaryChunk(
  targetPeerId: string,
  senderPeerId: string,
  fileIndex: number,
  chunkIndex: number,
  chunkData: ArrayBuffer
): ArrayBuffer {
  const encoder = new TextEncoder();
  const targetBytes = encoder.encode(targetPeerId);
  const senderBytes = encoder.encode(senderPeerId);
  
  const headerSize = 1 + 1 + targetBytes.byteLength + 1 + senderBytes.byteLength + 4 + 4;
  const buffer = new ArrayBuffer(headerSize + chunkData.byteLength);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);
  
  let offset = 0;
  
  // 1. Message Type (0x01 = chunk)
  uint8[offset] = 0x01;
  offset += 1;
  
  // 2. Target Peer ID
  uint8[offset] = targetBytes.byteLength;
  offset += 1;
  uint8.set(targetBytes, offset);
  offset += targetBytes.byteLength;
  
  // 3. Sender Peer ID
  uint8[offset] = senderBytes.byteLength;
  offset += 1;
  uint8.set(senderBytes, offset);
  offset += senderBytes.byteLength;
  
  // 4. File Index (Big Endian)
  view.setUint32(offset, fileIndex, false);
  offset += 4;
  
  // 5. Chunk Index (Big Endian)
  view.setUint32(offset, chunkIndex, false);
  offset += 4;
  
  // 6. Payload data
  uint8.set(new Uint8Array(chunkData), offset);
  
  return buffer;
}

export function decodeBinaryChunk(buffer: ArrayBuffer): {
  targetPeerId: string;
  senderPeerId: string;
  fileIndex: number;
  chunkIndex: number;
  chunkData: ArrayBuffer;
} {
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  
  let offset = 0;
  const msgType = uint8[offset];
  if (msgType !== 0x01) {
    throw new Error("Invalid binary message type");
  }
  offset += 1;
  
  const targetLen = uint8[offset];
  offset += 1;
  const targetPeerId = decoder.decode(uint8.subarray(offset, offset + targetLen));
  offset += targetLen;
  
  const senderLen = uint8[offset];
  offset += 1;
  const senderPeerId = decoder.decode(uint8.subarray(offset, offset + senderLen));
  offset += senderLen;
  
  const fileIndex = view.getUint32(offset, false);
  offset += 4;
  
  const chunkIndex = view.getUint32(offset, false);
  offset += 4;
  
  const chunkData = buffer.slice(offset);
  
  return {
    targetPeerId,
    senderPeerId,
    fileIndex,
    chunkIndex,
    chunkData
  };
}

export interface P2PSenderOptions {
  roomId?: string;
  targetPeerId?: string;
  files: File[];
  cryptoKey?: CryptoKey | null;
  ws?: WebSocket | null;
  peerId?: string;
}

export class P2PSender {
  private roomId: string;
  private targetPeerId: string;
  private peerId: string;
  private files: File[];
  private cryptoKey: CryptoKey | null;
  private ws: WebSocket | null;
  private isExternalWs = false;
  private peers = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private activeTransfers = new Map<string, {
    fileIndex: number;
    chunkIndex: number;
    bytesSent: number;
    startTime: number;
    isTransferring: boolean;
    isRelaying: boolean;
    isWaitingForAck: boolean;
  }>();
  private lastProgressUpdates = new Map<string, number>();
  private negotiationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  public onPeerStatusChange: (peerId: string, status: string) => void = () => {};
  public onProgressUpdate: (peerId: string, progress: TransferProgress) => void = () => {};
  public onLogMessage: (msg: string) => void = () => {};

  constructor(options: P2PSenderOptions) {
    this.roomId = options.roomId || "";
    this.targetPeerId = options.targetPeerId || "";
    this.files = options.files;
    this.cryptoKey = options.cryptoKey || null;
    this.ws = options.ws || null;
    this.isExternalWs = !!options.ws;
    this.peerId = options.peerId || "sender_" + generateClientId();
  }

  public async start() {
    if (this.isExternalWs && this.ws) {
      this.onLogMessage("Reusing existing connection for direct signaling...");
      // In direct beam, setup is done externally via App.tsx but we still trigger connection if needed
      if (this.targetPeerId) {
        this.setupRTCPeerConnection(this.targetPeerId);
      }
      return;
    }

    const senderParams = new URLSearchParams({
      roomId: this.roomId,
      peerId: this.peerId,
      role: "sender"
    });
    const wsUrl = `${await getWebSocketURL()}?${senderParams.toString()}`;
    this.onLogMessage(`Connecting to signaling gateway: ${this.roomId}`);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.onLogMessage("Secure gateway established, awaiting receiver...");
    };

    this.ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      } else {
        try {
          const message = JSON.parse(event.data);
          this.handleSignalingMessage(message);
        } catch (err) {
          console.error("Sender signaling parse error:", err);
        }
      }
    };

    this.ws.onclose = () => {
      this.onLogMessage("Signaling connection detached.");
    };
  }

  public handleSignalingMessage(message: any) {
    const { type, senderPeerId, payload } = message;
    const peer = senderPeerId || this.targetPeerId;

    if (!peer) return;

    switch (type) {
      case "peer-joined":
        this.onLogMessage(`Receiver connected [${peer}]. Setting up WebRTC...`);
        this.setupRTCPeerConnection(peer);
        break;
      case "peer-left":
        this.onLogMessage(`Receiver left: ${peer}`);
        this.cleanupPeer(peer);
        break;
      case "answer": {
        const pc = this.peers.get(peer);
        if (pc) {
          pc.setRemoteDescription(new RTCSessionDescription(payload))
            .then(() => this.onLogMessage("Secure WebRTC channel negotiated."))
            .catch((err) => console.error("setRemoteDescription error:", err));
        }
        break;
      }
      case "ice-candidate": {
        const pc = this.peers.get(peer);
        if (pc && payload) {
          pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => {});
        }
        break;
      }
      case "relay-msg":
        if (payload) {
          this.handleRelayControlMessage(peer, payload);
        }
        break;
    }
  }

  public handleBinaryMessage(data: ArrayBuffer) {
    try {
      const decoded = decodeBinaryChunk(data);
      // Currently, clients only send control frames like JSON acks over signaling.
      // If we expand control signaling over binary, we parse here.
    } catch (err) {
      console.error("Binary client message parsing failed:", err);
    }
  }

  public stop() {
    if (!this.isExternalWs) {
      this.ws?.close();
    }
    // Snapshot the keys: cleanupPeer mutates the map being iterated.
    for (const peerId of Array.from(this.peers.keys())) {
      this.cleanupPeer(peerId);
    }
    for (const transfer of this.activeTransfers.values()) {
      // Releases any stream loop parked waiting on an ACK.
      transfer.isTransferring = false;
      transfer.isWaitingForAck = false;
    }
  }

  private setupRTCPeerConnection(rxPeerId: string) {
    if (this.peers.has(rxPeerId)) return;

    const pc = new RTCPeerConnection(getIceConfig());
    this.peers.set(rxPeerId, pc);

    const channel = pc.createDataChannel("transfer-channel", { ordered: true });
    channel.binaryType = "arraybuffer";
    this.channels.set(rxPeerId, channel);

    let connected = false;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignalingFrame(rxPeerId, this.targetPeerId ? "direct-ice-candidate" : "ice-candidate", e.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      this.onPeerStatusChange(rxPeerId, pc.connectionState);
      this.onLogMessage(`P2P Connection State with [${rxPeerId}]: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        connected = true;
      } else if (pc.connectionState === "failed") {
        this.onLogMessage(`WebRTC connection failed with [${rxPeerId}]. Falling back to WebSocket relay...`);
        this.initiateRelayFallback(rxPeerId);
      }
    };

    // Fall back to the relay only once ICE has had a realistic chance to
    // complete. A connection still in "checking" is making progress, so we give
    // it one more interval before giving up on the direct path.
    const negotiationDeadline = setTimeout(() => {
      if (connected || this.peers.get(rxPeerId) !== pc) return;
      if (pc.connectionState === "connected") return;

      const stillNegotiating =
        pc.iceConnectionState === "checking" || pc.iceGatheringState === "gathering";
      if (stillNegotiating) {
        this.onLogMessage(`WebRTC still negotiating with [${rxPeerId}], allowing extra time...`);
        setTimeout(() => {
          if (!connected && this.peers.get(rxPeerId) === pc && pc.connectionState !== "connected") {
            this.onLogMessage(`WebRTC negotiation timed out for [${rxPeerId}]. Falling back to WebSocket relay...`);
            this.initiateRelayFallback(rxPeerId);
          }
        }, ICE_NEGOTIATION_TIMEOUT_MS);
        return;
      }

      this.onLogMessage(`WebRTC connection negotiation timed out for [${rxPeerId}]. Falling back to WebSocket relay...`);
      this.initiateRelayFallback(rxPeerId);
    }, ICE_NEGOTIATION_TIMEOUT_MS);

    this.negotiationTimers.set(rxPeerId, negotiationDeadline);

    channel.onopen = () => {
      connected = true;
      const timer = this.negotiationTimers.get(rxPeerId);
      if (timer) clearTimeout(timer);
      this.negotiationTimers.delete(rxPeerId);
      this.onLogMessage(`Secure binary datachannel open with [${rxPeerId}]. Starting streams.`);
      this.startFileTransferQueue(rxPeerId);
    };

    channel.onmessage = (e) => {
      if (typeof e.data === "string") {
        try {
          const control = JSON.parse(e.data);
          this.handleReceiverAck(rxPeerId, control);
        } catch (err) {
          console.error("Error parsing receiver control packet:", err);
        }
      }
    };

    // Create Offer
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        this.sendSignalingFrame(rxPeerId, this.targetPeerId ? "direct-offer" : "offer", pc.localDescription);
      })
      .catch((err) => {
        this.onLogMessage(`WebRTC offer creation crashed: ${err.message}`);
      });
  }

  private sendSignalingFrame(targetPeerId: string, type: string, payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type,
        targetPeerId,
        payload
      }));
    }
  }

  private initiateRelayFallback(rxPeerId: string) {
    const transfer = this.activeTransfers.get(rxPeerId);
    if (transfer && transfer.isRelaying) return;

    this.onLogMessage(`[Relay Fallback] Setting up WebSocket chunk relay for [${rxPeerId}]...`);

    const timer = this.negotiationTimers.get(rxPeerId);
    if (timer) clearTimeout(timer);
    this.negotiationTimers.delete(rxPeerId);

    const pc = this.peers.get(rxPeerId);
    const ch = this.channels.get(rxPeerId);
    ch?.close();
    pc?.close();
    this.peers.delete(rxPeerId);
    this.channels.delete(rxPeerId);

    this.activeTransfers.set(rxPeerId, {
      fileIndex: transfer?.fileIndex || 0,
      chunkIndex: 0,
      bytesSent: 0,
      startTime: Date.now(),
      isTransferring: false,
      isRelaying: true,
      isWaitingForAck: false,
    });

    this.sendNextFileHeader(rxPeerId);
  }

  private async startFileTransferQueue(rxPeerId: string) {
    const transfer = this.activeTransfers.get(rxPeerId);
    const isRelaying = transfer?.isRelaying || false;

    this.activeTransfers.set(rxPeerId, {
      fileIndex: 0,
      chunkIndex: 0,
      bytesSent: 0,
      startTime: Date.now(),
      isTransferring: false,
      isRelaying,
      isWaitingForAck: false,
    });

    this.sendNextFileHeader(rxPeerId);
  }

  private sendNextFileHeader(rxPeerId: string) {
    const transfer = this.activeTransfers.get(rxPeerId);
    if (!transfer) return;

    if (transfer.fileIndex >= this.files.length) {
      this.onLogMessage(`All requested files transferred to [${rxPeerId}]!`);
      if (transfer.isRelaying) {
        this.sendRelayMessage(rxPeerId, { type: "all-complete" });
      } else {
        const channel = this.channels.get(rxPeerId);
        channel?.send(JSON.stringify({ type: "all-complete" }));
      }
      return;
    }

    const file = this.files[transfer.fileIndex];
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    this.onLogMessage(`Streaming file ${transfer.fileIndex + 1}/${this.files.length}: ${file.name} (via ${transfer.isRelaying ? "Relay" : "Direct P2P"})`);

    const header = {
      type: "header",
      fileIndex: transfer.fileIndex,
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
    };

    if (transfer.isRelaying) {
      this.sendRelayMessage(rxPeerId, header);
    } else {
      const channel = this.channels.get(rxPeerId);
      if (channel && channel.readyState === "open") {
        channel.send(JSON.stringify(header));
      }
    }
  }

  private sendRelayMessage(targetPeerId: string, payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "relay-msg",
        targetPeerId,
        payload
      }));
    }
  }

  private async handleReceiverAck(rxPeerId: string, message: any) {
    const { type, fileIndex, chunkIndex, resumeChunkIndex } = message;
    const transfer = this.activeTransfers.get(rxPeerId);
    const channel = this.channels.get(rxPeerId);
    if (!transfer || !channel || channel.readyState !== "open") return;

    if (type === "ready") {
      const startFrom = resumeChunkIndex ? Number(resumeChunkIndex) : 0;
      transfer.chunkIndex = startFrom;
      transfer.bytesSent = startFrom * CHUNK_SIZE;
      transfer.startTime = Date.now();
      transfer.isTransferring = true;
      
      this.onLogMessage(`Starting streaming [${this.files[fileIndex].name}] from chunk index ${startFrom}`);
      this.streamFileChunks(rxPeerId);
    } 
    else if (type === "ack") {
      const file = this.files[fileIndex];
      const bytesAcked = Math.min(file.size, (chunkIndex + 1) * CHUNK_SIZE);
      const percent = Math.round((bytesAcked / file.size) * 100);
      const now = Date.now();
      const lastUpdate = this.lastProgressUpdates.get(rxPeerId) || 0;

      if (now - lastUpdate > 150 || percent === 100) {
        this.lastProgressUpdates.set(rxPeerId, now);
        const { speed, eta } = calculateSpeedAndETA(bytesAcked, file.size, transfer.startTime);

        this.onProgressUpdate(rxPeerId, {
          fileIndex,
          fileName: file.name,
          fileSize: file.size,
          bytesSentOrReceived: bytesAcked,
          percent,
          speed,
          eta,
          status: "transferring",
          connectionType: "Direct",
        });
      }
    }
    else if (type === "download-complete") {
      this.onLogMessage(`File [${this.files[fileIndex].name}] downloaded successfully by receiver.`);
      transfer.fileIndex = fileIndex + 1;
      transfer.chunkIndex = 0;
      transfer.bytesSent = 0;
      transfer.isTransferring = false;
      this.sendNextFileHeader(rxPeerId);
    }
  }

  public handleRelayControlMessage(rxPeerId: string, message: any) {
    const { type, fileIndex, chunkIndex, resumeChunkIndex } = message;
    const transfer = this.activeTransfers.get(rxPeerId);
    if (!transfer) return;

    if (type === "ready") {
      const startFrom = resumeChunkIndex ? Number(resumeChunkIndex) : 0;
      transfer.chunkIndex = startFrom;
      transfer.bytesSent = startFrom * CHUNK_SIZE;
      transfer.startTime = Date.now();
      transfer.isTransferring = true;
      
      this.onLogMessage(`[Relay] Starting streaming [${this.files[fileIndex].name}] from chunk ${startFrom}`);
      this.streamFileChunks(rxPeerId);
    }
    else if (type === "ack") {
      transfer.isWaitingForAck = false;

      const file = this.files[fileIndex];
      const bytesAcked = Math.min(file.size, (chunkIndex + 1) * CHUNK_SIZE);
      const percent = Math.round((bytesAcked / file.size) * 100);
      const now = Date.now();
      const lastUpdate = this.lastProgressUpdates.get(rxPeerId) || 0;

      if (now - lastUpdate > 150 || percent === 100) {
        this.lastProgressUpdates.set(rxPeerId, now);
        const { speed, eta } = calculateSpeedAndETA(bytesAcked, file.size, transfer.startTime);

        this.onProgressUpdate(rxPeerId, {
          fileIndex,
          fileName: file.name,
          fileSize: file.size,
          bytesSentOrReceived: bytesAcked,
          percent,
          speed,
          eta,
          status: "transferring",
          connectionType: "Relayed",
        });
      }
    }
    else if (type === "download-complete") {
      this.onLogMessage(`[Relay] File [${this.files[fileIndex].name}] completed successfully.`);
      transfer.fileIndex = fileIndex + 1;
      transfer.chunkIndex = 0;
      transfer.bytesSent = 0;
      transfer.isTransferring = false;
      this.sendNextFileHeader(rxPeerId);
    }
  }

  private async streamFileChunks(rxPeerId: string) {
    const transfer = this.activeTransfers.get(rxPeerId);
    if (!transfer || !transfer.isTransferring) return;

    const channel = this.channels.get(rxPeerId);
    if (!transfer.isRelaying && (!channel || channel.readyState !== "open")) return;

    const file = this.files[transfer.fileIndex];
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    if (!transfer.isRelaying && channel) {
      channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER_MARK;
    }

    while (transfer.chunkIndex < totalChunks && transfer.isTransferring) {
      if (!transfer.isRelaying && channel && channel.readyState !== "open") {
        this.onLogMessage(`Channel closed, aborting stream for [${rxPeerId}]`);
        break;
      }

      // Check overflow limit for direct P2P.
      //
      // The listener is registered before the threshold is re-checked: if the
      // buffer drained in between, "bufferedamountlow" has already fired and
      // waiting for it would hang the transfer permanently.
      if (!transfer.isRelaying && channel && channel.bufferedAmount > BUFFER_HIGH_WATER_MARK) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            channel.removeEventListener("bufferedamountlow", onLow);
            clearInterval(poll);
            resolve();
          };
          const onLow = () => finish();
          channel.addEventListener("bufferedamountlow", onLow);

          // Safety net: covers both the drain race and a channel that closes
          // while we are waiting.
          const poll = setInterval(() => {
            if (
              channel.readyState !== "open" ||
              channel.bufferedAmount <= channel.bufferedAmountLowThreshold
            ) {
              finish();
            }
          }, 50);

          if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) finish();
        });
      }

      const start = transfer.chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const sliced = file.slice(start, end);
      const buffer = await sliced.arrayBuffer();

      let finalBuffer = buffer;
      if (this.cryptoKey) {
        finalBuffer = await encryptChunk(this.cryptoKey, buffer);
      }

      if (transfer.isRelaying) {
        // High performance: send binary buffer framing instead of Base64 JSON strings
        const binaryFrame = encodeBinaryChunk(
          rxPeerId,
          this.peerId,
          transfer.fileIndex,
          transfer.chunkIndex,
          finalBuffer
        );

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(binaryFrame);
        }

        // Pacing flow control: wait for receiver ACK
        transfer.isWaitingForAck = true;
        while (transfer.isWaitingForAck && transfer.isTransferring) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } else if (channel) {
        channel.send(finalBuffer);
      }

      transfer.chunkIndex++;
      transfer.bytesSent += buffer.byteLength;
    }

    if (transfer.chunkIndex >= totalChunks && transfer.isTransferring) {
      this.onLogMessage(`Sent all chunks for: ${file.name}. Finalizing...`);
      if (transfer.isRelaying) {
        this.sendRelayMessage(rxPeerId, { type: "file-end", fileIndex: transfer.fileIndex });
      } else if (channel) {
        channel.send(JSON.stringify({ type: "file-end", fileIndex: transfer.fileIndex }));
      }
    }
  }

  private cleanupPeer(peerId: string) {
    const pc = this.peers.get(peerId);
    const ch = this.channels.get(peerId);
    const timer = this.negotiationTimers.get(peerId);
    if (timer) clearTimeout(timer);
    ch?.close();
    pc?.close();
    this.peers.delete(peerId);
    this.channels.delete(peerId);
    this.activeTransfers.delete(peerId);
    this.negotiationTimers.delete(peerId);
    this.lastProgressUpdates.delete(peerId);
  }
}

export interface P2PReceiverOptions {
  roomId?: string;
  senderPeerId?: string;
  encryptionKeyHex?: string;
  ws?: WebSocket | null;
  peerId?: string;
  /** Token from /verify-password or /access; required to join a locker room. */
  accessToken?: string;
  /** Pre-agreed key for Direct Beam, where there is no link key to import. */
  sharedKey?: CryptoKey | null;
}

export class P2PReceiver {
  private roomId: string;
  private targetSenderPeerId: string;
  private peerId: string;
  private encryptionKeyHex: string;
  private cryptoKey: CryptoKey | null = null;
  private ws: WebSocket | null;
  private isExternalWs = false;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private startTime = 0;
  private bytesCompleted = 0;
  private lastProgressUpdate = 0;

  private senderPeerId: string | null = null;
  private isRelaying = false;
  private accessToken = "";

  private currentFile: {
    index: number;
    name: string;
    size: number;
    totalChunks: number;
    receivedChunks: number;
  } | null = null;

  /** Chunk indexes already persisted for the current file, for dedupe. */
  private receivedChunkIndexes = new Set<number>();

  /** Service Worker stream downloads still reading from IndexedDB. */
  private pendingStreamDownloads = 0;
  private swMessageHandler: ((event: MessageEvent) => void) | null = null;

  public onStatusChange: (status: TransferState) => void = () => {};
  public onProgress: (progress: TransferProgress) => void = () => {};
  public onLogMessage: (msg: string) => void = () => {};
  public onFilesCompiled: (files: { name: string; url: string; size: number }[]) => void = () => {};

  private compiledFilesList: { name: string; url: string; size: number }[] = [];

  constructor(options: P2PReceiverOptions) {
    this.roomId = options.roomId || "";
    this.targetSenderPeerId = options.senderPeerId || "";
    this.peerId = options.peerId || "receiver_" + generateClientId();
    this.encryptionKeyHex = options.encryptionKeyHex || "";
    this.ws = options.ws || null;
    this.isExternalWs = !!options.ws;
    this.accessToken = options.accessToken || "";
    this.cryptoKey = options.sharedKey || null;
  }

  public async start() {
    try {
      if (this.encryptionKeyHex) {
        this.onLogMessage("Unlocking E2E decryption keys...");
        this.cryptoKey = await importKeyFromHex(this.encryptionKeyHex);
        this.onLogMessage("Keys decrypted successfully.");
      }

      if (this.isExternalWs && this.ws) {
        this.onLogMessage("Reusing existing signaling channel...");
        if (this.targetSenderPeerId) {
          this.senderPeerId = this.targetSenderPeerId;
        }
        return;
      }

      const params = new URLSearchParams({
        roomId: this.roomId,
        peerId: this.peerId,
        role: "receiver"
      });
      if (this.accessToken) params.set("token", this.accessToken);
      const wsUrl = `${await getWebSocketURL()}?${params.toString()}`;
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        this.onLogMessage("Synchronized with secure gateway. Requesting WebRTC connection...");
      };

      this.ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          await this.handleBinaryMessage(event.data);
        } else {
          try {
            const message = JSON.parse(event.data);
            await this.handleSignalingMessage(message);
          } catch (err) {
            console.error("Receiver signaling parse error:", err);
          }
        }
      };

      this.ws.onclose = () => {
        this.onLogMessage("Signaling network tunnel detached.");
      };
    } catch (err: any) {
      this.onLogMessage(`Failed to launch receiver: ${err.message}`);
      this.onStatusChange("failed");
    }
  }

  public async handleSignalingMessage(message: any) {
    const { type, senderPeerId, payload } = message;

    if (senderPeerId) {
      this.senderPeerId = senderPeerId;
    }

    if (type === "error") {
      this.onLogMessage(`Gateway error: ${payload || message.message}`);
      this.onStatusChange("failed");
      if (!this.isExternalWs) {
        this.ws?.close();
      }
      return;
    }

    if (type === "offer" || type === "direct-offer") {
      this.onLogMessage("Negotiating local P2P context...");
      await this.setupRTCPeerConnection(payload);
    } else if (type === "ice-candidate" || type === "direct-ice-candidate") {
      if (this.pc && payload) {
        await this.pc.addIceCandidate(new RTCIceCandidate(payload)).catch(() => {});
      }
    } else if (type === "sender-disconnected") {
      this.onLogMessage("The sender went offline. Pausing/Disconnecting transfer flow.");
      this.onStatusChange("interrupted");
    } else if (type === "relay-msg" && payload) {
      await this.handleRelayedControlMessage(payload);
    }
  }

  public async handleBinaryMessage(data: ArrayBuffer) {
    try {
      const decoded = decodeBinaryChunk(data);
      if (decoded.senderPeerId) {
        this.senderPeerId = decoded.senderPeerId;
      }
      // Relayed chunks carry their own file/chunk index, so honour it rather
      // than assuming arrival order.
      await this.handleBinaryChunk(decoded.chunkData, decoded.fileIndex, decoded.chunkIndex);
    } catch (err) {
      console.error("Binary client message parsing failed:", err);
    }
  }

  public stop() {
    if (!this.isExternalWs) {
      this.ws?.close();
    }
    this.channel?.close();
    this.pc?.close();
    this.onStatusChange("idle");
  }

  private sendRelayMessage(payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.senderPeerId) {
      this.ws.send(JSON.stringify({
        type: "relay-msg",
        targetPeerId: this.senderPeerId,
        payload
      }));
    }
  }

  private async setupRTCPeerConnection(offer: any) {
    const pc = new RTCPeerConnection(getIceConfig());
    this.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate && this.senderPeerId) {
        this.ws?.send(JSON.stringify({
          type: this.targetSenderPeerId ? "direct-ice-candidate" : "ice-candidate",
          targetPeerId: this.senderPeerId,
          payload: e.candidate,
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      this.onLogMessage(`P2P Network Link: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        this.onStatusChange("connecting");
      } else if (pc.connectionState === "failed") {
        this.onLogMessage("P2P connection failed. Awaiting WebSocket relay fallback...");
      } else if (pc.connectionState === "disconnected") {
        this.onLogMessage("P2P communication disconnected.");
      }
    };

    pc.ondatachannel = (e) => {
      this.onLogMessage("Receiving direct Webrtc binary streams.");
      this.channel = e.channel;
      this.channel.binaryType = "arraybuffer";

      this.channel.onopen = () => {
        this.onStatusChange("transferring");
        this.onLogMessage("E2E P2P channel established. Decrypting streaming packet chunks.");
      };

      this.channel.onmessage = async (msgEvent) => {
        if (typeof msgEvent.data === "string") {
          try {
            const control = JSON.parse(msgEvent.data);
            await this.handleControlMessage(control);
          } catch (err) {
            console.error("Control parsing crash:", err);
          }
        } else {
          await this.handleBinaryChunk(msgEvent.data);
        }
      };
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.senderPeerId) {
      this.ws.send(JSON.stringify({
        type: this.targetSenderPeerId ? "direct-answer" : "answer",
        targetPeerId: this.senderPeerId,
        payload: pc.localDescription,
      }));
    }
  }

  private async handleControlMessage(control: any) {
    const { type, fileIndex, fileName, fileSize, totalChunks } = control;

    if (type === "header") {
      this.onLogMessage(`Retrieving File Header: ${fileName} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
      this.currentFile = {
        index: fileIndex,
        name: fileName,
        size: fileSize,
        totalChunks,
        receivedChunks: 0,
      };
      this.receivedChunkIndexes.clear();

      this.startTime = Date.now();
      this.bytesCompleted = 0;

      this.channel?.send(JSON.stringify({
        type: "ready",
        fileIndex,
        resumeChunkIndex: 0,
      }));
    } 
    else if (type === "file-end") {
      await this.compileFile();
    }
    else if (type === "all-complete") {
      await this.finalizeTransfer("");
    }
  }

  private async handleRelayedControlMessage(message: any) {
    const { type, fileIndex, fileName, fileSize, totalChunks } = message;

    if (type === "header") {
      this.isRelaying = true;
      this.onStatusChange("transferring");
      this.onLogMessage(`[Relay] Retrieving File Header: ${fileName} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
      this.currentFile = {
        index: fileIndex,
        name: fileName,
        size: fileSize,
        totalChunks,
        receivedChunks: 0,
      };
      this.receivedChunkIndexes.clear();

      this.startTime = Date.now();
      this.bytesCompleted = 0;

      this.sendRelayMessage({
        type: "ready",
        fileIndex,
        resumeChunkIndex: 0,
      });
    } 
    else if (type === "file-end") {
      await this.compileFile();
    }
    else if (type === "all-complete") {
      await this.finalizeTransfer("[Relay] ");
    }
  }

  private async compileFile() {
    if (!this.currentFile) return;
    const dbName = this.roomId || "direct_beam";
    this.onLogMessage(`Received all packets for [${this.currentFile.name}]. Assembling...`);
    
    try {
      const isSwActive = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (isSwActive) {
        // High performance: redirect to Service Worker stream.
        // Bypasses browser JS heap memory block entirely.
        this.onLogMessage(`[Stream] Initiating memory-safe streaming compile...`);
        // The Service Worker reports back when it has finished reading this
        // stream, so cached chunks are not deleted out from under it.
        this.ensureStreamCompletionListener();
        this.pendingStreamDownloads++;
        const streamUrl = `/api/download-stream?roomId=${dbName}&fileIndex=${this.currentFile.index}&totalChunks=${this.currentFile.totalChunks}&name=${encodeURIComponent(this.currentFile.name)}&size=${this.currentFile.size}`;

        const anchor = document.createElement("a");
        anchor.href = streamUrl;
        anchor.download = this.currentFile.name;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        
        this.compiledFilesList.push({
          name: this.currentFile.name,
          url: streamUrl,
          size: this.currentFile.size,
        });
        this.onFilesCompiled([...this.compiledFilesList]);
      } else {
        // Fallback: standard memory compilation
        this.onLogMessage(`Service Worker unavailable, falling back to memory compilation...`);
        const fileSlices = await compileFilesFromDB(dbName, this.currentFile.index, this.currentFile.totalChunks);
        const compiledBlob = new Blob(fileSlices);
        const compiledUrl = URL.createObjectURL(compiledBlob);

        this.compiledFilesList.push({
          name: this.currentFile.name,
          url: compiledUrl,
          size: this.currentFile.size,
        });

        this.onFilesCompiled([...this.compiledFilesList]);

        const anchor = document.createElement("a");
        anchor.href = compiledUrl;
        anchor.download = this.currentFile.name;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      }

      this.onLogMessage(`File [${this.currentFile.name}] downloaded successfully.`);

      // Report back to sender
      if (this.isRelaying) {
        this.sendRelayMessage({
          type: "download-complete",
          fileIndex: this.currentFile.index,
        });
      } else {
        this.channel?.send(JSON.stringify({
          type: "download-complete",
          fileIndex: this.currentFile.index,
        }));
      }

      // The locker's download counter is bumped once, from "all-complete".
      // Reporting per file here made a multi-file locker exhaust its own
      // download quota before the second file was sent.

    } catch (err: any) {
      this.onLogMessage(`Compilation failure on merged file: ${err.message}`);
      this.onStatusChange("failed");
    }
  }

  /** Subscribes once to Service Worker stream completion notifications. */
  private ensureStreamCompletionListener() {
    if (this.swMessageHandler || typeof navigator === "undefined" || !navigator.serviceWorker) {
      return;
    }
    this.swMessageHandler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== "download-stream-settled") return;
      if (this.pendingStreamDownloads > 0) this.pendingStreamDownloads--;
    };
    navigator.serviceWorker.addEventListener("message", this.swMessageHandler);
  }

  private removeStreamCompletionListener() {
    if (!this.swMessageHandler || typeof navigator === "undefined" || !navigator.serviceWorker) {
      return;
    }
    navigator.serviceWorker.removeEventListener("message", this.swMessageHandler);
    this.swMessageHandler = null;
  }

  /**
   * Called once the sender confirms every file has been delivered.
   *
   * Cached chunks are only purged after the browser has finished reading them:
   * the Service Worker download streams lazily out of IndexedDB, so clearing
   * the store immediately used to race the stream and break large files.
   */
  private async finalizeTransfer(logPrefix: string) {
    this.onLogMessage(`${logPrefix}Locker download accomplished entirely!`);
    this.onStatusChange("complete");

    // Tell the server this receiver finished the whole locker.
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.roomId) {
      this.ws.send(JSON.stringify({ type: "download-complete" }));
    }

    const dbName = this.roomId || "direct_beam";
    if (this.pendingStreamDownloads === 0) {
      clearRoomFromDB(dbName).catch((err) => console.error("Database purge failure:", err));
    } else {
      this.onLogMessage("Waiting for streamed downloads to finish before clearing the cache...");
      this.purgeWhenStreamsSettle(dbName);
    }
  }

  /**
   * Waits for in-flight Service Worker stream downloads to drain before
   * clearing cached chunks, with a ceiling so the cache is never leaked.
   */
  private purgeWhenStreamsSettle(dbName: string) {
    const startedAt = Date.now();
    const maxWaitMs = 10 * 60 * 1000;

    const poll = setInterval(() => {
      const settled = this.pendingStreamDownloads === 0;
      const timedOut = Date.now() - startedAt > maxWaitMs;
      if (!settled && !timedOut) return;

      clearInterval(poll);
      if (timedOut) {
        this.onLogMessage("Stream download wait timed out; clearing cached chunks.");
      }
      clearRoomFromDB(dbName)
        .catch((err) => console.error("Database purge failure:", err))
        .finally(() => this.removeStreamCompletionListener());
    }, 1000);
  }

  private async handleBinaryChunk(data: ArrayBuffer, fileIndex?: number, chunkIndex?: number) {
    if (!this.currentFile) return;

    // A relayed frame states which file it belongs to; ignore anything that is
    // not for the transfer currently in progress.
    if (fileIndex !== undefined && fileIndex !== this.currentFile.index) return;

    try {
      let finalBuffer = data;
      if (this.cryptoKey) {
        finalBuffer = await decryptChunk(this.cryptoKey, data);
      }

      // Prefer the index from the wire; fall back to arrival order for the
      // ordered WebRTC data channel, which carries no framing of its own.
      const currentIdx = chunkIndex !== undefined ? chunkIndex : this.currentFile.receivedChunks;
      if (currentIdx < 0 || currentIdx >= this.currentFile.totalChunks) return;
      if (this.receivedChunkIndexes.has(currentIdx)) return; // duplicate frame

      await saveChunkToDB(this.roomId || "direct_beam", this.currentFile.index, currentIdx, finalBuffer);

      this.receivedChunkIndexes.add(currentIdx);
      this.currentFile.receivedChunks = this.receivedChunkIndexes.size;
      this.bytesCompleted += finalBuffer.byteLength;

      if (this.isRelaying) {
        // Send ACK for every chunk in relay mode to unblock sender pacing loop
        this.sendRelayMessage({
          type: "ack",
          fileIndex: this.currentFile.index,
          chunkIndex: currentIdx,
        });
      } else if (currentIdx % 4 === 0 || this.currentFile.receivedChunks === this.currentFile.totalChunks) {
        this.channel?.send(JSON.stringify({
          type: "ack",
          fileIndex: this.currentFile.index,
          chunkIndex: currentIdx,
        }));
      }

      // Progress maths
      const percent = Math.round((this.currentFile.receivedChunks / this.currentFile.totalChunks) * 100);
      const now = Date.now();
      if (now - this.lastProgressUpdate > 150 || percent === 100) {
        this.lastProgressUpdate = now;
        const { speed, eta } = calculateSpeedAndETA(this.bytesCompleted, this.currentFile.size, this.startTime);

        this.onProgress({
          fileIndex: this.currentFile.index,
          fileName: this.currentFile.name,
          fileSize: this.currentFile.size,
          bytesSentOrReceived: this.bytesCompleted,
          percent,
          speed,
          eta,
          status: "transferring",
          connectionType: this.isRelaying ? "Relayed" : "Direct",
        });
      }

    } catch (err: any) {
      this.onLogMessage(`Payload processing crashed: ${err.message}`);
      this.onStatusChange("failed");
      this.stop();
    }
  }
}
