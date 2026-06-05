/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from "react";
import { 
  Share2, 
  Copy, 
  Check, 
  UserCheck, 
  Terminal, 
  Cpu, 
  Clock, 
  RefreshCw,
  FileCheck2,
  Lock,
  Unlock,
  AlertCircle
} from "lucide-react";
import SpeedChart from "./SpeedChart";
import { TransferProgress } from "../types";
import { formatSpeed, formatTime } from "../utils/webrtc-helper";

interface LockerDashboardProps {
  roomId: string;
  expiresAt: number;
  maxDownloads: number;
  downloadCount: number;
  rawPassword?: string;
  shareUrl: string;
  logs: string[];
  activePeers: Map<string, string>; // peerId -> status
  peerProgressList: Map<string, TransferProgress>; // peerId -> progress
  onShutdown: () => void;
}

export default function LockerDashboard({
  roomId,
  expiresAt,
  maxDownloads,
  downloadCount,
  rawPassword,
  shareUrl,
  logs,
  activePeers,
  peerProgressList,
  onShutdown,
}: LockerDashboardProps) {
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string>("calculating...");
  const [speedHistory, setSpeedHistory] = useState<number[]>([]);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // Copy share URL with fallback
  const copyShareLink = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const input = document.createElement("input");
        input.value = shareUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Hard fail silent
    }
  };

  // countdown timer
  useEffect(() => {
    const updateCountdown = () => {
      const diff = expiresAt - Date.now();
      if (diff <= 0) {
        setTimeLeft("Expired");
        return;
      }
      const totalSecs = Math.floor(diff / 1000);
      const hours = Math.floor(totalSecs / 3600);
      const mins = Math.floor((totalSecs % 3600) / 60);
      const secs = totalSecs % 60;

      let fmt = "";
      if (hours > 0) fmt += `${hours}h `;
      fmt += `${mins}m ${secs}s`;
      setTimeLeft(fmt);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  // Track speed
  useEffect(() => {
    const monitorSpeed = setInterval(() => {
      let maxCurrentSpeed = 0;
      for (const progress of peerProgressList.values()) {
        if (progress.status === "transferring") {
          maxCurrentSpeed = Math.max(maxCurrentSpeed, progress.speed);
        }
      }

      setSpeedHistory((prev) => {
        const updated = [...prev, maxCurrentSpeed];
        if (updated.length > 50) {
          updated.shift();
        }
        return updated;
      });
    }, 1000);

    return () => clearInterval(monitorSpeed);
  }, [peerProgressList]);

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6 animate-in fade-in duration-200">
      
      {/* Top Banner Control Board */}
      <div className="glass-panel rounded-2xl p-6 shadow-xl grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
        <div className="md:col-span-8 space-y-1.5 select-none">
          <div className="flex items-center space-x-3">
            <span className="text-[9px] font-mono bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-semibold live-pulse">
              ● Vault Active
            </span>
            <span className="text-xs font-mono text-slate-400">
              Room Identifier: <strong className="text-indigo-400 font-mono select-all">{roomId}</strong>
            </span>
          </div>
          <h1 className="text-base font-extrabold text-white tracking-tight leading-none pt-0.5">
            Cryptographic P2P Stream Active
          </h1>
          <p className="text-xs text-slate-400 leading-relaxed max-w-[550px]">
            Keep this tab open. Connected receivers will verify credentials and pull encrypted files directly from your browser memory.
          </p>
        </div>

        <div className="md:col-span-4 flex flex-col md:items-end justify-center select-none">
          <button
            onClick={onShutdown}
            className="w-full md:w-auto px-4.5 py-2.5 rounded-xl border border-rose-500/25 bg-rose-500/10 hover:bg-rose-500 text-rose-350 hover:text-white font-mono text-xs font-bold tracking-wider transition-all cursor-pointer shadow-sm hover:shadow-rose-500/10"
          >
            DISMISS VAULT
          </button>
        </div>
      </div>

      {/* Main Grid split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Col */}
        <div className="lg:col-span-7 space-y-6">
          {/* Share Link Widget */}
          <div className="glass-panel rounded-2xl p-6 space-y-4 shadow-xl">
            <div>
              <h2 className="text-xs font-mono text-indigo-400 flex items-center select-none tracking-wider font-extrabold uppercase">
                <Share2 size={13} className="mr-2 text-indigo-400 animate-pulse" /> Vault Access URL
              </h2>
              <p className="text-xs text-slate-400 mt-1 select-none leading-normal">
                Share this link with receivers. The AES decryption key is contained inside the URL hash and is never exposed to the server.
              </p>
            </div>

            <div className="flex items-center space-x-2 bg-slate-950/40 border border-brand-border rounded-xl p-2 min-w-0">
              <input
                type="text"
                readOnly
                value={shareUrl}
                className="flex-1 bg-transparent border-none text-[11.5px] text-slate-300 font-mono px-3 py-1.5 outline-none select-all truncate selection:bg-indigo-600/40"
              />
              <button
                onClick={copyShareLink}
                className={`px-4.5 py-2 rounded-lg font-mono text-[10px] font-bold cursor-pointer tracking-widest flex items-center space-x-1.5 shrink-0 transition-all ${
                  copied
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25"
                    : "bg-indigo-600 hover:bg-indigo-500 text-white"
                }`}
              >
                {copied ? <Check size={12} /> : <Copy size={11} />}
                <span>{copied ? "COPIED" : "COPY LINK"}</span>
              </button>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-4 bg-slate-950/20 border border-brand-border rounded-xl p-4">
              <div className="bg-white p-1.5 rounded-lg shrink-0">
                <img 
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(shareUrl)}`} 
                  alt="Locker QR Code" 
                  className="w-24 h-24 block"
                />
              </div>
              <div className="space-y-1 text-center sm:text-left select-none">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">Scan with Camera</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Open the camera on your smartphone or tablet, scan this QR code, and open the link to start downloading immediately.
                </p>
              </div>
            </div>

            {/* Quick Lock Details */}
            <div className="grid grid-cols-3 gap-3 pt-1 select-none">
              <div className="bg-slate-900/20 rounded-xl border border-brand-border p-3 text-center">
                <div className="text-[9px] font-mono text-slate-400 uppercase tracking-widest font-bold">Expires in</div>
                <div className="text-xs font-mono text-slate-350 mt-1.5 font-extrabold flex items-center justify-center">
                  <Clock size={12} className="mr-1 text-indigo-400" />
                  {timeLeft}
                </div>
              </div>
              <div className="bg-slate-900/20 rounded-xl border border-brand-border p-3 text-center">
                <div className="text-[9px] font-mono text-slate-400 uppercase tracking-widest font-bold">Quota limit</div>
                <div className="text-xs font-mono text-slate-350 mt-1.5 font-extrabold">
                  {downloadCount} / {maxDownloads === 100 ? "∞" : maxDownloads} DLs
                </div>
              </div>
              <div className="bg-slate-900/20 rounded-xl border border-brand-border p-3 text-center">
                <div className="text-[9px] font-mono text-slate-400 uppercase tracking-widest font-bold">Shield type</div>
                <div className="text-xs font-mono text-slate-350 mt-1.5 font-extrabold truncate px-1 flex items-center justify-center gap-1">
                  {rawPassword ? (
                    <>
                      <Lock size={11} className="text-indigo-400" /> PIN Lock
                    </>
                  ) : (
                    <>
                      <Unlock size={11} className="text-slate-400" /> Hash Key
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Speed chart widget */}
          <div className="glass-panel rounded-2xl p-6 space-y-4 shadow-xl">
            <div className="flex justify-between items-center select-none">
              <h2 className="text-xs font-mono text-indigo-400 flex items-center font-extrabold tracking-wider uppercase">
                <Cpu size={13} className="mr-2" /> Live Upload Bandwidth
              </h2>
              {speedHistory.length > 0 && speedHistory[speedHistory.length - 1] > 0 ? (
                <span className="text-[11px] font-mono text-indigo-400 font-bold animate-pulse">
                  Streaming • {formatSpeed(speedHistory[speedHistory.length - 1])}
                </span>
              ) : (
                <span className="text-[10px] font-mono text-slate-450">Idle (0 B/s)</span>
              )}
            </div>

            <div className="w-full h-40">
              <SpeedChart history={speedHistory} />
            </div>
          </div>
        </div>

        {/* Right Col */}
        <div className="lg:col-span-5 space-y-6">
          {/* Active Discovered Peers */}
          <div className="glass-panel rounded-2xl p-6 space-y-4 shadow-xl flex flex-col min-h-[170px]">
            <h2 className="text-xs font-mono text-indigo-400 flex items-center select-none tracking-wider font-extrabold uppercase">
              <UserCheck size={13} className="mr-2" /> Connected Receivers ({activePeers.size})
            </h2>

            {activePeers.size === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-450 text-center py-6 select-none">
                <RefreshCw size={22} className="animate-spin text-indigo-500/50 mb-3" />
                <p className="text-[10px] font-bold uppercase font-mono tracking-widest text-indigo-400/80">Listening for connections</p>
                <p className="text-[9px] font-mono text-slate-500 mt-1 leading-normal">Room signaling is open. Broadcast channel ready.</p>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[160px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                {Array.from(activePeers.entries()).map(([peerId, status]) => {
                  const progress = peerProgressList.get(peerId);
                  const pct = progress ? progress.percent : 0;

                  return (
                    <div
                      key={peerId}
                      className="bg-slate-900/30 border border-brand-border rounded-xl p-3.5 space-y-2.5"
                    >
                      <div className="flex justify-between items-center text-xs font-mono select-none">
                        <span className="text-slate-350 font-bold">
                          rx-{peerId.substring(9, 13)}
                        </span>
                        <span className={`text-[8.5px] tracking-widest font-black px-2 py-0.5 rounded border uppercase ${
                          status === "connected"
                            ? "bg-indigo-500/10 border-indigo-500/25 text-indigo-400 glow-box"
                            : "bg-amber-500/10 border-amber-500/25 text-amber-400"
                        }`}>
                          {status}
                        </span>
                      </div>

                      {progress && progress.status === "transferring" && (
                        <div className="space-y-2 font-mono text-[10px]">
                          <div className="flex justify-between text-slate-400">
                            <span className="truncate pr-4 font-sans text-xs">{progress.fileName}</span>
                            <span className="text-white font-bold">{pct}%</span>
                          </div>
                          
                          <div className="w-full bg-slate-950 rounded-full h-1 overflow-hidden border border-brand-border">
                            <div 
                              className="bg-indigo-650 h-1 rounded-full transition-all duration-300"
                              style={{ width: `${pct}%` }}
                            />
                          </div>

                          <div className="flex justify-between text-[9px] text-slate-500">
                            <span>{formatSpeed(progress.speed)}</span>
                            <span>ETA: {formatTime(progress.eta)}</span>
                          </div>
                        </div>
                      )}

                      {status === "closed" && (
                        <p className="text-[9.5px] text-emerald-400 font-mono text-right flex items-center justify-end font-medium">
                          <FileCheck2 size={11} className="mr-1" /> Transfer Complete
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* WebRTC Gateway Terminal Monitor */}
          <div className="glass-panel rounded-2xl p-6 flex flex-col h-[270px] shadow-xl">
            <h2 className="text-xs font-mono text-indigo-400 flex items-center mb-3 select-none tracking-wider font-extrabold uppercase">
              <Terminal size={13} className="mr-2" /> Server Signaling journal
            </h2>

            <div
              ref={logContainerRef}
              className="flex-1 bg-slate-950/60 border border-brand-border rounded-xl p-3.5 font-mono text-[10.5px] text-slate-350 space-y-1.5 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800"
            >
              {logs.length === 0 ? (
                <div className="text-slate-500">Initializing operator system journal...</div>
              ) : (
                logs.map((log, idx) => (
                  <div key={idx} className="leading-normal hover:text-white transition-colors duration-100">
                    <span className="text-indigo-500 select-none mr-2">❯</span>
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
