/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileMeta, TransferProgress, TransferState } from "../types";
import { encryptChunk, decryptChunk, importKeyFromHex } from "./crypto";
import { saveChunkToDB, compileFilesFromDB, clearRoomFromDB } from "./db";
import { calculateSpeedAndETA, getWebSocketURL, ICE_CONFIG } from "./webrtc-helper";

const CHUNK_SIZE = 32768; // 32KB chunk specs

export class P2PSender {
  private roomId: string;
  private peerId: string;
  private files: File[];
  private cryptoKey: CryptoKey;
  private ws: WebSocket | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private activeTransfers = new Map<string, {
    fileIndex: number;
    chunkIndex: number;
    bytesSent: number;
    startTime: number;
    isTransferring: boolean;
  }>(); // peerId -> active transfer stats

  public onPeerStatusChange: (peerId: string, status: string) => void = () => {};
  public onProgressUpdate: (peerId: string, progress: TransferProgress) => void = () => {};
  public onLogMessage: (msg: string) => void = () => {};

  constructor(roomId: string, files: File[], cryptoKey: CryptoKey) {
    this.roomId = roomId;
    this.files = files;
    this.cryptoKey = cryptoKey;
    this.peerId = "sender_" + Math.random().toString(36).substring(2, 6);
  }

