/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  Wifi, 
  User, 
  Globe, 
  Smartphone,
  Network, 
  RefreshCw,
  FileText,
  X,
  Check,
  Download,
  AlertCircle,
  Copy,
  UploadCloud,
  ChevronRight,
  Send,
  Lock,
  Unlock,
  Compass,
  Cpu,
  ArrowLeft
} from "lucide-react";
import { getWebSocketURL, formatSpeed, fetchIceConfig } from "./utils/webrtc-helper";
import { generateSecretKey, exportKeyToHex } from "./utils/crypto";
import { P2PSender, P2PReceiver, decodeBinaryChunk } from "./utils/p2p-engine";
import { RoomDetails, TransferProgress } from "./types";
import QRCode from "qrcode";
import { clearAllChunksFromDB } from "./utils/db";

// Import simplified subcomponents
import CreateLocker from "./components/CreateLocker";
import LockerDashboard from "./components/LockerDashboard";
import NetworkDiscoveryHub from "./components/NetworkDiscoveryHub";
import ReceptionPanel from "./components/ReceptionPanel";

// Chunk size for direct WebSocket relay: 1MB (Gigabit optimized LAN chunking)
const CHUNK_SIZE = 1048576;

const ADJECTIVES = [
  "Forest", "Cedar", "Mossy", "Fern", "Spruce", "Timber",
  "Sage", "Hazel", "Willow", "Leafy", "Oak", "Alder",
  "Pine", "Birch", "Maple", "Clay", "Canyon", "Summit"
];

const ANIMALS = [
  "Bear", "Eagle", "Otter", "Panda", "Lynx", "Tiger",
  "Fox", "Koala", "Badger", "Owl", "Squirrel", "Falcon",
  "Deer", "Wolf", "Beaver", "Rabbit", "Heron", "Hawk"
];

interface DiscoveredPeer {
  peerId: string;
  name: string;
  ip: string;
}

interface CreatedLocker {
  roomId: string;
  expiresAt: number;
  maxDownloads: number;
  downloadCount: number;
  rawPassword?: string;
  shareUrl: string;
  logs: string[];
  activePeers: Map<string, string>;
  peerProgressList: Map<string, TransferProgress>;
}

