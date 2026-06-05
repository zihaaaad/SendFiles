/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  Wifi, 
  User, 
  Globe, 
  Monitor, 
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
  Info,
  Search,
  Send,
  Lock,
  Unlock,
  FolderLock,
  Compass,
  Cpu,
  Terminal,
  ArrowLeft
} from "lucide-react";
import { getWebSocketURL, formatSpeed } from "./utils/webrtc-helper";
import { generateSecretKey, exportKeyToHex } from "./utils/crypto";
import { P2PSender } from "./utils/p2p-engine";
import { RoomDetails, TransferProgress } from "./types";

// Import subcomponents
import CreateLocker from "./components/CreateLocker";
import LockerDashboard from "./components/LockerDashboard";
import NetworkDiscoveryHub from "./components/NetworkDiscoveryHub";
import ReceptionPanel from "./components/ReceptionPanel";

// Chunk size for direct WebSocket relay fallback: 60kb
const CHUNK_SIZE = 60000;

const ADJECTIVES = [
  "Cyber", "Stellar", "Cosmic", "Quantum", "Shadow", "Neon",
  "Aero", "Hyper", "Vortex", "Dynamic", "Nexus", "Matrix",
  "Apex", "Solar", "Glitch", "Cipher", "Swift", "Silent"
];