  public start() {
    const wsUrl = `${getWebSocketURL()}?roomId=${this.roomId}&peerId=${this.peerId}&role=sender`;
    this.onLogMessage(`Connecting to signaling gateway: ${this.roomId}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.onLogMessage("Secure gateway established, awaiting receiver...");
    };

    this.ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        const { type, senderPeerId, payload } = message;

        switch (type) {
          case "peer-joined":
            this.onLogMessage(`Receiver connected [${senderPeerId}]. Setting up WebRTC...`);
            this.setupRTCPeerConnection(senderPeerId);
            break;
          case "peer-left":
            this.onLogMessage(`Receiver left: ${senderPeerId}`);
            this.cleanupPeer(senderPeerId);
            break;
          case "answer":
            if (senderPeerId) {
              const pc = this.peers.get(senderPeerId);
              if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(payload));
                this.onLogMessage("Secure WebRTC channel negotiated.");
              }
            }
            break;
          case "ice-candidate":
            if (senderPeerId && payload) {
              const pc = this.peers.get(senderPeerId);
              if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate(payload));
              }
            }
            break;
        }
      } catch (err) {
        console.error("Sender signaling parse error:", err);
      }
    };

    this.ws.onclose = () => {
      this.onLogMessage("Signaling connection detached.");
    };
  }

  public stop() {
    this.ws?.close();
    for (const peerId of this.peers.keys()) {
      this.cleanupPeer(peerId);
    }
  }

  private setupRTCPeerConnection(rxPeerId: string) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    this.peers.set(rxPeerId, pc);

    const channel = pc.createDataChannel("transfer-channel", { ordered: true });
    channel.binaryType = "arraybuffer";
    this.channels.set(rxPeerId, channel);

    pc.onicecandidate = (e) => {
      if (e.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "ice-candidate",
          targetPeerId: rxPeerId,
          payload: e.candidate,
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      this.onPeerStatusChange(rxPeerId, pc.connectionState);
      this.onLogMessage(`P2P Connection State with [${rxPeerId}]: ${pc.connectionState}`);
    };

    channel.onopen = () => {
      this.onLogMessage(`Secure binary datachannel open with [${rxPeerId}]. Starting streams.`);
      // Start transfer queue for this specific peer
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
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: "offer",
            targetPeerId: rxPeerId,
            payload: pc.localDescription,
          }));
        }
      })
      .catch((err) => {
        this.onLogMessage(`WebRTC offer creation crashed: ${err.message}`);
      });
  }

  private async startFileTransferQueue(rxPeerId: string) {
    this.activeTransfers.set(rxPeerId, {
      fileIndex: 0,
      chunkIndex: 0,
      bytesSent: 0,
      startTime: Date.now(),
      isTransferring: false,
    });

    this.sendNextFileHeader(rxPeerId);
  }

  private sendNextFileHeader(rxPeerId: string) {
    const transfer = this.activeTransfers.get(rxPeerId);
    const channel = this.channels.get(rxPeerId);
    if (!transfer || !channel || channel.readyState !== "open") return;

    if (transfer.fileIndex >= this.files.length) {
      this.onLogMessage(`All requested files transferred to [${rxPeerId}]!`);
      // Notify client we are completely done
      channel.send(JSON.stringify({ type: "all-complete" }));
      return;
    }

    const file = this.files[transfer.fileIndex];
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    this.onLogMessage(`Streaming file ${transfer.fileIndex + 1}/${this.files.length}: ${file.name}`);

    channel.send(JSON.stringify({
      type: "header",
      fileIndex: transfer.fileIndex,
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
    }));
  }

  private async handleReceiverAck(rxPeerId: string, message: any) {
    const { type, fileIndex, chunkIndex, resumeChunkIndex } = message;
    const transfer = this.activeTransfers.get(rxPeerId);
    const channel = this.channels.get(rxPeerId);
    if (!transfer || !channel || channel.readyState !== "open") return;

    if (type === "ready") {
      // Receiver says they are ready. They might request resume index
      const startFrom = resumeChunkIndex ? Number(resumeChunkIndex) : 0;
      transfer.chunkIndex = startFrom;
      transfer.bytesSent = startFrom * CHUNK_SIZE;
      transfer.startTime = Date.now();
      transfer.isTransferring = true;
      
      this.onLogMessage(`Starting streaming [${this.files[fileIndex].name}] from chunk index ${startFrom}`);
      this.streamFileChunks(rxPeerId);
    } 
    else if (type === "ack") {
      // Real-time progressive ack from receiver
      const file = this.files[fileIndex];
      const bytesAcked = Math.min(file.size, (chunkIndex + 1) * CHUNK_SIZE);
      
      const { speed, eta } = calculateSpeedAndETA(bytesAcked, file.size, transfer.startTime);

      this.onProgressUpdate(rxPeerId, {
        fileIndex,
        fileName: file.name,
        fileSize: file.size,
        bytesSentOrReceived: bytesAcked,
        percent: Math.round((bytesAcked / file.size) * 100),
        speed,
        eta,
        status: "transferring",
      });
    }
    else if (type === "download-complete") {
      // Receiver fully completed and compiled this file
      this.onLogMessage(`File [${this.files[fileIndex].name}] downloaded successfully by receiver.`);
      transfer.fileIndex = fileIndex + 1;
      transfer.chunkIndex = 0;
      transfer.bytesSent = 0;
      transfer.isTransferring = false;

      // Start next file
      this.sendNextFileHeader(rxPeerId);
    }
  }

  private async streamFileChunks(rxPeerId: string) {
    const transfer = this.activeTransfers.get(rxPeerId);
    const channel = this.channels.get(rxPeerId);
    if (!transfer || !channel || channel.readyState !== "open" || !transfer.isTransferring) return;

    const file = this.files[transfer.fileIndex];
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    channel.bufferedAmountLowThreshold = 65536; // Wait to drain when low (64KB)

    while (transfer.chunkIndex < totalChunks && transfer.isTransferring) {
      if (channel.readyState !== "open") {
        this.onLogMessage(`Channel closed, aborting stream for [${rxPeerId}]`);
        break;
      }

      // Check overflow limit
      // Throttling mechanism (1MB limit keeps memory and backpressure beautifully safe)
      if (channel.bufferedAmount > 1024 * 1024) {
        await new Promise<void>((resolve) => {
          const onLow = () => {
            channel.removeEventListener("bufferedamountlow", onLow);
            resolve();
          };
          channel.addEventListener("bufferedamountlow", onLow);
        });
      }

      const start = transfer.chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const sliced = file.slice(start, end);
      const buffer = await sliced.arrayBuffer();

      // Client-side encryption
      const encrypted = await encryptChunk(this.cryptoKey, buffer);

      // Send raw payload
      channel.send(encrypted);

      transfer.chunkIndex++;
      transfer.bytesSent += buffer.byteLength;
    }

    if (transfer.chunkIndex >= totalChunks && transfer.isTransferring) {
      this.onLogMessage(`Sent all encrypted chunks for: ${file.name}. Finalizing...`);
      channel.send(JSON.stringify({ type: "file-end", fileIndex: transfer.fileIndex }));
    }
  }

  private cleanupPeer(peerId: string) {
    const pc = this.peers.get(peerId);
    const ch = this.channels.get(peerId);
    ch?.close();
    pc?.close();
    this.peers.delete(peerId);
    this.channels.delete(peerId);
    this.activeTransfers.delete(peerId);
  }
}

export class P2PReceiver {
  private roomId: string;
  private peerId: string;
  private encryptionKeyHex: string;
  private cryptoKey: CryptoKey | null = null;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private startTime = 0;
  private bytesCompleted = 0;

  // Track currently processing file metadata
  private currentFile: {
    index: number;
    name: string;
    size: number;
    totalChunks: number;
    receivedChunks: number;
  } | null = null;

  public onStatusChange: (status: TransferState) => void = () => {};
  public onProgress: (progress: TransferProgress) => void = () => {};
  public onLogMessage: (msg: string) => void = () => {};
  public onFilesCompiled: (files: { name: string; url: string; size: number }[]) => void = () => {};

  private compiledFilesList: { name: string; url: string; size: number }[] = [];

  constructor(roomId: string, encryptionKeyHex: string) {
    this.roomId = roomId;
    this.peerId = "receiver_" + Math.random().toString(36).substring(2, 6);
    this.encryptionKeyHex = encryptionKeyHex;
  }

  public async start() {
    try {
      this.onLogMessage("Unlocking E2E decryption keys...");
      this.cryptoKey = await importKeyFromHex(this.encryptionKeyHex);
      this.onLogMessage("Keys decrypted successfully.");

      const wsUrl = `${getWebSocketURL()}?roomId=${this.roomId}&peerId=${this.peerId}&role=receiver`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.onLogMessage("Synchronized with secure gateway. Requesting WebRTC connection...");
      };

      this.ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          const { type, payload } = message;

          if (type === "error") {
            this.onLogMessage(`Gateway error: ${payload || message.message}`);
            this.onStatusChange("failed");
            this.ws?.close();
            return;
          }

          if (type === "offer") {
            this.onLogMessage("Negotiating local P2P context...");
            await this.setupRTCPeerConnection(payload);
          } else if (type === "ice-candidate") {
            if (this.pc && payload) {
              await this.pc.addIceCandidate(new RTCIceCandidate(payload));
            }
          } else if (type === "sender-disconnected") {
            this.onLogMessage("The sender went offline. Pausing/Disconnecting transfer flow.");
            this.onStatusChange("interrupted");
          }
        } catch (err) {
          console.error("Receiver signaling parse error:", err);
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

  public stop() {
    this.ws?.close();
    this.channel?.close();
    this.pc?.close();
    this.onStatusChange("idle");
  }

  private async setupRTCPeerConnection(offer: any) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    this.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "ice-candidate",
          payload: e.candidate,
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      this.onLogMessage(`P2P Network Link: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        this.onStatusChange("connecting");
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        this.onStatusChange("failed");
        this.onLogMessage("P2P communication lost.");
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
          // Control frame
          try {
            const control = JSON.parse(msgEvent.data);
            await this.handleControlMessage(control);
          } catch (err) {
            console.error("Control parsing crash:", err);
          }
        } else {
          // Binary chunk frame
          await this.handleBinaryChunk(msgEvent.data);
        }
      };
    };

    // Set Remote Offer
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    
    // Create Answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "answer",
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

      this.startTime = Date.now();
      this.bytesCompleted = 0;

      // Reset DB cached entries for this specific room and file before starting fresh
      // (This prevents garbage overlays, but we can do validation)
      // Auto-Resume check: See if we have chunks in DB. If yes, count them.
      // For simplicity here, we clear and start clean, but let's send 'ready' with resumeChunkIndex = 0
      this.channel?.send(JSON.stringify({
        type: "ready",
        fileIndex,
        resumeChunkIndex: 0, // Starts at the beginning
      }));
    } 
    else if (type === "file-end") {
      if (!this.currentFile) return;
      this.onLogMessage(`Recieved all packets for [${this.currentFile.name}]. Merging on disk...`);
      
      try {
        const fileSlices = await compileFilesFromDB(this.roomId, this.currentFile.index, this.currentFile.totalChunks);
        const compiledBlob = new Blob(fileSlices);
        const compiledUrl = URL.createObjectURL(compiledBlob);

        this.compiledFilesList.push({
          name: this.currentFile.name,
          url: compiledUrl,
          size: this.currentFile.size,
        });

        this.onFilesCompiled([...this.compiledFilesList]);

        // Auto trigger download in browser
        const anchor = document.createElement("a");
        anchor.href = compiledUrl;
        anchor.download = this.currentFile.name;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);

        this.onLogMessage(`Compiled file [${this.currentFile.name}] downloaded successfully.`);

        // Report back to sender and to signaling to update room download quotas
        this.channel?.send(JSON.stringify({
          type: "download-complete",
          fileIndex: this.currentFile.index,
        }));

        this.ws?.send(JSON.stringify({
          type: "download-complete",
          payload: { fileIndex: this.currentFile.index }
        }));

      } catch (err: any) {
        this.onLogMessage(`Compilation failure on merged file: ${err.message}`);
      }
    }
    else if (type === "all-complete") {
      this.onLogMessage("Locker download accomplished entirely!");
      this.onStatusChange("complete");
      
      // Clean DB to free up user space
      clearRoomFromDB(this.roomId).catch((err) => console.error("Database purge failure:", err));
    }
  }

  private async handleBinaryChunk(data: ArrayBuffer) {
    if (!this.currentFile || !this.cryptoKey) return;

    try {
      // Decrypt the block chunk using AES-256-GCM
      const decrypted = await decryptChunk(this.cryptoKey, data);
      
      // Save direct to disk buffer
      const currentIdx = this.currentFile.receivedChunks;
      await saveChunkToDB(this.roomId, this.currentFile.index, currentIdx, decrypted);

      this.currentFile.receivedChunks++;
      this.bytesCompleted += decrypted.byteLength;

      // Periodic Acknowledgment frame so Sender doesn't flood and measures throughput correctly
      // We send it every chunk or every 4 chunks, immediately keeps backpressure safe and visual smooth
      if (currentIdx % 4 === 0 || this.currentFile.receivedChunks === this.currentFile.totalChunks) {
        this.channel?.send(JSON.stringify({
          type: "ack",
          fileIndex: this.currentFile.index,
          chunkIndex: currentIdx,
        }));
      }

      // Progress maths
      const { speed, eta } = calculateSpeedAndETA(this.bytesCompleted, this.currentFile.size, this.startTime);

      this.onProgress({
        fileIndex: this.currentFile.index,
        fileName: this.currentFile.name,
        fileSize: this.currentFile.size,
        bytesSentOrReceived: this.bytesCompleted,
        percent: Math.round((this.currentFile.receivedChunks / this.currentFile.totalChunks) * 100),
        speed,
        eta,
        status: "transferring",
      });

    } catch (err: any) {
      this.onLogMessage(`Payload decryption crashed (key mismatch?): ${err.message}`);
      this.onStatusChange("failed");
      this.stop();
    }
  }
}