export default function App() {
  // Check if current context is insecure (WebRTC/Crypto block)
  const isInsecureContext = 
    window.location.protocol === "http:" && 
    window.location.hostname !== "localhost" && 
    window.location.hostname !== "127.0.0.1" &&
    window.location.hostname !== "::1";

  // 1. Identity Profiling (Forest-Themed)
  const [profileName, setProfileName] = useState<string>(() => {
    let user = localStorage.getItem("filedrop_operator_user");
    if (!user) {
      const randomAdj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
      const randomAnimal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
      user = `${randomAdj} ${randomAnimal}`;
      localStorage.setItem("filedrop_operator_user", user);
    }
    return user;
  });

  const [peerId] = useState<string>(() => {
    const stored = sessionStorage.getItem("filedrop_client_peer_id");
    if (stored) return stored;
    const newId = "peer_" + Math.random().toString(36).substring(2, 8);
    sessionStorage.setItem("filedrop_client_peer_id", newId);
    return newId;
  });

  // 2. View Routing & Navigation States
  const [view, setView] = useState<"home" | "sender-dashboard" | "receiver" | "error">("home");
  const [tab, setTab] = useState<"beam" | "vault-create" | "vault-discover">("beam");

  // 3. Direct Beam States
  const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
  const [myPublicIp, setMyPublicIp] = useState<string>("Detecting public IP...");
  const [socketStatus, setSocketStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [networkIps, setNetworkIps] = useState<string[]>([]);
  const [selectedIp, setSelectedIp] = useState<string>("");

  useEffect(() => {
    const fetchNetworkIps = async () => {
      try {
        const res = await fetch("/api/network-ips");
        if (res.ok) {
          const data = await res.json();
          const rawIps: string[] = data.ips || [];
          
          // Heuristic scoring to prioritize real physical LAN interfaces (WiFi/Ethernet) over virtual ones
          const scoreIp = (ip: string): number => {
            if (ip.startsWith("127.")) return -10;
            if (ip.startsWith("192.168.56.")) return 1; // VirtualBox Host-Only
            if (ip.startsWith("172.17.") || ip.startsWith("172.18.") || ip.startsWith("172.19.")) return 1; // Common Docker bridge subnets
            
            // Standard common home/office router subnets (most likely physical interface)
            if (ip.startsWith("192.168.0.") || ip.startsWith("192.168.1.") || ip.startsWith("192.168.2.") || ip.startsWith("192.168.100.")) return 10;
            if (ip.startsWith("10.0.0.") || ip.startsWith("10.0.1.") || ip.startsWith("10.0.2.") || ip.startsWith("10.1.10.")) return 10;
            
            // Generic LAN private subnets
            if (ip.startsWith("192.168.")) return 5;
            if (ip.startsWith("10.")) return 5;
            if (ip.startsWith("172.16.") || ip.startsWith("172.2") || ip.startsWith("172.30.") || ip.startsWith("172.31.")) return 3; // WSL/Hyper-V network adapters
            return 2;
          };
          
          const sortedIps = [...rawIps].sort((a, b) => scoreIp(b) - scoreIp(a));
          setNetworkIps(sortedIps);
          if (sortedIps.length > 0) {
            setSelectedIp(sortedIps[0]);
          }
        }
      } catch (err) {
        console.error("Failed to fetch server IPs:", err);
      }
    };
    fetchNetworkIps();
    fetchIceConfig(); // Fetch dynamic STUN/TURN servers
    
    // Purge any stale IndexedDB transfer fragments from aborted sessions at startup
    clearAllChunksFromDB().catch((err) => 
      console.error("Failed to clear IndexedDB cache at startup:", err)
    );
  }, []);

  // Derived helper to resolve localhost/127.0.0.1 origins to the server's local network IPv4 address
  const resolvedOrigin = (() => {
    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    if (isLocal && selectedIp) {
      const portPart = window.location.port ? `:${window.location.port}` : "";
      return `${window.location.protocol}//${selectedIp}${portPart}`;
    }
    return window.location.origin;
  })();

  const [localQrCodeDataUrl, setLocalQrCodeDataUrl] = useState<string>("");
  const [showSslGuide, setShowSslGuide] = useState(false);

  useEffect(() => {
    if (!resolvedOrigin) return;
    QRCode.toDataURL(resolvedOrigin, { margin: 1, width: 150 })
      .then(setLocalQrCodeDataUrl)
      .catch((err) => console.error("Failed to generate portal QR code locally:", err));
  }, [resolvedOrigin]);

  // Direct Beam Sender State
  const [senderTransfer, setSenderTransfer] = useState<{
    peerId: string;
    peerName: string;
    fileName: string;
    fileSize: number;
    percent: number;
    speed: number;
    status: "idle" | "waiting-acceptance" | "transferring" | "success" | "declined" | "failed" | "canceled";
  } | null>(null);

  const senderTransferRef = useRef<typeof senderTransfer>(null);
  useEffect(() => {
    senderTransferRef.current = senderTransfer;
  }, [senderTransfer]);

  const directPcRef = useRef<RTCPeerConnection | null>(null);
  const directChannelRef = useRef<RTCDataChannel | null>(null);
  const directConnectTimeoutRef = useRef<number | null>(null);

  // Direct Beam Receiver State
  const [receiverTransfer, setReceiverTransfer] = useState<{
    peerId: string;
    peerName: string;
    fileName: string;
    fileSize: number;
    percent: number;
    status: "offered" | "transferring" | "success" | "failed";
    chunksReceived: number;
    totalChunks: number;
  } | null>(null);

  // 4. Encrypted Locker States
  const [isCreatingLocker, setIsCreatingLocker] = useState(false);
  const [createdLockerData, setCreatedLockerData] = useState<CreatedLocker | null>(null);
  
  // Active Receiver Locker States
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [activeKeyHex, setActiveKeyHex] = useState<string>("");
  const [roomDetails, setRoomDetails] = useState<RoomDetails | null>(null);
  const [isLockerVerified, setIsLockerVerified] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // 5. Active references
  const wsRef = useRef<WebSocket | null>(null);
  const activeSenderFileRef = useRef<File | null>(null);
  const p2pSenderRef = useRef<P2PSender | null>(null);
  const directSenderRef = useRef<P2PSender | null>(null);
  const directReceiverRef = useRef<P2PReceiver | null>(null);

  // ----------------------------------------------------
  // Hash Routing Listener
  // ----------------------------------------------------
  useEffect(() => {
    const handleHashChange = async () => {
      const hash = window.location.hash;
      if (hash.startsWith("#/locker/")) {
        const pathPart = hash.substring("#/locker/".length);
        const hashIdx = pathPart.indexOf("#key=");
        
        let rId = "";
        let kHex = "";
        
        if (hashIdx !== -1) {
          rId = pathPart.substring(0, hashIdx);
          kHex = pathPart.substring(hashIdx + 5);
        } else {
          rId = pathPart;
        }
        
        if (rId) {
          setActiveRoomId(rId);
          setActiveKeyHex(kHex);
          setView("receiver");
          setIsLockerVerified(false);
          
          try {
            const res = await fetch(`/api/rooms/${rId}`);
            if (res.ok) {
              const data = await res.json();
              setRoomDetails(data);
              setErrorMsg("");
            } else {
              const err = await res.json();
              setErrorMsg(err.error || "Locker has expired or does not exist.");
              setView("error");
            }
          } catch {
            setErrorMsg("Failed to connect to backend server.");
            setView("error");
          }
        }
      } else {
        setView("home");
        setActiveRoomId(null);
        setActiveKeyHex("");
        setRoomDetails(null);
        setIsLockerVerified(false);
      }
    };

    handleHashChange();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // ----------------------------------------------------
  // Direct Beam WebSocket Connection
  // ----------------------------------------------------
  const connectSignaling = async () => {
    setSocketStatus("connecting");
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
    }

    try {
      const baseWsUrl = await getWebSocketURL();
      const wsUrl = `${baseWsUrl}?peerId=${peerId}&name=${encodeURIComponent(profileName)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setSocketStatus("online");
      };

      ws.onclose = () => {
        setSocketStatus("offline");
        setTimeout(() => {
          if (window.location.hash === "" || !window.location.hash.includes("/locker/")) {
            connectSignaling();
          }
        }, 3000);
      };

      ws.onerror = () => {
        setSocketStatus("offline");
      };

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (directReceiverRef.current) {
            await directReceiverRef.current.handleBinaryMessage(event.data);
          }
          return;
        }

        try {
          const message = JSON.parse(event.data);
          const { type, senderPeerId, senderName, payload } = message;

          if (type === "direct-answer" || type === "direct-ice-candidate" || type === "relay-msg") {
            if (directSenderRef.current) {
              directSenderRef.current.handleSignalingMessage(message);
            }
          }
          if (type === "direct-offer" || type === "direct-ice-candidate" || type === "relay-msg") {
            if (directReceiverRef.current) {
              await directReceiverRef.current.handleSignalingMessage(message);
            }
          }

          switch (type) {
            case "peers-list":
              if (message.peers) {
                const filtered = message.peers.filter((p: any) => p.peerId !== peerId);
                setPeers(filtered);
              }
              if (message.yourIp) {
                setMyPublicIp(message.yourIp);
              }
              break;

            case "incoming-file-offer":
              setReceiverTransfer({
                peerId: senderPeerId,
                peerName: senderName || "Someone",
                fileName: payload.fileName,
                fileSize: payload.fileSize,
                percent: 0,
                status: "offered",
                chunksReceived: 0,
                totalChunks: payload.totalChunks
              });
              break;

            case "file-offer-response":
              if (payload.accepted) {
                const currentSenderTransfer = senderTransferRef.current;
                if (currentSenderTransfer && activeSenderFileRef.current) {
                  setupDirectSenderWebRTC(currentSenderTransfer.peerId, activeSenderFileRef.current);
                }
              } else {
                setSenderTransfer(prev => prev ? { ...prev, status: "declined" } : null);
                activeSenderFileRef.current = null;
              }
              break;

            case "transfer-canceled":
              cleanupDirectWebRTC();
              setReceiverTransfer(null);
              break;
          }
        } catch (err) {
          console.error("Signaling msg error:", err);
        }
      };
    } catch (err) {
      console.error("Failed to connect to signaling server:", err);
      setSocketStatus("offline");
    }
  };

  const sendSignal = (msg: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  };

  useEffect(() => {
    if (view === "home" && tab === "beam") {
      connectSignaling();
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      cleanupDirectWebRTC();
    };
  }, [profileName, view, tab]);

  const handleRegenName = () => {
    const randomAdj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const randomAnimal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const newName = `${randomAdj} ${randomAnimal}`;
    
    setSelectedRecipientId(null);
    setSenderTransfer(null);
    setReceiverTransfer(null);
    
    localStorage.setItem("filedrop_operator_user", newName);
    setProfileName(newName);
  };

  const handleSelectFile = (file: File) => {
    if (!selectedRecipientId) return;
    
    const count = Math.ceil(file.size / CHUNK_SIZE);
    activeSenderFileRef.current = file;
    const recipient = peers.find(p => p.peerId === selectedRecipientId);
    
    setSenderTransfer({
      peerId: selectedRecipientId,
      peerName: recipient?.name || "Device",
      fileName: file.name,
      fileSize: file.size,
      percent: 0,
      speed: 0,
      status: "waiting-acceptance"
    });

    sendSignal({
      type: "incoming-file-offer",
      targetPeerId: selectedRecipientId,
      payload: {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || "application/octet-stream",
        totalChunks: count
      }
    });
  };

  const cleanupDirectWebRTC = () => {
    if (directSenderRef.current) {
      directSenderRef.current.stop();
      directSenderRef.current = null;
    }
    if (directReceiverRef.current) {
      directReceiverRef.current.stop();
      directReceiverRef.current = null;
    }
  };

  const setupDirectSenderWebRTC = async (recipientId: string, file: File) => {
    setSenderTransfer(prev => prev ? { ...prev, status: "transferring" } : null);

    const sender = new P2PSender({
      targetPeerId: recipientId,
      files: [file],
      ws: wsRef.current,
      peerId: peerId
    });
    directSenderRef.current = sender;

    sender.onLogMessage = (msg) => {
      console.log(`[Direct Sender] ${msg}`);
    };

    sender.onPeerStatusChange = (pid, status) => {
      if (status === "failed") {
        setSenderTransfer(prev => prev ? { ...prev, status: "failed" } : null);
      }
    };

    sender.onProgressUpdate = (pid, progress) => {
      setSenderTransfer(prev => {
        if (!prev) return null;
        let finalStatus: typeof prev.status = "transferring";
        if (progress.status === "complete") finalStatus = "success";
        if (progress.status === "failed") finalStatus = "failed";
        return {
          ...prev,
          percent: progress.percent,
          speed: progress.speed,
          status: finalStatus
        };
      });
    };

    await sender.start();
  };

  const acceptIncomingOffer = () => {
    if (!receiverTransfer) return;
    setReceiverTransfer(prev => prev ? { ...prev, status: "transferring" } : null);
    
    sendSignal({
      type: "file-offer-response",
      targetPeerId: receiverTransfer.peerId,
      payload: { accepted: true }
    });

    const receiver = new P2PReceiver({
      senderPeerId: receiverTransfer.peerId,
      ws: wsRef.current,
      peerId: peerId
    });
    directReceiverRef.current = receiver;

    receiver.onStatusChange = (status) => {
      setReceiverTransfer(prev => {
        if (!prev) return null;
        let finalStatus: typeof prev.status = "transferring";
        if (status === "complete") finalStatus = "success";
        if (status === "failed") finalStatus = "failed";
        return {
          ...prev,
          status: finalStatus
        };
      });
    };

    receiver.onProgress = (progress) => {
      setReceiverTransfer(prev => {
        if (!prev) return null;
        return {
          ...prev,
          percent: progress.percent,
          chunksReceived: progress.bytesSentOrReceived
        };
      });
    };

    receiver.onLogMessage = (msg) => {
      console.log(`[Direct Receiver] ${msg}`);
    };

    receiver.start();
  };

  const declineIncomingOffer = () => {
    cleanupDirectWebRTC();
    if (receiverTransfer) {
      sendSignal({
        type: "file-offer-response",
        targetPeerId: receiverTransfer.peerId,
        payload: { accepted: false }
      });
    }
    setReceiverTransfer(null);
  };

  const cancelSenderFlow = () => {
    cleanupDirectWebRTC();
    const currentSenderTransfer = senderTransferRef.current;
    if (currentSenderTransfer) {
      sendSignal({
        type: "transfer-canceled",
        targetPeerId: currentSenderTransfer.peerId
      });
    }
    setSenderTransfer(null);
    activeSenderFileRef.current = null;
  };

  // ----------------------------------------------------
  // Encrypted Locker Actions
  // ----------------------------------------------------
  const handleLockerCreated = async ({
    files,
    maxDownloads,
    expiresInMins,
    passwordHash,
    passwordSalt,
    rawPassword,
  }: {
    files: File[];
    maxDownloads: number;
    expiresInMins: number;
    passwordHash: string | null;
    passwordSalt?: string;
    rawPassword?: string;
  }) => {
    setIsCreatingLocker(true);
    try {
      const cryptoKey = await generateSecretKey();
      const keyHex = await exportKeyToHex(cryptoKey);
      
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
          maxDownloads,
          expiresInMins,
          passwordHash,
          passwordSalt
        })
      });
      
      if (!res.ok) {
        throw new Error("Failed to register locker room on server.");
      }
      
      const roomInfo = await res.json();
      
      const sender = new P2PSender({
        roomId: roomInfo.roomId,
        files,
        cryptoKey
      });
      p2pSenderRef.current = sender;
      
      const shareUrl = `${resolvedOrigin}/#/locker/${roomInfo.roomId}#key=${keyHex}`;
      setCreatedLockerData({
        roomId: roomInfo.roomId,
        expiresAt: roomInfo.expiresAt,
        maxDownloads: roomInfo.maxDownloads,
        downloadCount: 0,
        rawPassword,
        shareUrl,
        logs: [],
        activePeers: new Map(),
        peerProgressList: new Map()
      });
      
      sender.onLogMessage = (msg) => {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setCreatedLockerData(prev => {
          if (!prev) return null;
          return { ...prev, logs: [...prev.logs, `[${timestamp}] ${msg}`] };
        });
      };
      
      sender.onPeerStatusChange = (peerId, status) => {
        setCreatedLockerData(prev => {
          if (!prev) return null;
          const nextPeers = new Map(prev.activePeers);
          nextPeers.set(peerId, status);
          return { ...prev, activePeers: nextPeers };
        });
      };
      
      sender.onProgressUpdate = (peerId, progress) => {
        setCreatedLockerData(prev => {
          if (!prev) return null;
          const nextProgress = new Map(prev.peerProgressList);
          nextProgress.set(peerId, progress);
          
          let nextDlCount = prev.downloadCount;
          if (progress.status === "complete") {
             nextDlCount = Math.min(prev.maxDownloads, prev.downloadCount + 1);
          }
          
          return { 
            ...prev, 
            peerProgressList: nextProgress,
            downloadCount: nextDlCount
          };
        });
      };
      
      sender.start();
      setView("sender-dashboard");
      
    } catch (err: any) {
      alert(err.message || "An error occurred during locker creation.");
    } finally {
      setIsCreatingLocker(false);
    }
  };

  const handleShutdownLocker = () => {
    if (p2pSenderRef.current) {
      p2pSenderRef.current.stop();
      p2pSenderRef.current = null;
    }
    setCreatedLockerData(null);
    window.location.hash = "";
    setView("home");
    setTab("vault-create");
  };

  const handleJoinRoom = (roomId: string, keyHex: string) => {
    window.location.hash = `/locker/${roomId}#key=${keyHex}`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const idx = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, idx)).toFixed(1))} ${sizes[idx]}`;
  };

  const handleCopyAppUrl = () => {
    navigator.clipboard.writeText(resolvedOrigin);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const isLocalIp = (ip: string): boolean => {
    if (!ip) return false;
    let cleanIp = ip;
    if (ip.startsWith("::ffff:")) {
      cleanIp = ip.substring(7);
    }
    if (cleanIp === "127.0.0.1" || cleanIp === "::1" || cleanIp === "localhost") {
      return true;
    }
    if (cleanIp.startsWith("10.")) return true;
    if (cleanIp.startsWith("192.168.")) return true;
    if (cleanIp.startsWith("169.254.")) return true;
    if (cleanIp.startsWith("172.")) {
      const parts = cleanIp.split(".");
      if (parts.length >= 2) {
        const secondOctet = parseInt(parts[1], 10);
        if (secondOctet >= 16 && secondOctet <= 31) return true;
      }
    }
    if (cleanIp.toLowerCase().startsWith("fe80:") || 
        cleanIp.toLowerCase().startsWith("fc00:") || 
        cleanIp.toLowerCase().startsWith("fd00:")) {
      return true;
    }
    return false;
  };

  const localPeers = peers.filter(p => p.ip === myPublicIp || (isLocalIp(p.ip) && isLocalIp(myPublicIp)));
  const globalPeers = peers.filter(p => p.ip !== myPublicIp && !(isLocalIp(p.ip) && isLocalIp(myPublicIp)));

  const qrUrl = resolvedOrigin;

  // ----------------------------------------------------
  // Main Layout Render
  // ----------------------------------------------------
  return (
    <div className="min-h-screen bg-brand-bg text-slate-800 flex flex-col font-sans antialiased relative overflow-x-hidden pb-10">
      
      {/* Insecure Context Warning Banner */}
      {isInsecureContext && (
        <div className="bg-rose-50 border-b border-rose-200 text-rose-800 text-[11.5px] font-mono px-4 py-3 relative z-50">
          <div className="max-w-4xl mx-auto space-y-2.5">
            <div className="flex items-start sm:items-center justify-between gap-3 flex-wrap sm:flex-nowrap">
              <div className="flex items-center space-x-2">
                <span className="font-bold flex-shrink-0">⚠️ SECURE CONTEXT REQUIRED:</span>
                <span>
                  WebRTC/Crypto APIs are blocked on insecure HTTP. Please reload on the secure HTTPS port:{" "}
                  <a
                    href={`https://${window.location.hostname}:${parseInt(window.location.port) + 1 || 3001}${window.location.hash}`}
                    className="underline font-bold text-rose-900 hover:text-rose-950"
                  >
                    https://{window.location.hostname}:3001
                  </a>
                </span>
              </div>
              <button
                onClick={() => setShowSslGuide(!showSslGuide)}
                className="text-[10px] font-bold uppercase tracking-wider text-rose-700 hover:text-rose-900 underline cursor-pointer shrink-0"
              >
                {showSslGuide ? "Hide SSL Bypass Guide" : "How to Bypass Certificate Warning?"}
              </button>
            </div>

            {showSslGuide && (
              <div className="bg-white/60 rounded-lg p-3 border border-rose-200/50 text-[10.5px] leading-relaxed text-slate-700 space-y-2 animate-in slide-in-from-top-1 duration-150">
                <p className="font-bold text-slate-800">
                  Because this is an offline LAN-only connection, the local HTTPS server uses a self-signed SSL certificate. Your browser will show a security warning. Follow these steps to bypass it safely:
                </p>
                <ul className="list-disc pl-4.5 space-y-1">
                  <li>
                    <strong>Chrome / Edge / Brave:</strong> Click <em>"Advanced"</em> (or <em>"Advanced settings"</em>) and choose <em>"Proceed to [IP] (unsafe)"</em>. If the proceed link is missing, type <code className="bg-rose-100 px-1 py-0.5 rounded font-bold text-rose-900">thisisunsafe</code> anywhere directly on the warning page.
                  </li>
                  <li>
                    <strong>Firefox:</strong> Click <em>"Advanced..."</em> and select <em>"Accept the Risk and Continue"</em>.
                  </li>
                  <li>
                    <strong>Safari (iOS / macOS):</strong> Click <em>"Show Details"</em> at the bottom, then click <em>"visit this website"</em>, and confirm by tapping <em>"Visit Website"</em> (requires device passcode/TouchID).
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Background ambient lighting */}
      <div className="absolute top-[-10%] left-[20%] w-[500px] h-[500px] bg-[#265c34]/3 rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[10%] w-[400px] h-[400px] bg-[#265c34]/3 rounded-full blur-[120px] pointer-events-none" />

      {/* Header */}
      <header className="relative w-full z-10 border-b border-brand-border bg-brand-bg/60 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          
          <div className="flex items-center space-x-2.5 select-none">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-[#265c34] to-[#4c905c] flex items-center justify-center text-white shadow-md">
              <Network size={16} className="animate-pulse" />
            </div>
            <div>
              <span className="text-xs font-bold tracking-wider text-slate-905 uppercase block">SendFiles P2P</span>
              <span className="text-[8.5px] font-mono text-[#265c34] tracking-widest uppercase block -mt-1 font-bold">Secure Direct P2P File Sharing</span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {view === "home" && tab === "beam" && (
              <div className="flex items-center space-x-1.5">
                <span className={`w-2 h-2 rounded-full ${
                  socketStatus === "online" ? "bg-emerald-600 live-pulse" : socketStatus === "connecting" ? "bg-amber-500 animate-pulse" : "bg-rose-600"
                }`} />
                <span className="text-[8.5px] font-mono text-slate-500 font-bold tracking-wider uppercase">
                  {socketStatus === "online" ? "Active" : socketStatus === "connecting" ? "Syncing..." : "Offline"}
                </span>
              </div>
            )}
            
            {view !== "home" && (
              <button 
                onClick={() => {
                  if (view === "sender-dashboard") {
                     handleShutdownLocker();
                  } else {
                     window.location.hash = "";
                  }
                }}
                className="flex items-center text-[10.5px] font-mono font-bold tracking-wider hover:text-[#265c34] text-[#347442] cursor-pointer transition-colors"
              >
                <ArrowLeft size={12} className="mr-1" /> Back
              </button>
            )}
          </div>

        </div>
      </header>

      {/* Main Container */}
      <main className="relative flex-1 z-10 max-w-2xl w-full mx-auto px-4 py-6">
        
        {/* VIEW A: HOME DASHBOARD */}
        {view === "home" && (
          <div className="space-y-5">
            {/* Identity card */}
            <div className="glass-panel rounded-xl p-4 flex items-center justify-between gap-3 shadow-md">
              <div className="flex items-center space-x-3 min-w-0">
                <div className="w-9 h-9 bg-[#265c34]/8 text-[#265c34] rounded-lg flex items-center justify-center shrink-0 border border-[#265c34]/15">
                  <User size={16} />
                </div>
                <div className="min-w-0">
                  <span className="text-[8.5px] font-mono text-slate-500 uppercase tracking-widest font-bold block">Your Device ID</span>
                  <span className="text-sm font-extrabold text-slate-900 block truncate">{profileName}</span>
                </div>
              </div>

              <button
                onClick={handleRegenName}
                className="px-3 py-1.5 text-[10px] font-mono font-bold text-slate-600 hover:text-slate-900 border border-slate-200 bg-slate-105/80 hover:bg-slate-100 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
              >
                <RefreshCw size={11} className="animate-spin-slow" /> Change
              </button>
            </div>

            {/* Local Network QR Code Link */}
            <div className="glass-panel rounded-xl p-4 flex flex-col sm:flex-row items-center gap-4 shadow-md">
              <div className="bg-white p-1 rounded-lg shrink-0 border border-slate-200 flex items-center justify-center min-w-[80px] min-h-[80px]">
                {localQrCodeDataUrl ? (
                  <img 
                    src={localQrCodeDataUrl} 
                    alt="Network QR Code" 
                    className="w-20 h-20 block"
                  />
                ) : (
                  <div className="w-20 h-20 bg-slate-100 animate-pulse rounded" />
                )}
              </div>
              <div className="space-y-1.5 text-center sm:text-left min-w-0 select-none">
                <span className="text-[8.5px] font-mono text-[#265c34] uppercase tracking-widest font-bold block">Local Network Portal</span>
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Connect Mobile Devices</h3>
                <p className="text-[10.5px] text-slate-600 leading-relaxed font-medium">
                  Scan this code with your phone to open SendFiles and pair instantly.
                </p>
                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 mt-1.5">
                  <div className="text-[9.5px] font-mono text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 inline-block max-w-full truncate font-bold">
                    {qrUrl}
                  </div>
                  {networkIps.length > 1 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[8px] font-mono text-slate-550 uppercase tracking-wide font-bold">Interface IP:</span>
                      <select
                        value={selectedIp}
                        onChange={(e) => setSelectedIp(e.target.value)}
                        className="text-[9px] font-mono font-bold text-[#265c34] bg-white border border-slate-200 rounded-lg px-1.5 py-0.5 outline-none cursor-pointer hover:border-[#265c34]/55 focus:border-[#265c34] transition-all"
                      >
                        {networkIps.map((ip) => (
                          <option key={ip} value={ip}>
                            {ip} {ip.startsWith("192.168.56.") ? "(VirtualBox)" : ip.startsWith("172.17.") || ip.startsWith("172.18.") || ip.startsWith("172.2") ? "(Virtual/WSL)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Simple Mobile Tab Navigation */}
            <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-xl border border-slate-200 select-none">
              <button
                onClick={() => setTab("beam")}
                className={`py-2.5 rounded-lg text-[10px] font-mono tracking-wider font-bold uppercase transition-all cursor-pointer flex items-center justify-center gap-1 ${
                  tab === "beam"
                    ? "bg-[#265c34] text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <Cpu size={12} /> Direct Share
              </button>
              <button
                onClick={() => setTab("vault-create")}
                className={`py-2.5 rounded-lg text-[10px] font-mono tracking-wider font-bold uppercase transition-all cursor-pointer flex items-center justify-center gap-1 ${
                  tab === "vault-create"
                    ? "bg-[#265c34] text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <Lock size={12} /> Create Link
              </button>
              <button
                onClick={() => setTab("vault-discover")}
                className={`py-2.5 rounded-lg text-[10px] font-mono tracking-wider font-bold uppercase transition-all cursor-pointer flex items-center justify-center gap-1 ${
                  tab === "vault-discover"
                    ? "bg-[#265c34] text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <Compass size={12} /> Receive Code
              </button>
            </div>

            {/* TAB CONTENTS */}
            
            {/* 1. Direct Share Tab */}
            {tab === "beam" && senderTransfer === null && (
              <div className="space-y-5">
                
                {/* Guide Panel */}
                <div className="glass-panel p-4.5 rounded-xl space-y-2.5 select-none">
                  <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">How to send files</h3>
                  <p className="text-xs text-slate-600 leading-relaxed leading-normal">
                    Open this page on another device. Ensure both are online. Your devices will automatically detect each other below. Click the recipient to select a file and send.
                  </p>
                </div>

                {/* Recipient list */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center select-none pl-1">
                    <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest font-black flex items-center">
                      <Wifi size={11} className="mr-1.5 text-[#265c34] live-pulse" /> Discovered Devices
                    </span>
                    <span className="text-[9px] font-mono text-slate-500 font-bold">{peers.length} active</span>
                  </div>

                  {peers.length === 0 ? (
                    <div className="glass-panel rounded-xl p-8 text-center space-y-4">
                      <div className="w-10 h-10 bg-slate-100 rounded-xl border border-slate-200 flex items-center justify-center mx-auto text-slate-500 shadow-inner">
                        <Smartphone size={18} />
                      </div>
                      <div className="space-y-1.5 max-w-sm mx-auto">
                        <h3 className="text-xs font-bold text-slate-900">Waiting for other devices...</h3>
                        <p className="text-[11px] text-slate-650 leading-relaxed font-medium">
                          Open this URL on your phone or tablet to pair instantly.
                        </p>
                      </div>
                      
                      <button
                        onClick={handleCopyAppUrl}
                        className="px-4 py-2 bg-[#265c34] hover:bg-[#347442] text-white font-mono text-[10px] font-bold tracking-wider rounded-lg transition-all cursor-pointer inline-flex items-center gap-1.5"
                      >
                        <Copy size={11} />
                        <span>{copiedLink ? "LINK COPIED!" : "COPY LINK"}</span>
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {localPeers.length > 0 && (
                        <div className="space-y-1.5">
                          <span className="text-[8.5px] font-mono text-[#265c34] font-bold uppercase tracking-widest block pl-1">Nearby Devices</span>
                          <div className="grid grid-cols-1 gap-2">
                            {localPeers.map(peer => (
                              <button
                                key={peer.peerId}
                                onClick={() => setSelectedRecipientId(peer.peerId)}
                                className={`w-full glass-panel hover:bg-[#265c34]/5 text-left p-4 rounded-xl flex items-center justify-between gap-3 cursor-pointer transition-all ${
                                  selectedRecipientId === peer.peerId ? "ring-1.5 ring-[#265c34] border-[#265c34]/30 bg-[#265c34]/4" : ""
                                }`}
                              >
                                <div className="flex items-center space-x-3 min-w-0">
                                  <div className="w-8 h-8 bg-[#265c34]/8 text-[#265c34] rounded-lg flex items-center justify-center shrink-0 border border-[#265c34]/15">
                                    <Smartphone size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold text-slate-900 block truncate">{peer.name}</span>
                                    <span className="text-[9px] font-mono text-slate-500 block uppercase tracking-wider">Tap to share file</span>
                                  </div>
                                </div>
                                <ChevronRight size={12} className="text-slate-400" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {globalPeers.length > 0 && (
                        <div className="space-y-1.5">
                          <span className="text-[8.5px] font-mono text-slate-500 font-bold uppercase tracking-widest block pl-1">Remote Devices</span>
                          <div className="grid grid-cols-1 gap-2">
                            {globalPeers.map(peer => (
                              <button
                                key={peer.peerId}
                                onClick={() => setSelectedRecipientId(peer.peerId)}
                                className={`w-full glass-panel hover:bg-[#265c34]/5 text-left p-4 rounded-xl flex items-center justify-between gap-3 cursor-pointer transition-all ${
                                  selectedRecipientId === peer.peerId ? "ring-1.5 ring-[#265c34] border-[#265c34]/30 bg-[#265c34]/4" : ""
                                }`}
                              >
                                <div className="flex items-center space-x-3 min-w-0">
                                  <div className="w-8 h-8 bg-[#265c34]/8 text-[#265c34] rounded-lg flex items-center justify-center shrink-0 border border-[#265c34]/15">
                                    <Globe size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold text-slate-900 block truncate">{peer.name}</span>
                                    <span className="text-[9px] font-mono text-slate-500 block uppercase tracking-wider">Remote Connection</span>
                                  </div>
                                </div>
                                <ChevronRight size={12} className="text-slate-400" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* File Selector Zone */}
                  {selectedRecipientId && (
                    <div className="glass-panel border-t-2 border-t-[#265c34] rounded-xl p-4.5 shadow-xl space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
                      <div className="flex justify-between items-center pb-1 select-none">
                        <div>
                          <span className="text-[8.5px] font-mono text-[#265c34] uppercase tracking-wider font-bold">Recipient Selected</span>
                          <h3 className="text-xs font-extrabold text-slate-900 mt-0.5">
                            Send to: {peers.find(p => p.peerId === selectedRecipientId)?.name || "Device"}
                          </h3>
                        </div>
                        <button
                          onClick={() => setSelectedRecipientId(null)}
                          className="text-slate-500 hover:text-slate-800 p-1 rounded-lg bg-slate-100 border border-slate-200 cursor-pointer"
                        >
                          <X size={12} />
                        </button>
                      </div>

                      <div className="border border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100/70 rounded-lg p-6 text-center cursor-pointer transition-all relative">
                        <input
                          type="file"
                          id="direct-file-selector"
                          onChange={(e) => {
                            if (e.target.files && e.target.files[0]) {
                               handleSelectFile(e.target.files[0]);
                            }
                          }}
                          className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                        />
                        <div className="w-8 h-8 bg-[#265c34]/8 text-[#265c34] rounded-full flex items-center justify-center mx-auto mb-2 border border-[#265c34]/15">
                          <UploadCloud size={14} />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-slate-800">Select File or Drop Here</p>
                          <p className="text-[9.5px] text-slate-500 font-mono mt-0.5">Sends directly over local connection</p>
                        </div>
                      </div>
                    </div>
                  )}

                </div>
              </div>
            )}

            {/* Direct share transfer progress */}
            {tab === "beam" && senderTransfer !== null && (
              <div className="glass-panel rounded-xl p-5 shadow-xl space-y-4">
                <div className="text-center space-y-1">
                  <span className="text-[9px] font-mono text-[#265c34] uppercase tracking-wider font-bold block">File Transfer status</span>
                  <h2 className="text-xs font-extrabold text-slate-900">
                    {senderTransfer.status === "waiting-acceptance" ? `Waiting for receiver to accept...` : `Transferring file...`}
                  </h2>
                </div>

                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200 flex items-center space-x-3">
                  <div className="w-9 h-9 bg-[#265c34]/8 text-[#265c34] border border-[#265c34]/15 rounded-lg flex items-center justify-center shrink-0">
                    <FileText size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-slate-900 truncate">{senderTransfer.fileName}</p>
                    <p className="text-[9.5px] font-mono text-slate-500 mt-0.5">
                      Size: {formatBytes(senderTransfer.fileSize)} • To: {senderTransfer.peerName}
                    </p>
                  </div>
                </div>

                {senderTransfer.status === "waiting-acceptance" && (
                  <div className="flex flex-col items-center justify-center py-2 space-y-3">
                    <span className="relative flex h-5 w-5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-5 w-5 bg-[#265c34] glow-box"></span>
                    </span>
                    <button
                      onClick={cancelSenderFlow}
                      className="px-4 py-2 bg-slate-100 hover:bg-rose-500/10 hover:text-rose-600 text-slate-650 border border-slate-200 hover:border-rose-500/20 font-mono text-[9px] font-bold rounded-lg cursor-pointer transition-all uppercase"
                    >
                      Cancel Transfer
                    </button>
                  </div>
                )}

                {senderTransfer.status === "transferring" && (
                  <div className="space-y-3 py-1">
                    <div className="space-y-1.5 font-mono text-[10px] text-slate-500">
                      <div className="flex justify-between font-bold">
                        <span>Speed: {formatSpeed(senderTransfer.speed)}</span>
                        <span className="text-slate-900">{senderTransfer.percent}%</span>
                      </div>
                      <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden border border-slate-300 shadow-inner">
                        <div 
                          className="bg-[#265c34] h-full rounded-full transition-all duration-100 glow-box" 
                          style={{ width: `${senderTransfer.percent}%` }}
                        />
                      </div>
                    </div>

                    <div className="text-center">
                      <button
                        onClick={cancelSenderFlow}
                        className="px-4 py-2 bg-slate-100 hover:bg-[#265c34] hover:text-white text-slate-650 border border-slate-200 hover:border-[#265c34] font-mono text-[9px] font-bold rounded-lg cursor-pointer transition-all uppercase"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {senderTransfer.status === "success" && (
                  <div className="flex flex-col items-center justify-center py-2 space-y-3 text-center">
                    <div className="w-9 h-9 bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 rounded-full flex items-center justify-center glow-box">
                      <Check size={16} />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-slate-900">Transfer Completed!</h4>
                      <p className="text-[9px] font-mono text-slate-500 mt-1 uppercase">File sent successfully to receiver</p>
                    </div>
                    <button
                      onClick={() => setSenderTransfer(null)}
                      className="px-5 py-2.5 bg-[#265c34] hover:bg-[#347442] text-white font-mono text-[10px] font-bold tracking-wider rounded-lg cursor-pointer transition-all uppercase"
                    >
                      Done
                    </button>
                  </div>
                )}

                {senderTransfer.status === "declined" && (
                  <div className="flex flex-col items-center justify-center py-2 space-y-3 text-center">
                    <div className="w-9 h-9 bg-rose-500/10 text-rose-600 border border-rose-500/20 rounded-full flex items-center justify-center">
                      <X size={16} />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-slate-900">Transfer Declined</h4>
                      <p className="text-[9px] font-mono text-slate-500 mt-1 uppercase">The recipient declined your file.</p>
                    </div>
                    <button
                      onClick={() => setSenderTransfer(null)}
                      className="px-5 py-2 bg-slate-105 border border-slate-200 hover:bg-slate-100 text-slate-600 font-mono text-[10px] font-bold tracking-wider rounded-lg cursor-pointer transition-all uppercase"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 2. Create Lock Link (Locker Creation) */}
            {tab === "vault-create" && (
              <CreateLocker onLockerCreated={handleLockerCreated} isCreating={isCreatingLocker} />
            )}

            {/* 3. Receive Code (Manual Locker Connection) */}
            {tab === "vault-discover" && (
              <NetworkDiscoveryHub onJoinRoom={handleJoinRoom} />
            )}

          </div>
        )}

        {/* VIEW B: SENDER VAULT DASHBOARD */}
        {view === "sender-dashboard" && createdLockerData && (
          <LockerDashboard
            roomId={createdLockerData.roomId}
            expiresAt={createdLockerData.expiresAt}
            maxDownloads={createdLockerData.maxDownloads}
            downloadCount={createdLockerData.downloadCount}
            rawPassword={createdLockerData.rawPassword}
            shareUrl={createdLockerData.shareUrl.includes('#key=') ? `${resolvedOrigin}/#/locker/${createdLockerData.roomId}#key=${createdLockerData.shareUrl.split('#key=')[1]}` : createdLockerData.shareUrl}
            logs={createdLockerData.logs}
            activePeers={createdLockerData.activePeers}
            peerProgressList={createdLockerData.peerProgressList}
            onShutdown={handleShutdownLocker}
            networkIps={networkIps}
            selectedIp={selectedIp}
            onSelectedIpChange={setSelectedIp}
          />
        )}

        {/* VIEW C: RECEIVER RECEPTION PANEL */}
        {view === "receiver" && activeRoomId && roomDetails && (
          <ReceptionPanel
            roomId={activeRoomId}
            encryptionKeyHex={activeKeyHex}
            roomDetails={roomDetails}
            isVerified={isLockerVerified}
            onVerificationSuccess={() => setIsLockerVerified(true)}
          />
        )}

        {/* VIEW D: ERROR SCREEN */}
        {view === "error" && (
          <div className="glass-panel max-w-sm mx-auto p-6 text-center rounded-xl shadow-xl space-y-5 select-none">
            <div className="w-11 h-11 bg-rose-500/10 border border-rose-500/20 text-rose-500 rounded-xl flex items-center justify-center mx-auto">
              <AlertCircle size={20} />
            </div>
            <div className="space-y-1">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Locker link error</h3>
              <p className="text-[11px] text-slate-650 leading-relaxed font-medium">
                {errorMsg || "The locker envelope requested has expired, is deleted, or does not exist."}
              </p>
            </div>
            <button
              onClick={() => {
                window.location.hash = "";
                setView("home");
              }}
              className="px-5 py-2.5 bg-slate-100 border border-slate-200 hover:bg-slate-200 text-slate-700 font-mono text-[10px] font-bold rounded-lg transition-all cursor-pointer inline-flex items-center gap-1.5"
            >
              <ArrowLeft size={11} className="mr-1" />
              <span>RETURN</span>
            </button>
          </div>
        )}

      </main>

      {/* Recipient incoming modal offer card */}
      {receiverTransfer !== null && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="glass-panel border-t-2 border-t-[#265c34] rounded-xl max-w-xs w-full p-5 shadow-2xl space-y-4">
            
            <div className="text-center space-y-1 select-none">
              <span className="text-[8.5px] font-mono text-[#265c34] block uppercase font-black tracking-wider">Incoming File Offer</span>
              <h3 className="text-xs font-bold text-slate-900">
                {receiverTransfer.status === "offered" ? "Receive this file?" : "Receiving file..."}
              </h3>
            </div>

            <div className="bg-slate-50 border border-slate-200 p-3 rounded-lg flex items-center space-x-3">
              <div className="w-8 h-8 bg-[#265c34]/8 text-[#265c34] border border-[#265c34]/15 rounded-lg flex items-center justify-center shrink-0">
                <FileText size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-900 truncate">{receiverTransfer.fileName}</p>
                <p className="text-[9.5px] text-slate-500 mt-0.5 truncate leading-none">
                  Size: {formatBytes(receiverTransfer.fileSize)} • From: {receiverTransfer.peerName}
                </p>
              </div>
            </div>

            {receiverTransfer.status === "offered" && (
              <div className="flex flex-col gap-1.5 pt-0.5 select-none">
                <button
                  onClick={acceptIncomingOffer}
                  className="w-full py-2.5 bg-[#265c34] hover:bg-[#347442] text-white font-mono text-[10px] font-bold tracking-wider rounded-lg cursor-pointer transition-all uppercase flex items-center justify-center space-x-1.5"
                >
                  <Download size={12} />
                  <span>Accept File</span>
                </button>
                <button
                  onClick={declineIncomingOffer}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-650 hover:text-slate-800 border border-slate-200 font-mono text-[10px] font-semibold tracking-wider rounded-lg cursor-pointer transition-all uppercase"
                >
                  Decline
                </button>
              </div>
            )}

            {receiverTransfer.status === "transferring" && (
              <div className="space-y-2.5 py-0.5">
                <div className="flex justify-between items-center text-[9px] font-mono text-slate-500 select-none">
                  <span>Receiving...</span>
                  <span className="font-bold text-slate-900">{receiverTransfer.percent}%</span>
                </div>
                <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden border border-slate-300 shadow-inner">
                  <div 
                    className="bg-[#265c34] h-full rounded-full transition-all duration-100 glow-box" 
                    style={{ width: `${receiverTransfer.percent}%` }}
                  />
                </div>
              </div>
            )}

            {receiverTransfer.status === "success" && (
              <div className="flex flex-col items-center justify-center py-2 space-y-3 text-center select-none">
                <div className="w-9 h-9 bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 rounded-full flex items-center justify-center glow-box">
                  <Check size={16} />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900">Transfer Completed!</h4>
                  <p className="text-[9px] font-mono text-slate-500 mt-1 uppercase">File downloaded to your local storage</p>
                </div>
                <button
                  onClick={() => setReceiverTransfer(null)}
                  className="w-full py-2.5 bg-[#265c34] hover:bg-[#347442] text-white font-mono text-[10px] font-bold tracking-wider rounded-lg cursor-pointer transition-all uppercase"
                >
                  Dismiss
                </button>
              </div>
            )}

          </div>
        </div>
      )}

    </div>
  );
}