const ANIMALS = [
  "Falcon", "Specter", "Dolphin", "Phoenix", "Lynx", "Tiger",
  "Viper", "Raptor", "Grid", "Panda", "Ghost", "Sentinel",
  "Cobra", "Titan", "Ranger", "Orbit", "Nova", "Nomad"
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
  // 1. Identity Profiling
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

  // 3. Direct Beam (WebSocket Relay Mode) States
  const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
  const [myPublicIp, setMyPublicIp] = useState<string>("Detecting public IP...");
  const [socketStatus, setSocketStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [copiedLink, setCopiedLink] = useState(false);
  const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(null);

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

  // 5. Active references for WebSockets & engines
  const wsRef = useRef<WebSocket | null>(null);
  const activeSenderFileRef = useRef<File | null>(null);
  const senderAckPromiseResolver = useRef<((val: any) => void) | null>(null);
  const incomingChunksRef = useRef<{ [index: number]: Uint8Array }>({});
  const p2pSenderRef = useRef<P2PSender | null>(null);

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
        // Clear active receiver states and return home
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
  // Direct Beam WebSocket client connection
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
      wsRef.current = ws;

      ws.onopen = () => {
        setSocketStatus("online");
      };

      ws.onclose = () => {
        setSocketStatus("offline");
        // Reconnect after 3 seconds if we are still on the Home/Beam view
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
        try {
          const message = JSON.parse(event.data);
          const { type, senderPeerId, senderName, payload } = message;

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
              incomingChunksRef.current = {};
              break;

            case "file-offer-response":
              if (payload.accepted) {
                if (senderTransfer && activeSenderFileRef.current) {
                  beginChunkStreaming(senderTransfer.peerId, activeSenderFileRef.current);
                }
              } else {
                setSenderTransfer(prev => prev ? { ...prev, status: "declined" } : null);
                activeSenderFileRef.current = null;
              }
              break;

            case "relay-chunk":
              handleIncomingChunk(payload, senderPeerId);
              break;

            case "relay-chunk-ack":
              if (senderAckPromiseResolver.current) {
                senderAckPromiseResolver.current(true);
              }
              break;

            case "transfer-canceled":
              setReceiverTransfer(null);
              incomingChunksRef.current = {};
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

  // Direct Beam Selection & streaming triggers
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

  const beginChunkStreaming = async (recipientId: string, file: File) => {
    if (!senderTransfer) return;

    setSenderTransfer(prev => prev ? { ...prev, status: "transferring" } : null);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const startTime = Date.now();

    for (let index = 0; index < totalChunks; index++) {
      if (!activeSenderFileRef.current || senderTransfer?.status === "canceled") {
        break;
      }

      const start = index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const fileSlice = file.slice(start, end);

      const base64Data = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve(result.substring(result.indexOf(",") + 1));
        };
        reader.readAsDataURL(fileSlice);
      });

      sendSignal({
        type: "relay-chunk",
        targetPeerId: recipientId,
        payload: {
          chunkIndex: index,
          totalChunks,
          data: base64Data,
          fileName: file.name
        }
      });

      const percent = Math.round(((index + 1) / totalChunks) * 100);
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? ((index + 1) * CHUNK_SIZE) / elapsed : 0;

      setSenderTransfer(prev => prev ? { ...prev, percent, speed } : null);

      await new Promise<void>((resolve) => {
        senderAckPromiseResolver.current = resolve;
        setTimeout(() => {
          if (senderAckPromiseResolver.current === resolve) {
            senderAckPromiseResolver.current = null;
            resolve();
          }
        }, 80); // Throttling fallback
      });
    }

    setSenderTransfer(prev => prev && prev.status === "transferring" ? {
      ...prev,
      percent: 100,
      status: "success"
    } : prev);

    activeSenderFileRef.current = null;
  };

  const cancelSenderFlow = () => {
    if (senderTransfer) {
      sendSignal({
        type: "transfer-canceled",
        targetPeerId: senderTransfer.peerId
      });
    }
    setSenderTransfer(null);
    activeSenderFileRef.current = null;
  };

  const declineIncomingOffer = () => {
    if (receiverTransfer) {
      sendSignal({
        type: "file-offer-response",
        targetPeerId: receiverTransfer.peerId,
        payload: { accepted: false }
      });
    }
    setReceiverTransfer(null);
    incomingChunksRef.current = {};
  };

  const acceptIncomingOffer = () => {
    if (!receiverTransfer) return;
    setReceiverTransfer(prev => prev ? { ...prev, status: "transferring" } : null);
    sendSignal({
      type: "file-offer-response",
      targetPeerId: receiverTransfer.peerId,
      payload: { accepted: true }
    });
  };

  const handleIncomingChunk = (payload: any, senderId: string) => {
    const { chunkIndex, totalChunks, data, fileName } = payload;
    
    try {
      const decodedString = window.atob(data);
      const bytes = new Uint8Array(decodedString.length);
      for (let i = 0; i < decodedString.length; i++) {
        bytes[i] = decodedString.charCodeAt(i);
      }

      incomingChunksRef.current[chunkIndex] = bytes;

      sendSignal({
        type: "relay-chunk-ack",
        targetPeerId: senderId,
        payload: { chunkIndex }
      });

      const currentCount = Object.keys(incomingChunksRef.current).length;
      const percent = Math.round((currentCount / totalChunks) * 100);

      setReceiverTransfer(prev => {
        if (!prev) return null;
        return {
          ...prev,
          chunksReceived: currentCount,
          percent,
          status: currentCount >= totalChunks ? "success" : "transferring"
        };
      });

      if (currentCount >= totalChunks) {
        const sortedBuffers: Uint8Array[] = [];
        for (let i = 0; i < totalChunks; i++) {
          sortedBuffers.push(incomingChunksRef.current[i] || new Uint8Array(0));
        }

        const assembledBlob = new Blob(sortedBuffers);
        const blobUrl = URL.createObjectURL(assembledBlob);

        const anchor = document.createElement("a");
        anchor.href = blobUrl;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);

        incomingChunksRef.current = {};
      }
    } catch (e) {
      console.error("Failed handling chunk slice:", e);
      setReceiverTransfer(prev => prev ? { ...prev, status: "failed" } : null);
    }
  };

  // ----------------------------------------------------
  // Encrypted Locker Actions
  // ----------------------------------------------------
  const handleLockerCreated = async ({
    files,
    maxDownloads,
    expiresInMins,
    passwordHash,
    rawPassword,
  }: {
    files: File[];
    maxDownloads: number;
    expiresInMins: number;
    passwordHash: string | null;
    rawPassword?: string;
  }) => {
    setIsCreatingLocker(true);
    try {
      // 1. Generate client-side cryptographic key
      const cryptoKey = await generateSecretKey();
      const keyHex = await exportKeyToHex(cryptoKey);
      
      // 2. Register locker room on backend
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
          maxDownloads,
          expiresInMins,
          passwordHash
        })
      });
      
      if (!res.ok) {
        throw new Error("Failed to register locker room on server.");
      }
      
      const roomInfo = await res.json();
      
      // 3. Setup WebRTC P2P Sender
      const sender = new P2PSender(roomInfo.roomId, files, cryptoKey);
      p2pSenderRef.current = sender;
      
      const shareUrl = `${window.location.origin}/#/locker/${roomInfo.roomId}#key=${keyHex}`;
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
      
      // Wire up engine status and log listeners
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
          
          // Dynamically check if this progress update includes download completeness
          let nextDlCount = prev.downloadCount;
          if (progress.status === "complete") {
             // Incremented locally to update visual counts instantly
             nextDlCount = Math.min(prev.maxDownloads, prev.downloadCount + 1);
          }
          
          return { 
            ...prev, 
            peerProgressList: nextProgress,
            downloadCount: nextDlCount
          };
        });
      };
      
      // 4. Start sender WebSocket signaling client
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

  // Utils helpers
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const idx = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, idx)).toFixed(1))} ${sizes[idx]}`;
  };

  const handleCopyAppUrl = () => {
    navigator.clipboard.writeText(window.location.origin);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const localPeers = peers.filter(p => p.ip === myPublicIp);
  const globalPeers = peers.filter(p => p.ip !== myPublicIp);

  // ----------------------------------------------------
  // Main Rendering Pipelines
  // ----------------------------------------------------
  return (
    <div className="min-h-screen bg-brand-bg text-[#CBD5E1] flex flex-col font-sans antialiased relative overflow-x-hidden selection:bg-indigo-600/40 pb-12">
      
      {/* Background glow effects */}
      <div className="absolute top-[-10%] left-[20%] w-[600px] h-[600px] bg-indigo-600/10 rounded-full blur-[160px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[10%] w-[500px] h-[500px] bg-emerald-600/5 rounded-full blur-[140px] pointer-events-none" />

      {/* Header element */}
      <header className="relative w-full z-10 border-b border-brand-border bg-brand-bg/60 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-18 flex items-center justify-between">
          
          <div className="flex items-center space-x-3 select-none">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-500 flex items-center justify-center text-white shadow-lg shadow-indigo-600/25">
              <Network size={18} className="animate-pulse" />
            </div>
            <div>
              <span className="text-sm font-extrabold tracking-wider text-white uppercase block">SendFiles P2P</span>
              <span className="text-[9px] font-mono text-indigo-400 tracking-widest uppercase block -mt-1 font-bold">End-to-End Cryptographic Portal</span>
            </div>
          </div>

          <div className="flex items-center space-x-6">
            {view === "home" && tab === "beam" && (
              <div className="flex items-center space-x-2">
                <span className={`w-2.5 h-2.5 rounded-full ${
                  socketStatus === "online" ? "bg-emerald-500 glow-box" : socketStatus === "connecting" ? "bg-amber-400 animate-pulse" : "bg-rose-500"
                }`} />
                <span className="text-[10px] font-mono text-[#94A3B8] font-bold tracking-widest uppercase">
                  {socketStatus === "online" ? "DISCOVERY ONLINE" : socketStatus === "connecting" ? "SYNCING HUB..." : "OFFLINE"}
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
                className="flex items-center text-xs font-mono font-bold tracking-wider hover:text-white text-indigo-400 cursor-pointer transition-colors"
              >
                <ArrowLeft size={14} className="mr-1.5" /> Return Home
              </button>
            )}
          </div>

        </div>
      </header>

      {/* Main Container */}
      <main className="relative flex-1 z-10 max-w-5xl w-full mx-auto px-6 py-8">
        
        {/* VIEW A: HOME DASHBOARD */}
        {view === "home" && (
          <div className="space-y-6">
            {/* Identity Banner */}
            <div className="glass-panel rounded-2xl p-5 flex flex-col md:flex-row items-center justify-between gap-4 shadow-xl">
              <div className="flex items-center space-x-4">
                <div className="w-11 h-11 bg-indigo-500/10 text-indigo-400 rounded-xl flex items-center justify-center border border-indigo-500/15">
                  <User size={20} />
                </div>
                <div>
                  <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest font-bold">Node Operator Identity</span>
                  <span className="text-base font-extrabold text-white block mt-0.5">{profileName}</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleRegenName}
                  className="px-4 py-2 text-xs font-mono font-bold text-slate-350 hover:text-white border border-brand-border bg-slate-900/40 hover:bg-slate-900/80 rounded-xl transition-all cursor-pointer flex items-center gap-2"
                >
                  <RefreshCw size={12} className="animate-spin-slow" /> Reset Username
                </button>
              </div>
            </div>

            {/* Premium Routing Navigation tabs */}
            <div className="grid grid-cols-3 gap-2 p-1.5 bg-slate-900/40 rounded-2xl border border-brand-border select-none">
              <button
                onClick={() => setTab("beam")}
                className={`py-3 rounded-xl text-xs font-mono tracking-widest font-bold uppercase transition-all cursor-pointer flex items-center justify-center gap-2 ${
                  tab === "beam"
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                    : "text-slate-400 hover:text-white hover:bg-slate-800/30"
                }`}
              >
                <Cpu size={14} /> Direct Beam
              </button>
              <button
                onClick={() => setTab("vault-create")}
                className={`py-3 rounded-xl text-xs font-mono tracking-widest font-bold uppercase transition-all cursor-pointer flex items-center justify-center gap-2 ${
                  tab === "vault-create"
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                    : "text-slate-400 hover:text-white hover:bg-slate-800/30"
                }`}
              >
                <Lock size={14} /> Create Vault
              </button>
              <button
                onClick={() => setTab("vault-discover")}
                className={`py-3 rounded-xl text-xs font-mono tracking-widest font-bold uppercase transition-all cursor-pointer flex items-center justify-center gap-2 ${
                  tab === "vault-discover"
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                    : "text-slate-400 hover:text-white hover:bg-slate-800/30"
                }`}
              >
                <Compass size={14} /> Discover Vaults
              </button>
            </div>

            {/* TAB CONTENTS */}
            
            {/* 1. Direct Beam panel */}
            {tab === "beam" && senderTransfer === null && (
              <div className="space-y-6">
                
                {/* Guide panel */}
                <div className="glass-panel p-6 rounded-2xl grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-slate-900/30 p-4 rounded-xl border border-brand-border">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-6 h-6 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center text-xs font-mono font-bold">1</span>
                      <h4 className="text-xs font-bold text-white uppercase tracking-wider">Connect Devices</h4>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-normal">
                      Open <span className="font-mono text-indigo-300 font-bold">{window.location.host}</span> on your sender/receiver device on the same local network.
                    </p>
                  </div>
                  
                  <div className="bg-slate-900/30 p-4 rounded-xl border border-brand-border">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-6 h-6 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center text-xs font-mono font-bold">2</span>
                      <h4 className="text-xs font-bold text-white uppercase tracking-wider">Discover Peers</h4>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-normal">
                      Your devices will instantly pair. Tell the sender to look for receiver username: <span className="font-semibold text-white">{profileName}</span>.
                    </p>
                  </div>

                  <div className="bg-slate-900/30 p-4 rounded-xl border border-brand-border">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-6 h-6 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center text-xs font-mono font-bold">3</span>
                      <h4 className="text-xs font-bold text-white uppercase tracking-wider">Relay Files</h4>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-normal">
                      Tap the recipient node, select a file, and stream it securely. No servers involved in local paths.
                    </p>
                  </div>
                </div>

                {/* Recipient list */}
                <div className="space-y-4">
                  <div className="flex justify-between items-center select-none pl-1">
                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest font-black flex items-center">
                      <Wifi size={13} className="mr-2 text-indigo-450 live-pulse" /> Active Discovery Registry
                    </span>
                    <span className="text-[10px] font-mono text-slate-400 font-bold">{peers.length} active node{peers.length !== 1 && "s"}</span>
                  </div>

                  {peers.length === 0 ? (
                    <div className="glass-panel rounded-2xl p-10 text-center space-y-6">
                      <div className="w-14 h-14 bg-slate-900/80 rounded-2xl border border-brand-border flex items-center justify-center mx-auto text-slate-400 shadow-inner">
                        <Monitor size={24} className="text-slate-500" />
                      </div>
                      <div className="space-y-2 max-w-sm mx-auto">
                        <h3 className="text-sm font-bold text-white">Awaiting Connection Nodes...</h3>
                        <p className="text-xs text-slate-450 leading-relaxed font-medium">
                          Open this URL on another device in the same network or share the app URL to pair instantly.
                        </p>
                      </div>
                      
                      <button
                        onClick={handleCopyAppUrl}
                        className="px-5 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-bold tracking-wider rounded-xl transition-all cursor-pointer inline-flex items-center gap-2 shadow-lg shadow-indigo-600/20"
                      >
                        <Copy size={13} />
                        <span>{copiedLink ? "LINK COPIED!" : "COPY SHARABLE URL"}</span>
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Local network matching IP */}
                      {localPeers.length > 0 && (
                        <div className="space-y-2">
                          <span className="text-[9px] font-mono text-indigo-400 font-bold uppercase tracking-widest block pl-1">Local Network (Nearby IP)</span>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {localPeers.map(peer => (
                              <button
                                key={peer.peerId}
                                onClick={() => setSelectedRecipientId(peer.peerId)}
                                className={`w-full glass-panel hover:bg-slate-900/20 text-left p-5 rounded-2xl flex items-center justify-between gap-4 cursor-pointer transition-all ${
                                  selectedRecipientId === peer.peerId ? "ring-2 ring-indigo-500 border-indigo-500/40 bg-indigo-500/5" : ""
                                }`}
                              >
                                <div className="flex items-center space-x-4 min-w-0">
                                  <div className="w-10 h-10 bg-indigo-500/10 text-indigo-400 rounded-xl flex items-center justify-center shrink-0 border border-indigo-500/20">
                                    <Smartphone size={18} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold text-white block truncate">{peer.name}</span>
                                    <span className="text-[9px] font-mono text-slate-450 block uppercase mt-0.5 tracking-wider">Nearby Node • Click to beam</span>
                                  </div>
                                </div>
                                <ChevronRight size={14} className="text-slate-500" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Global / Remote network */}
                      {globalPeers.length > 0 && (
                        <div className="space-y-2">
                          <span className="text-[9px] font-mono text-slate-400 font-bold uppercase tracking-widest block pl-1">Remote Network (Global IP)</span>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {globalPeers.map(peer => (
                              <button
                                key={peer.peerId}
                                onClick={() => setSelectedRecipientId(peer.peerId)}
                                className={`w-full glass-panel hover:bg-slate-900/20 text-left p-5 rounded-2xl flex items-center justify-between gap-4 cursor-pointer transition-all ${
                                  selectedRecipientId === peer.peerId ? "ring-2 ring-indigo-500 border-indigo-500/40 bg-indigo-500/5" : ""
                                }`}
                              >
                                <div className="flex items-center space-x-4 min-w-0">
                                  <div className="w-10 h-10 bg-indigo-500/10 text-indigo-400 rounded-xl flex items-center justify-center shrink-0 border border-indigo-500/20">
                                    <Globe size={18} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold text-white block truncate">{peer.name}</span>
                                    <span className="text-[9px] font-mono text-slate-450 block mt-0.5 uppercase tracking-wider">Remote Node • Internet Connection</span>
                                  </div>
                                </div>
                                <ChevronRight size={14} className="text-slate-500" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* File Selector Zone */}
                  {selectedRecipientId && (
                    <div className="glass-panel border-t-2 border-t-indigo-500 rounded-2xl p-6 shadow-2xl space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-255">
                      <div className="flex justify-between items-center pb-2 select-none">
                        <div>
                          <span className="text-[10px] font-mono text-indigo-400 uppercase tracking-widest font-bold">Beam Destination</span>
                          <h3 className="text-sm font-extrabold text-white mt-0.5">
                            Target Peer: {peers.find(p => p.peerId === selectedRecipientId)?.name || "Device"}
                          </h3>
                        </div>
                        <button
                          onClick={() => setSelectedRecipientId(null)}
                          className="text-slate-400 hover:text-white p-1.5 rounded-lg bg-slate-900/40 hover:bg-slate-900/90 border border-brand-border cursor-pointer transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </div>

                      <div className="border border-dashed border-slate-700 bg-slate-900/20 hover:bg-slate-900/40 rounded-xl p-8 text-center cursor-pointer transition-all relative">
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
                        <div className="w-10 h-10 bg-indigo-500/10 text-indigo-400 rounded-full flex items-center justify-center mx-auto mb-3 border border-indigo-500/25">
                          <UploadCloud size={18} />
                        </div>
                        <div>
                          <p className="text-xs font-extrabold text-white">Choose File or Drop Here</p>
                          <p className="text-[10px] text-slate-400 font-mono mt-1">Files are read as binary slices and relayed instantly</p>
                        </div>
                      </div>
                    </div>
                  )}

                </div>
              </div>
            )}

            {/* Direct Beam streaming UI (Active transfer) */}
            {tab === "beam" && senderTransfer !== null && (
              <div className="glass-panel rounded-2xl p-6 max-w-xl mx-auto shadow-2xl space-y-6">
                <div className="text-center space-y-1.5">
                  <span className="text-[9px] font-mono text-indigo-400 uppercase tracking-widest font-black block">Active Beam Tunnel</span>
                  <h2 className="text-base font-extrabold text-white">
                    {senderTransfer.status === "waiting-acceptance" ? `Awaiting receiver authorization...` : `Beaming data blocks...`}
                  </h2>
                </div>

                <div className="bg-slate-900/30 rounded-xl p-4 border border-brand-border flex items-center space-x-4">
                  <div className="w-11 h-11 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg flex items-center justify-center shrink-0">
                    <FileText size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-white truncate">{senderTransfer.fileName}</p>
                    <div className="flex items-center space-x-2.5 text-[10px] font-mono text-slate-400 mt-1">
                      <span>Size: {formatBytes(senderTransfer.fileSize)}</span>
                      <span>•</span>
                      <span className="text-indigo-300">To: {senderTransfer.peerName}</span>
                    </div>
                  </div>
                </div>

                {/* Waiting State Spinner */}
                {senderTransfer.status === "waiting-acceptance" && (
                  <div className="flex flex-col items-center justify-center py-6 space-y-4">
                    <span className="relative flex h-6 w-6">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-6 w-6 bg-indigo-600 glow-box"></span>
                    </span>
                    <p className="text-[10px] font-mono text-slate-400 text-center uppercase tracking-wider max-w-[280px]">
                      Waiting for recipient device to accept the connection offer...
                    </p>
                    <button
                      onClick={cancelSenderFlow}
                      className="px-5 py-2.5 bg-slate-900/80 hover:bg-rose-500/20 hover:text-rose-400 text-slate-400 border border-brand-border hover:border-rose-500/30 font-mono text-[10px] font-bold rounded-lg cursor-pointer transition-all uppercase"
                    >
                      Cancel Beam
                    </button>
                  </div>
                )}

                {/* Transferring State bar */}
                {senderTransfer.status === "transferring" && (
                  <div className="space-y-4 py-2">
                    <div className="space-y-2 font-mono text-[11px] text-slate-350">
                      <div className="flex justify-between font-bold">
                        <span>Speed: {formatSpeed(senderTransfer.speed)}</span>
                        <span className="text-white">{senderTransfer.percent}%</span>
                      </div>
                      <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden border border-brand-border shadow-inner">
                        <div 
                          className="bg-indigo-600 h-full rounded-full transition-all duration-100 glow-box" 
                          style={{ width: `${senderTransfer.percent}%` }}
                        />
                      </div>
                    </div>

                    <div className="text-center">
                      <button
                        onClick={cancelSenderFlow}
                        className="px-5 py-2.5 bg-slate-900/80 hover:bg-rose-500/20 hover:text-rose-400 text-slate-400 border border-brand-border hover:border-rose-500/30 font-mono text-[10px] font-bold rounded-lg cursor-pointer transition-all uppercase"
                      >
                        Abort Stream
                      </button>
                    </div>
                  </div>
                )}

                {/* Transfer Success */}
                {senderTransfer.status === "success" && (
                  <div className="flex flex-col items-center justify-center py-4 space-y-4 text-center">
                    <div className="w-11 h-11 bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 rounded-full flex items-center justify-center glow-box">
                      <Check size={20} />
                    </div>
                    <div>
                      <h4 className="text-xs font-extrabold text-white">Beam Transfer Accomplished!</h4>
                      <p className="text-[9.5px] font-mono text-slate-450 mt-1 leading-normal uppercase">Binary segments assembled directly in recipient memory</p>
                    </div>
                    <button
                      onClick={() => setSenderTransfer(null)}
                      className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-bold tracking-wider rounded-xl cursor-pointer transition-all uppercase"
                    >
                      Return to registry
                    </button>
                  </div>
                )}

                {/* Declined offer */}
                {senderTransfer.status === "declined" && (
                  <div className="flex flex-col items-center justify-center py-4 space-y-4 text-center">
                    <div className="w-11 h-11 bg-rose-500/15 text-rose-450 border border-rose-500/20 rounded-full flex items-center justify-center">
                      <X size={20} />
                    </div>
                    <div>
                      <h4 className="text-xs font-extrabold text-white">Transfer Declined</h4>
                      <p className="text-[9.5px] font-mono text-slate-450 mt-1 uppercase">The recipient denied the incoming beam file payload.</p>
                    </div>
                    <button
                      onClick={() => setSenderTransfer(null)}
                      className="px-6 py-2.5 bg-slate-900 border border-brand-border hover:bg-slate-800 text-slate-350 font-mono text-xs font-bold tracking-wider rounded-xl cursor-pointer transition-all uppercase"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 2. Create Locker Panel */}
            {tab === "vault-create" && (
              <CreateLocker onLockerCreated={handleLockerCreated} isCreating={isCreatingLocker} />
            )}

            {/* 3. Discover Lockers Panel */}
            {tab === "vault-discover" && (
              <NetworkDiscoveryHub onJoinRoom={handleJoinRoom} />
            )}

          </div>
        )}

        {/* VIEW B: SENDER LOCKER DASHBOARD */}
        {view === "sender-dashboard" && createdLockerData && (
          <LockerDashboard
            roomId={createdLockerData.roomId}
            expiresAt={createdLockerData.expiresAt}
            maxDownloads={createdLockerData.maxDownloads}
            downloadCount={createdLockerData.downloadCount}
            rawPassword={createdLockerData.rawPassword}
            shareUrl={createdLockerData.shareUrl}
            logs={createdLockerData.logs}
            activePeers={createdLockerData.activePeers}
            peerProgressList={createdLockerData.peerProgressList}
            onShutdown={handleShutdownLocker}
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

        {/* VIEW D: FAULT PAGE */}
        {view === "error" && (
          <div className="glass-panel max-w-md mx-auto p-8 text-center rounded-2xl shadow-2xl space-y-6">
            <div className="w-14 h-14 bg-rose-500/10 border border-rose-500/20 text-rose-500 rounded-2xl flex items-center justify-center mx-auto shadow-inner">
              <AlertCircle size={24} />
            </div>
            <div className="space-y-2 select-none">
              <h3 className="text-sm font-extrabold text-white uppercase tracking-wider">Secure Connection Failed</h3>
              <p className="text-xs text-slate-450 leading-relaxed font-medium">
                {errorMsg || "The locker envelope requested has expired, is deleted, or does not exist."}
              </p>
            </div>
            <button
              onClick={() => {
                window.location.hash = "";
                setView("home");
              }}
              className="px-6 py-3 bg-slate-900 border border-brand-border hover:bg-slate-800 text-slate-350 hover:text-white font-mono text-xs font-bold rounded-xl transition-all cursor-pointer inline-flex items-center gap-2"
            >
              <ArrowLeft size={13} />
              <span>RETURN TO PORTAL</span>
            </button>
          </div>
        )}

      </main>

      {/* Recipient incoming modal card overlay (Direct Beam) */}
      {receiverTransfer !== null && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div className="glass-panel border-t-2 border-t-indigo-500 rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-6">
            
            <div className="text-center space-y-1 select-none">
              <span className="text-[9px] font-mono text-indigo-400 block uppercase font-black tracking-widest">Incoming Beam Request</span>
              <h3 className="text-sm font-extrabold text-white">
                {receiverTransfer.status === "offered" ? "Accept this file?" : "Streaming segment blocks..."}
              </h3>
            </div>

            <div className="bg-slate-900/30 border border-brand-border p-4 rounded-xl flex items-center space-x-3.5">
              <div className="w-10 h-10 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg flex items-center justify-center shrink-0">
                <FileText size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-white truncate">{receiverTransfer.fileName}</p>
                <div className="flex items-center space-x-2.5 text-[10px] font-mono text-slate-455 mt-1 leading-none font-medium">
                  <span>Size: {formatBytes(receiverTransfer.fileSize)}</span>
                  <span>•</span>
                  <span className="text-indigo-300">From: {receiverTransfer.peerName}</span>
                </div>
              </div>
            </div>

            {/* Accept / Decline selection buttons */}
            {receiverTransfer.status === "offered" && (
              <div className="flex flex-col gap-2 pt-1 select-none">
                <button
                  onClick={acceptIncomingOffer}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-bold tracking-widest rounded-xl cursor-pointer transition-all uppercase shadow-lg shadow-indigo-600/20 flex items-center justify-center space-x-2"
                >
                  <Download size={13} />
                  <span>AUTHORIZE BEAM</span>
                </button>
                <button
                  onClick={declineIncomingOffer}
                  className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white font-mono text-xs font-semibold tracking-widest rounded-xl cursor-pointer border border-brand-border transition-all uppercase"
                >
                  Decline
                </button>
              </div>
            )}

            {/* Streaming reception bar */}
            {receiverTransfer.status === "transferring" && (
              <div className="space-y-3 py-1">
                <div className="flex justify-between items-center text-[10px] font-mono text-slate-350 select-none">
                  <span>Assembling segments...</span>
                  <span className="font-bold text-white">{receiverTransfer.percent}%</span>
                </div>
                <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden border border-brand-border shadow-inner">
                  <div 
                    className="bg-indigo-650 h-full rounded-full transition-all duration-100 glow-box" 
                    style={{ width: `${receiverTransfer.percent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Completed Assembly State */}
            {receiverTransfer.status === "success" && (
              <div className="flex flex-col items-center justify-center py-2 space-y-4 text-center select-none animate-in zoom-in-95 duration-200">
                <div className="w-11 h-11 bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 rounded-full flex items-center justify-center glow-box">
                  <Check size={20} />
                </div>
                <div>
                  <h4 className="text-xs font-extrabold text-white">Payload Assembled!</h4>
                  <p className="text-[9.5px] font-mono text-slate-450 mt-1 uppercase">The file was successfully constructed and saved to disk</p>
                </div>
                <button
                  onClick={() => setReceiverTransfer(null)}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-bold tracking-wider rounded-xl cursor-pointer transition-all uppercase"
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
