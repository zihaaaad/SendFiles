/**
 * @license
 * SPDX-License-Identifier: Apache-2.5
 */

import { useState, useEffect } from "react";
import { 
  Share2, 
  Copy, 
  Check, 
  UserCheck, 
  Clock, 
  RefreshCw,
  FileCheck2,
  Lock,
  Unlock
} from "lucide-react";
import { TransferProgress } from "../types";
import { formatSpeed, formatTime } from "../utils/webrtc-helper";
import QRCode from "qrcode";

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
  activePeers,
  peerProgressList,
  onShutdown,
}: LockerDashboardProps) {
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string>("calculating...");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>("");

  useEffect(() => {
    QRCode.toDataURL(shareUrl, { margin: 1, width: 150 })
      .then(setQrCodeDataUrl)
      .catch((err) => console.error("Failed to generate QR code locally:", err));
  }, [shareUrl]);

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

  return (
    <div className="w-full max-w-2xl mx-auto space-y-5 animate-in fade-in duration-200">
      
      {/* Top Banner Control Board */}
      <div className="glass-panel rounded-xl p-4.5 shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1 select-none min-w-0">
          <div className="flex items-center space-x-2.5">
            <span className="text-[9px] font-mono bg-[#265c34]/10 text-[#265c34] border border-[#265c34]/20 px-2.5 py-0.5 rounded-full uppercase tracking-wider font-bold live-pulse">
              ● Active
            </span>
            <span className="text-[10px] font-mono text-slate-600 truncate">
              Room ID: <strong className="text-[#265c34] font-mono select-all">{roomId}</strong>
            </span>
          </div>
          <h1 className="text-xs font-bold text-slate-800 tracking-tight leading-none pt-0.5 uppercase">
            P2P Stream Active
          </h1>
        </div>

        <button
          onClick={onShutdown}
          className="w-full sm:w-auto px-4 py-2 rounded-lg border border-rose-500/20 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 hover:text-rose-700 font-mono text-[10px] font-bold tracking-wider transition-all cursor-pointer text-center uppercase"
        >
          Close Locker
        </button>
      </div>

      {/* Share Link Widget */}
      <div className="glass-panel rounded-xl p-4.5 space-y-4 shadow-md">
        <div className="select-none">
          <h2 className="text-xs font-mono text-[#265c34] flex items-center tracking-wider font-bold uppercase">
            <Share2 size={13} className="mr-2 text-[#265c34] live-pulse" /> Locker Link
          </h2>
          <p className="text-[11px] text-slate-655 mt-1 leading-relaxed">
            The encryption key is embedded in the link and stays private in your browser.
          </p>
        </div>

        <div className="flex items-center space-x-2 bg-slate-100 border border-brand-border rounded-xl p-2 min-w-0">
          <input
            type="text"
            readOnly
            value={shareUrl}
            className="flex-1 bg-transparent border-none text-[11px] text-slate-700 font-mono px-2 py-1 outline-none select-all truncate selection:bg-[#265c34]/20"
          />
          <button
            onClick={copyShareLink}
            className={`px-3 py-1.5 rounded-lg font-mono text-[9px] font-bold cursor-pointer tracking-widest flex items-center space-x-1.5 shrink-0 transition-all ${
              copied
                ? "bg-emerald-100 text-emerald-800 border border-emerald-250"
                : "bg-[#265c34] hover:bg-[#347442] text-white"
            }`}
          >
            {copied ? <Check size={11} /> : <Copy size={10} />}
            <span>{copied ? "COPIED" : "COPY LINK"}</span>
          </button>
        </div>

        {/* QR Code */}
        <div className="flex flex-col sm:flex-row items-center gap-4 bg-[#265c34]/5 border border-brand-border/60 rounded-xl p-3.5">
          <div className="bg-white p-1 rounded-lg shrink-0 border border-slate-200 shadow-sm">
            {qrCodeDataUrl ? (
              <img 
                src={qrCodeDataUrl} 
                alt="Locker QR Code" 
                className="w-20 h-20 block"
              />
            ) : (
              <div className="w-20 h-20 bg-slate-100 animate-pulse rounded-lg" />
            )}
          </div>
          <div className="space-y-1 text-center sm:text-left select-none">
            <h4 className="text-[11px] font-bold text-slate-800 uppercase tracking-wider">Scan with phone camera</h4>
            <p className="text-[10.5px] text-slate-600 leading-normal font-medium">
              Scan this code from another phone's camera to connect and download immediately.
            </p>
          </div>
        </div>

        {/* Quick Lock Details */}
        <div className="grid grid-cols-3 gap-2.5 pt-1 select-none">
          <div className="bg-slate-50 rounded-xl border border-brand-border/60 p-2.5 text-center">
            <div className="text-[8px] font-mono text-slate-500 uppercase tracking-widest font-bold">Time Left</div>
            <div className="text-[10px] font-mono text-slate-800 mt-1 font-bold flex items-center justify-center">
              <Clock size={11} className="mr-1 text-[#265c34]" />
              {timeLeft}
            </div>
          </div>
          <div className="bg-slate-50 rounded-xl border border-brand-border/60 p-2.5 text-center">
            <div className="text-[8px] font-mono text-slate-500 uppercase tracking-widest font-bold">Downloads</div>
            <div className="text-[10px] font-mono text-slate-800 mt-1 font-bold">
              {downloadCount} / {maxDownloads === 100 ? "∞" : maxDownloads}
            </div>
          </div>
          <div className="bg-slate-50 rounded-xl border border-brand-border/60 p-2.5 text-center">
            <div className="text-[8px] font-mono text-slate-500 uppercase tracking-widest font-bold">Security</div>
            <div className="text-[10px] font-mono text-slate-800 mt-1 font-bold truncate px-1 flex items-center justify-center gap-1">
              {rawPassword ? (
                <>
                  <Lock size={10} className="text-[#265c34]" /> PIN Lock
                </>
              ) : (
                <>
                  <Unlock size={10} className="text-slate-400" /> Hash Key
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Active Discovered Peers & Progress */}
      <div className="glass-panel rounded-xl p-4.5 space-y-3.5 shadow-md">
        <h2 className="text-xs font-mono text-[#265c34] flex items-center select-none tracking-wider font-bold uppercase">
          <UserCheck size={13} className="mr-2" /> Connected Devices ({activePeers.size})
        </h2>

        {activePeers.size === 0 ? (
          <div className="flex flex-col items-center justify-center text-slate-500 text-center py-6 select-none">
            <RefreshCw size={18} className="animate-spin text-[#265c34]/30 mb-2" />
            <p className="text-[9px] font-bold uppercase font-mono tracking-widest text-[#265c34]">Waiting for receiver...</p>
            <p className="text-[8.5px] font-mono text-slate-500 mt-0.5 leading-normal">Keep this page open. Keep your device online.</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-200">
            {Array.from(activePeers.entries()).map(([peerId, status]) => {
              const progress = peerProgressList.get(peerId);
              const pct = progress ? progress.percent : 0;

              return (
                <div
                  key={peerId}
                  className="bg-[#265c34]/5 border border-[#265c34]/15 rounded-xl p-3 space-y-2"
                >
                  <div className="flex justify-between items-center text-[10px] font-mono select-none">
                    <span className="text-slate-700 font-bold">
                      Receiver {peerId.substring(9, 13)}
                    </span>
                    <span className={`text-[8px] tracking-wider font-bold px-1.5 py-0.5 rounded border uppercase ${
                      status === "connected"
                        ? "bg-[#265c34]/10 border-[#265c34]/20 text-[#265c34] glow-box"
                        : "bg-amber-100 border-amber-250 text-amber-800"
                    }`}>
                      {status}
                    </span>
                  </div>

                  {progress && progress.status === "transferring" && (
                    <div className="space-y-1.5 font-mono text-[9.5px]">
                      <div className="flex justify-between text-slate-600">
                        <span className="truncate pr-4 font-sans text-[10.5px]">{progress.fileName}</span>
                        <span className="text-slate-800 font-bold">{pct}%</span>
                      </div>
                      
                      <div className="w-full bg-slate-200 rounded-full h-1 overflow-hidden border border-brand-border">
                        <div 
                          className="bg-[#265c34] h-1 rounded-full transition-all duration-300"
                          style={{ width: `${pct}%` }}
                        />
                      </div>

                      <div className="flex justify-between items-center text-[8px] text-slate-500">
                        <span>Speed: {formatSpeed(progress.speed)}</span>
                        {progress.connectionType && (
                          <span className={`px-1 rounded text-[7px] font-bold uppercase ${
                            progress.connectionType === "Direct" ? "bg-emerald-100 text-emerald-800 border border-emerald-250" : "bg-purple-100 text-purple-800 border border-purple-250"
                          }`}>
                            {progress.connectionType}
                          </span>
                        )}
                        <span>ETA: {formatTime(progress.eta)}</span>
                      </div>
                    </div>
                  )}

                  {status === "closed" && (
                    <p className="text-[9px] text-[#265c34] font-mono text-right flex items-center justify-end font-bold uppercase">
                      <FileCheck2 size={11} className="mr-1" /> Transfer Complete
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
