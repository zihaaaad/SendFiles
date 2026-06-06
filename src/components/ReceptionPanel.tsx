/**
 * @license
 * SPDX-License-Identifier: Apache-2.5
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  Lock, 
  Key, 
  ChevronRight, 
  RefreshCw, 
  ShieldCheck, 
  Download, 
  AlertCircle, 
  HeartHandshake,
  FolderLock,
  FileText
} from "lucide-react";
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
  const [compiledFiles, setCompiledFiles] = useState<{ name: string; url: string; size: number }[]>([]);

  const receiverRef = useRef<P2PReceiver | null>(null);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
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
        setErrorMsg(err.error || "Incorrect locker PIN/Password.");
      }
    } catch {
      setErrorMsg("Failed verifying locker passcode credentials.");
    } finally {
      setVerifying(false);
    }
  };

  // Launch receiver engine once verified
  useEffect(() => {
    if (!useVerified) return;
    
    const receiver = new P2PReceiver(roomId, encryptionKeyHex);
    receiverRef.current = receiver;

    receiver.onStatusChange = (status) => {
      setTransferState(status);
    };

    receiver.onProgress = (prog) => {
      setProgress(prog);
    };

    receiver.onFilesCompiled = (list) => {
      setCompiledFiles(list);
    };

    receiver.start();

    return () => {
      receiver.stop();
    };
  }, [useVerified, roomId, encryptionKeyHex]);

  // Security Verification entry screen (Password Required)
  if (!useVerified && roomDetails.hasPassword) {
    return (
      <div className="w-full max-w-md mx-auto glass-panel p-6 rounded-2xl shadow-xl space-y-5 animate-in zoom-in-95 duration-200">
        <div className="text-center space-y-1.5 select-none">
          <div className="w-12 h-12 bg-[#265c34]/10 border border-[#265c34]/20 rounded-xl flex items-center justify-center text-[#265c34] mx-auto mb-3 shadow-inner">
            <Lock size={20} />
          </div>
          <h2 className="text-sm font-bold text-slate-800 tracking-tight">Passcode Required</h2>
          <p className="text-[11px] text-slate-500 font-mono">
            Enter the PIN/Password to access and decrypt this secure locker.
          </p>
        </div>

        <form onSubmit={handleVerifyPassword} className="space-y-4">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
              <Key size={14} />
            </span>
            <input
              type="password"
              placeholder="Enter locker passcode PIN..."
              required
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-100 focus:bg-white text-xs text-slate-800 border border-brand-border/60 focus:border-[#265c34] focus:ring-1 focus:ring-[#265c34]/10 rounded-xl pl-9 pr-4 py-2.5 outline-none transition-all placeholder:text-slate-450 font-mono"
            />
          </div>

          {errorMsg && (
            <div className="flex items-center space-x-2 text-rose-700 text-xs font-mono bg-rose-50 border border-rose-200 p-3 rounded-lg">
              <AlertCircle size={14} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={verifying || !password}
            className="w-full py-3 bg-[#265c34] hover:bg-[#347442] text-white font-mono text-xs font-semibold tracking-wider rounded-xl transition-all cursor-pointer flex items-center justify-center space-x-2 shadow-lg hover:shadow-[#265c34]/25"
          >
            {verifying ? (
              <>
                <RefreshCw size={12} className="animate-spin mr-1.5" />
                <span>DECRYPTING VAULT...</span>
              </>
            ) : (
              <>
                <span>VERIFY PASSCODE</span>
                <ChevronRight size={13} />
              </>
            )}
          </button>
        </form>

        <div className="flex items-center justify-center space-x-1.5 text-slate-500 text-center text-[9px] uppercase font-mono select-none font-bold">
          <ShieldCheck size={12} className="text-[#265c34]" />
          <span>Zero-Knowledge AES Decryption</span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto space-y-5 animate-in fade-in duration-200">
      
      {/* Upper Status Banner Row */}
      <div className="glass-panel rounded-xl p-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-md select-none">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center space-x-2 text-xs font-mono">
            {transferState === "transferring" && (
              <span className="bg-[#265c34]/10 text-[#265c34] border border-[#265c34]/20 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold live-pulse">
                ● Syncing
              </span>
            )}
            {transferState === "complete" && (
              <span className="bg-emerald-100 text-emerald-800 border border-emerald-200 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold">
                ✓ Compiled
              </span>
            )}
            {transferState === "connecting" && (
              <span className="bg-amber-100 text-amber-800 border border-amber-200 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold animate-pulse">
                ● Connecting...
              </span>
            )}
            {transferState === "interrupted" && (
              <span className="bg-rose-100 text-rose-800 border border-rose-200 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold">
                ⚠ Offline
              </span>
            )}
            <span className="text-slate-500">Locker ID: <strong className="text-slate-800 font-mono">{roomId}</strong></span>
          </div>
          <h1 className="text-xs font-bold text-slate-800 tracking-tight leading-none pt-0.5 uppercase">
            Secure Locker Reception
          </h1>
        </div>

        {/* Total stats */}
        <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
          <button
            onClick={() => {
              window.location.hash = "";
            }}
            className="text-[10px] bg-[#265c34]/10 hover:bg-[#265c34] text-[#265c34] hover:text-white border border-[#265c34]/20 hover:border-[#265c34] px-3.5 py-2 rounded-lg font-mono font-bold tracking-wide transition-all cursor-pointer uppercase"
          >
            Send Files Back
          </button>
          <span className="text-[10px] bg-[#265c34]/5 text-slate-600 font-mono px-3.5 py-2 rounded-lg border border-[#265c34]/15">
            Files: <strong className="text-slate-800">{roomDetails.files.length}</strong>
          </span>
        </div>
      </div>

      {/* Payloads List */}
      <div className="glass-panel rounded-xl p-4.5 space-y-3 shadow-md">
        <h2 className="text-xs font-mono text-[#265c34] flex items-center select-none tracking-wider uppercase font-bold">
          <FolderLock size={13} className="mr-2" /> Envelope Contents
        </h2>

        <div className="space-y-3">
          {roomDetails.files.map((file, idx) => {
            const isActive = progress && progress.fileIndex === idx;
            const isCompiled = compiledFiles.some((f) => f.name === file.name);
            const compiledObj = compiledFiles.find((f) => f.name === file.name);

            return (
              <div
                key={idx}
                className={`border rounded-xl p-3.5 transition-all duration-150 ${
                  isActive
                    ? "bg-[#265c34]/5 border-[#265c34]/30 shadow-sm"
                    : isCompiled
                    ? "bg-[#265c34]/5 border-slate-200"
                    : "bg-slate-50 border-slate-200/80"
                }`}
              >
                <div className="flex justify-between items-start">
                  <div className="min-w-0 pr-4 space-y-1">
                    <p className={`text-xs font-bold truncate flex items-center ${isActive ? "text-[#265c34]" : "text-slate-800"}`}>
                      <FileText size={13} className="mr-1.5 shrink-0 text-slate-500" />
                      {file.name}
                    </p>
                    <p className="text-[9.5px] text-slate-500 font-mono">
                      {formatBytes(file.size)} • {file.type || "binary"}
                    </p>
                  </div>

                  <div className="shrink-0 font-mono text-[10px] select-none">
                    {isCompiled && compiledObj ? (
                      <a
                        href={compiledObj.url}
                        download={compiledObj.name}
                        className="flex items-center text-emerald-800 bg-emerald-50 border border-emerald-250 px-3 py-1.5 rounded-lg hover:bg-emerald-600 hover:text-white transition-all cursor-pointer font-bold shadow-sm"
                      >
                        <Download size={11} className="mr-1" /> SAVE FILE
                      </a>
                    ) : isActive ? (
                      <span className="text-[#265c34] animate-pulse font-bold uppercase tracking-wider block pt-1 text-[9.5px]">
                        DOWNLOADING...
                      </span>
                    ) : (
                      <span className="text-slate-450 uppercase tracking-wider font-bold block pt-1 text-[9px]">
                        QUEUED
                      </span>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                {isActive && progress && (
                  <div className="mt-3 space-y-1.5">
                    <div className="flex justify-between items-center text-[9px] font-mono text-slate-500">
                      <span className="flex items-center">
                        Speed: <strong className="text-slate-700 ml-1 font-bold">{formatSpeed(progress.speed)}</strong>
                      </span>
                      <span className="font-bold text-slate-800">{progress.percent}%</span>
                    </div>

                    <div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden border border-brand-border">
                      <div
                        className="bg-[#265c34] h-1 rounded-full transition-all duration-100"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </div>

                    <div className="flex justify-between items-center text-[8.5px] font-mono text-slate-500">
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

      {/* Info panel */}
      <div className="glass-panel rounded-xl p-4.5 flex items-start space-x-3 shadow-md">
        <div className="w-8 h-8 rounded-lg bg-[#265c34]/10 border border-[#265c34]/20 flex items-center justify-center text-[#265c34] shrink-0">
          <HeartHandshake size={15} />
        </div>
        <div className="space-y-0.5 select-none min-w-0">
          <h3 className="text-[10px] font-bold font-mono uppercase tracking-wider text-slate-600">Direct Peer-to-Peer</h3>
          <p className="text-[10.5px] text-slate-600 leading-relaxed">
            Files are decrypted in your browser and sent directly from the sender. They are never saved or stored on any server.
          </p>
        </div>
      </div>
    </div>
  );
}
