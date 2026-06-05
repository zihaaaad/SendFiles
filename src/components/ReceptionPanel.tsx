/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  Lock, 
  Key, 
  ChevronRight, 
  RefreshCw, 
  ShieldCheck, 
  Download, 
  Terminal, 
  Cpu, 
  AlertCircle, 
  HeartHandshake,
  FolderLock,
  FileText
} from "lucide-react";
import SpeedChart from "./SpeedChart";
import { RoomDetails, TransferProgress, TransferState } from "../types";
import { P2PReceiver } from "../utils/p2p-engine";
import { formatSpeed, formatTime } from "../utils/webrtc-helper";
import { hashPassword } from "../utils/crypto";

interface ReceptionPanelProps {
  roomId: string;
  encryptionKeyHex: string;
  roomDetails: RoomDetails;
  onVerificationSuccess: () => void;
  isVerified: boolean;
}

export default function ReceptionPanel({
  roomId,
  encryptionKeyHex,
  roomDetails,
  onVerificationSuccess,
  isVerified,
}: ReceptionPanelProps) {
  const [password, setPassword] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [useVerified, setUseVerified] = useState(isVerified);

  // Transfer State Managers
  const [transferState, setTransferState] = useState<TransferState>("idle");
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [speedHistory, setSpeedHistory] = useState<number[]>([]);
  const [compiledFiles, setCompiledFiles] = useState<{ name: string; url: string; size: number }[]>([]);

  const receiverRef = useRef<P2PReceiver | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs((prev) => [...prev, `[${timestamp}] ${msg}`]);
  };

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifying(true);
    setErrorMsg("");

    try {
      const pHash = await hashPassword(password);
      const res = await fetch(`/api/rooms/${roomId}/verify-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passwordHash: pHash }),
      });

      if (res.ok) {
        setUseVerified(true);
        onVerificationSuccess();
      } else {
        const err = await res.json();
        setErrorMsg(err.error || "Incorrect lock-shield PIN/Password.");
      }
    } catch {
      setErrorMsg("Failed verifying secondary lock credentials.");
    } finally {
      setVerifying(false);
    }
  };

  // Launch receiver engine once verified
  useEffect(() => {
    if (!useVerified) return;

    addLog(`Resolving symmetric keys for locker: ${roomId}`);
    
    const receiver = new P2PReceiver(roomId, encryptionKeyHex);
    receiverRef.current = receiver;

    receiver.onLogMessage = (msg) => {
      addLog(msg);
    };

    receiver.onStatusChange = (status) => {
      setTransferState(status);
    };

    receiver.onProgress = (prog) => {
      setProgress(prog);
    };

    receiver.onFilesCompiled = (list) => {
      addLog(`All blocks verified and compiled in browser memory.`);
      setCompiledFiles(list);
    };

    receiver.start();

    return () => {
      receiver.stop();
    };
  }, [useVerified, roomId, encryptionKeyHex]);

  // Track speed curves
  useEffect(() => {
    const clock = setInterval(() => {
      if (transferState === "transferring" && progress) {
        setSpeedHistory((prev) => {
          const updated = [...prev, progress.speed];
          if (updated.length > 50) updated.shift();
          return updated;
        });
      }
    }, 1000);

    return () => clearInterval(clock);
  }, [transferState, progress]);

  // Auto scroll logger
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // Security Verification entry screen (Password Required)
  if (!useVerified && roomDetails.hasPassword) {
    return (
      <div className="w-full max-w-md mx-auto glass-panel p-8 rounded-2xl shadow-2xl space-y-6 animate-in zoom-in-95 duration-200">
        <div className="text-center space-y-1.5 select-none">
          <div className="w-12 h-12 bg-amber-500/10 border border-amber-500/25 rounded-xl flex items-center justify-center text-amber-400 mx-auto mb-4 shadow-sm glow-box">
            <Lock size={22} />
          </div>
          <h2 className="text-base font-extrabold text-white tracking-tight font-sans">Shield Passcode Required</h2>
          <p className="text-xs text-slate-400 font-mono">
            This locker envelope is locked client-side. Enter locker password PIN to sync peer links.
          </p>
        </div>

        <form onSubmit={handleVerifyPassword} className="space-y-4">
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-450">
              <Key size={15} />
            </span>
            <input
              type="password"
              placeholder="Enter locker passcode PIN..."
              required
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-950/40 focus:bg-slate-950 text-xs text-white border border-brand-border focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/10 rounded-xl pl-9.5 pr-4 py-3 outline-none transition-all placeholder:text-slate-500 font-mono"
            />
          </div>

          {errorMsg && (
            <div className="flex items-center space-x-2 text-rose-450 text-xs font-mono bg-rose-500/10 border border-rose-500/20 p-3 rounded-lg">
              <AlertCircle size={14} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={verifying || !password}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-semibold tracking-wider rounded-xl transition-all cursor-pointer flex items-center justify-center space-x-2 shadow-lg shadow-indigo-650/20"
          >
            {verifying ? (
              <>
                <RefreshCw size={12} className="animate-spin mr-1.5" />
                <span>UNVEILING BLOCK KEYS...</span>
              </>
            ) : (
              <>
                <span>VERIFY SHIELD PASSCODE</span>
                <ChevronRight size={13} />
              </>
            )}
          </button>
        </form>

        <div className="flex items-center justify-center space-x-1.5 text-slate-450 text-center text-[10px] uppercase font-mono select-none font-bold">
          <ShieldCheck size={13} className="text-emerald-400" />
          <span>Zero-Knowledge AES decryption</span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6 animate-in fade-in duration-200">
      
      {/* Upper Status Banner Row */}
      <div className="glass-panel rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 shadow-xl select-none">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center space-x-3 text-xs font-mono">
            {transferState === "transferring" && (
              <span className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold live-pulse">
                ● Sync Active
              </span>
            )}
            {transferState === "complete" && (
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold">
                ✓ All Blocks Compiled
              </span>
            )}
            {transferState === "connecting" && (
              <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold animate-pulse">
                ● Negotiating peer link...
              </span>
            )}
            {transferState === "interrupted" && (
              <span className="bg-rose-500/10 text-rose-400 border border-rose-500/20 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold">
                ⚠ Connection Lost
              </span>
            )}
            <span className="text-slate-400">Locker: <strong className="text-white font-mono">{roomId}</strong></span>
          </div>
          <h1 className="text-base font-extrabold text-white tracking-tight leading-none pt-0.5 font-sans">
            Secure WebRTC Reception Workspace
          </h1>
          <p className="text-xs text-indigo-400/80 font-mono uppercase tracking-wider mt-0.5 font-bold">
            Zero-Knowledge AES-GCM data stream channel
          </p>
        </div>

        {/* Total stats */}
        <div className="flex items-center space-x-3 shrink-0">
          <button
            onClick={() => {
              window.location.hash = "";
            }}
            className="text-xs bg-slate-900/40 hover:bg-slate-900/80 text-indigo-400 hover:text-white border border-brand-border hover:border-indigo-500/30 px-3.5 py-2 rounded-lg font-mono font-bold tracking-wide transition-all shadow-sm cursor-pointer inline-flex items-center uppercase"
            title="Switch roles and drop files back"
          >
            Send Files Back
          </button>
          <span className="text-xs bg-slate-950/40 text-slate-400 font-mono px-3.5 py-2 rounded-lg border border-brand-border">
            Payload files: <strong className="text-white">{roomDetails.files.length}</strong>
          </span>
          {transferState === "transferring" && progress && (
            <span className="text-xs bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono px-3.5 py-2 rounded-lg font-bold animate-pulse">
              Speed: {formatSpeed(progress.speed)}
            </span>
          )}
        </div>
      </div>

      {/* Grid splits */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column */}
        <div className="lg:col-span-7 space-y-6">
          {/* Active Download Files list */}
          <div className="glass-panel rounded-2xl p-6 space-y-4 shadow-xl">
            <h2 className="text-xs font-mono text-indigo-400 flex items-center select-none tracking-wider uppercase font-extrabold">
              <FolderLock size={13} className="mr-2" /> Secured Envelope Payloads
            </h2>

            <div className="space-y-3">
              {roomDetails.files.map((file, idx) => {
                const isActive = progress && progress.fileIndex === idx;
                const isCompiled = compiledFiles.some((f) => f.name === file.name);
                const compiledObj = compiledFiles.find((f) => f.name === file.name);

                return (
                  <div
                    key={idx}
                    className={`border rounded-xl p-4 transition-all duration-150 ${
                      isActive
                        ? "bg-indigo-500/5 border-indigo-500/40 shadow-sm"
                        : isCompiled
                        ? "bg-slate-950/20 border-slate-800"
                        : "bg-slate-950/10 border-slate-900/60"
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div className="min-w-0 pr-4 space-y-1.5">
                        <p className={`text-xs font-semibold truncate flex items-center ${isActive ? "text-indigo-455" : "text-white"}`}>
                          <FileText size={13} className="mr-1.5 shrink-0 text-slate-400" />
                          {file.name}
                        </p>
                        <p className="text-[10px] text-slate-450 font-mono">
                          {formatBytes(file.size)} • {file.type || "binary"}
                        </p>
                      </div>

                      <div className="shrink-0 font-mono text-[10px] select-none">
                        {isCompiled && compiledObj ? (
                          <a
                            href={compiledObj.url}
                            download={compiledObj.name}
                            className="flex items-center text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-md hover:bg-emerald-500 hover:text-white transition-all cursor-pointer font-bold shadow-sm"
                          >
                            <Download size={11} className="mr-1" /> SAVE FILE
                          </a>
                        ) : isActive ? (
                          <span className="text-indigo-400 animate-pulse font-extrabold uppercase tracking-wider block pt-1">
                            BEAMING CHUNKS...
                          </span>
                        ) : (
                          <span className="text-slate-500 uppercase tracking-widest font-bold block pt-1">
                            QUEUED
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Loader Active progress view */}
                    {isActive && progress && (
                      <div className="mt-4 space-y-2">
                        <div className="flex justify-between items-center text-[9.5px] font-mono text-slate-450">
                          <span className="flex items-center">
                            Throughput: <strong className="text-slate-350 ml-1 font-bold">{formatSpeed(progress.speed)}</strong>
                          </span>
                          <span className="font-extrabold text-white">{progress.percent}%</span>
                        </div>

                        <div className="w-full h-1 bg-slate-900 rounded-full overflow-hidden border border-brand-border">
                          <div
                            className="bg-indigo-600 h-1 rounded-full transition-all duration-100"
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>

                        <div className="flex justify-between items-center text-[9.5px] font-mono text-slate-550">
                          <span>{formatBytes(progress.bytesSentOrReceived)} received</span>
                          <span>ETA: {formatTime(progress.eta)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Speed Chart */}
          {(transferState === "transferring" || speedHistory.length > 0) && (
            <div className="glass-panel rounded-2xl p-6 space-y-4 shadow-xl">
              <h2 className="text-xs font-mono text-indigo-400 flex items-center select-none tracking-wider uppercase font-extrabold">
                <Cpu size={13} className="mr-2" /> Throughput bandwidth history
              </h2>
              <div className="w-full h-40">
                <SpeedChart history={speedHistory} />
              </div>
            </div>
          )}
        </div>

        {/* Right Column */}
        <div className="lg:col-span-5 space-y-6">
          {/* logs debug terminal */}
          <div className="glass-panel rounded-2xl p-6 flex flex-col h-[320px] shadow-xl">
            <h2 className="text-xs font-mono text-indigo-400 flex items-center mb-3 select-none tracking-wider font-extrabold uppercase">
              <Terminal size={13} className="mr-2" /> Decryption channel logs
            </h2>

            <div
              ref={logContainerRef}
              className="flex-1 bg-slate-950/60 border border-brand-border rounded-xl p-3.5 font-mono text-[10.5px] text-slate-350 space-y-1.5 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800"
            >
              {logs.length === 0 ? (
                <div className="text-slate-500">Connecting network socket metrics...</div>
              ) : (
                logs.map((log, idx) => (
                  <div key={idx} className="leading-relaxed hover:text-white transition-colors duration-100">
                    <span className="text-indigo-500 select-none mr-2">❯</span>
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Peer to Peer notice client */}
          <div className="glass-panel rounded-2xl p-5 flex items-start space-x-4 shadow-xl">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center text-indigo-400 shrink-0">
              <HeartHandshake size={18} />
            </div>
            <div className="space-y-1 select-none">
              <h3 className="text-[10px] font-extrabold font-mono uppercase tracking-wider text-slate-300">P2P Cryptographic link</h3>
              <p className="text-[11px] text-slate-450 leading-relaxed">
                Data packet blocks stream directly between user browser memory pools. Senders decrypt segments client-side. No intermediate payload bytes land on any server disk.
              </p>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
