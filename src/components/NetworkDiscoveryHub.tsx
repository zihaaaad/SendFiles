/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { 
  Radio, 
  Search, 
  ArrowRight, 
  Globe, 
  Clock, 
  FileText, 
  HelpCircle,
  Unlink,
  ExternalLink,
  Lock,
  KeyRound,
  AlertCircle,
  RefreshCw
} from "lucide-react";

interface DiscoveredRoom {
  roomId: string;
  hasPassword?: boolean;
  expiresAt: number;
  maxDownloads: number;
  downloadCount: number;
  files: {
    name: string;
    size: number;
    type: string;
  }[];
}

interface NetworkDiscoveryHubProps {
  onJoinRoom: (roomId: string, keyHex: string) => void;
}

export default function NetworkDiscoveryHub({ onJoinRoom }: NetworkDiscoveryHubProps) {
  const [rooms, setRooms] = useState<DiscoveredRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [joinValue, setJoinValue] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [selectedRoom, setSelectedRoom] = useState<DiscoveredRoom | null>(null);
  const [promptKeyError, setPromptKeyError] = useState("");

  const fetchRooms = async () => {
    try {
      const res = await fetch("/api/rooms");
      if (res.ok) {
        const data = await res.json();
        setRooms(data);
      }
    } catch {
      // Quiet fail to keep dashboard clean
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRooms();
    const interval = setInterval(fetchRooms, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleManualJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinValue.trim()) return;

    const trimmed = joinValue.trim();
    let rId = "";
    let kHex = "";

    // Check if user pasted complete shared URL style: http://domain/#/locker/ABC#key=XYZ
    if (trimmed.includes("#key=")) {
      const keyIdx = trimmed.indexOf("#key=");
      kHex = trimmed.substring(keyIdx + 5);
      
      const beforeKey = trimmed.substring(0, keyIdx);
      const parts = beforeKey.split("/");
      rId = parts[parts.length - 1];
    } else if (trimmed.includes("?key=")) {
      const parts = trimmed.split("?key=");
      const left = parts[0].split("/");
      rId = left[left.length - 1];
      kHex = parts[1];
    } else {
      // Assume just the Room ID itself is passed
      rId = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "");
    }

    if (!rId) {
      setErrorMsg("Could not parse Room ID or Share Link.");
      return;
    }

    onJoinRoom(rId, kHex);
  };

  const handleJoinDiscovered = (room: DiscoveredRoom) => {
    setSelectedRoom(room);
    setPromptKeyError("");
    setKeyInput("");
  };

  const handleConfirmDiscoveredJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRoom) return;

    if (!keyInput.trim()) {
      setPromptKeyError("Decryption hex key is required to open zero-knowledge envelopes.");
      return;
    }

    let cleanKey = keyInput.trim();
    if (cleanKey.includes("key=")) {
      cleanKey = cleanKey.split("key=")[1];
    }

    onJoinRoom(selectedRoom.roomId, cleanKey);
    setSelectedRoom(null);
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const formatTimeout = (expiresAt: number): string => {
    const diff = expiresAt - Date.now();
    if (diff <= 0) return "Expired";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m left`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m left`;
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      
      {/* Manual Unlock Widget */}
      <div className="glass-panel rounded-2xl p-6 shadow-xl">
        <h3 className="text-xs font-mono text-[#7bd18f] uppercase tracking-wider font-extrabold mb-3 flex items-center">
          <KeyRound size={13} className="mr-2" /> Connect manually to secure locker
        </h3>
        <p className="text-xs text-slate-450 mb-4 leading-normal select-none">
          Shared locker links contain the client decryption key in the hash chunk. Paste the complete link or input the Room Code below to sync.
        </p>

        <form onSubmit={handleManualJoin} className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-450">
              <Search size={14} />
            </span>
            <input
              type="text"
              placeholder="Paste shared URL (e.g. app/#/locker/ID#key=HEX) or Room Code..."
              value={joinValue}
              onChange={(e) => {
                setJoinValue(e.target.value);
                setErrorMsg("");
              }}
              className="w-full bg-slate-950/40 focus:bg-slate-950/60 text-xs text-white border border-brand-border focus:border-[#5eb075] focus:ring-1 focus:ring-[#5eb075]/10 rounded-xl pl-9.5 pr-4 py-3 outline-none transition-all placeholder:text-slate-500 font-mono"
            />
          </div>

          <button
            type="submit"
            className="px-6 py-3 bg-[#265c34] hover:bg-[#347442] text-white text-xs font-mono font-bold tracking-widest rounded-xl transition-all cursor-pointer flex items-center justify-center space-x-1.5 shrink-0 shadow-lg hover:shadow-[#265c34]/15"
          >
            <span>CONNECT</span>
            <ArrowRight size={13} />
          </button>
        </form>

        {errorMsg && (
          <div className="mt-3 flex items-center space-x-2 text-rose-450 text-xs font-mono bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-lg select-none">
            <AlertCircle size={13} />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {/* Discovered Locker List */}
      <div className="glass-panel rounded-2xl p-6 shadow-xl flex flex-col min-h-[300px]">
        <div className="flex justify-between items-center mb-4 select-none">
          <h3 className="text-xs font-mono text-[#7bd18f] uppercase tracking-wider font-extrabold flex items-center">
            <Radio size={13} className="mr-2 live-pulse" /> Active Local Network Lockers ({rooms.length})
          </h3>
          <button
            onClick={fetchRooms}
            type="button"
            className="text-[10px] uppercase font-mono text-slate-450 hover:text-[#7bd18f] flex items-center cursor-pointer font-bold transition-colors"
          >
            <RefreshCw size={10} className="mr-1.5" /> refresh
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center py-10 select-none">
            <span className="w-5 h-5 border-2 border-slate-700 border-t-[#265c34] rounded-full animate-spin"></span>
            <span className="text-[10px] font-mono text-slate-400 mt-2.5 uppercase tracking-widest leading-none font-bold">Scanning local directory...</span>
          </div>
        ) : rooms.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-14 text-center border border-dashed border-slate-800 rounded-xl bg-slate-900/5 select-none">
            <Unlink size={20} className="text-slate-600 mb-2.5" />
            <span className="text-[10.5px] font-mono font-bold text-slate-400 uppercase tracking-widest">No Active Lockers Discovered</span>
            <span className="text-[9.5px] font-mono text-slate-500 max-w-[280px] mt-1.5 leading-normal">
              Active lockers created on this network node will show up here automatically. Create a locker to begin broadcasting.
            </span>
          </div>
        ) : (
          <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-850">
            {rooms.map((room) => {
              const totalSize = room.files.reduce((acc, f) => acc + f.size, 0);

              return (
                <div
                  key={room.roomId}
                  className="bg-slate-900/10 hover:bg-slate-900/30 border border-brand-border hover:border-slate-700 rounded-xl p-4 transition-all duration-150 flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2.5 flex-wrap text-xs select-none">
                      <span className="font-mono bg-[#265c34]/15 border border-[#265c34]/25 text-[#7bd18f] px-2 py-0.5 rounded-md font-bold text-[10px] tracking-wider">
                        VAULT {room.roomId}
                      </span>
                      {room.hasPassword && (
                        <span className="font-mono bg-amber-500/10 border border-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded text-[9.5px] font-bold flex items-center tracking-wider">
                          <Lock size={9} className="mr-1" /> PASSWORD REQ
                        </span>
                      )}
                      <span className="font-mono text-slate-455 text-[10.5px] flex items-center font-bold">
                        <Clock size={11} className="mr-1 text-slate-500" /> {formatTimeout(room.expiresAt)}
                      </span>
                    </div>

                    <div className="text-[11.5px] text-slate-455 font-mono flex items-center flex-wrap gap-x-3 gap-y-1">
                      <span className="text-slate-200 font-semibold truncate max-w-[210px] md:max-w-[290px]">
                        📁 {room.files[0]?.name || "Attachment"} {room.files.length > 1 && `+${room.files.length - 1} files`}
                      </span>
                      <span className="text-slate-600 hidden md:inline">•</span>
                      <span className="text-slate-400 font-bold">{formatBytes(totalSize)}</span>
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center">
                    <button
                      onClick={() => handleJoinDiscovered(room)}
                      className="w-full md:w-auto px-4 py-2 hover:py-2.1 bg-[#265c34]/15 hover:bg-[#265c34] text-[#7bd18f] hover:text-white border border-[#265c34]/25 hover:border-[#265c34] font-mono text-[10px] font-bold tracking-widest rounded-lg transition-all cursor-pointer flex items-center justify-center space-x-1 shadow-sm"
                    >
                      <span>SYNC FILES</span>
                      <ExternalLink size={10} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Symmetric Key Prompt Modal Overlay */}
      {selectedRoom && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="glass-panel border-t-2 border-t-[#265c34] rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5">
            <div className="flex justify-between items-start pb-1">
              <div>
                <h4 className="text-sm font-extrabold text-white">Verify Decryption Shield</h4>
                <p className="text-[9px] text-slate-455 font-mono uppercase tracking-widest mt-0.5 font-bold">Decrypting Locker {selectedRoom.roomId}</p>
              </div>
              <button
                onClick={() => setSelectedRoom(null)}
                className="text-slate-400 hover:text-white font-mono text-xs cursor-pointer p-1 rounded hover:bg-slate-900"
              >
                Close
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed leading-normal select-none">
              Packet blocks in this locker are symmetrically encrypted client-side. To pull the streams, you must provide the 64-character Encryption Key (found in the original link).
            </p>

            <form onSubmit={handleConfirmDiscoveredJoin} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[9.5px] font-mono text-slate-455 block uppercase tracking-widest font-bold">HEX Encryption Key or Share URL</label>
                <input
                  type="text"
                  placeholder="Paste shared URL containing key..."
                  required
                  autoFocus
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    setPromptKeyError("");
                  }}
                  className="w-full bg-slate-950/40 focus:bg-slate-950 text-xs text-white border border-brand-border focus:border-[#5eb075] focus:ring-1 focus:ring-[#5eb075]/10 rounded-xl px-3.5 py-2.5 outline-none transition-all placeholder:text-slate-500 font-mono"
                />
              </div>

              {promptKeyError && (
                <p className="text-[10px] text-rose-455 font-mono select-none flex items-center">
                  <AlertCircle size={11} className="mr-1" /> {promptKeyError}
                </p>
              )}

              <button
                type="submit"
                className="w-full py-3 bg-[#265c34] hover:bg-[#347442] text-white font-mono text-xs font-bold tracking-widest rounded-xl transition-all cursor-pointer flex items-center justify-center space-x-1 shadow-lg hover:shadow-[#265c34]/15"
              >
                <span>VERIFY & DECRYPT STREAM</span>
                <ArrowRight size={12} />
              </button>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
