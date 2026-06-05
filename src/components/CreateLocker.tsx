/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from "react";
import { 
  UploadCloud, 
  Trash2, 
  Lock, 
  Unlock, 
  Clock, 
  CheckCircle,
  FileText,
  Video,
  Music,
  Code,
  Image as ImageIcon,
  ChevronRight,
  ShieldCheck
} from "lucide-react";
import { hashPassword } from "../utils/crypto";

interface CreateLockerProps {
  onLockerCreated: (params: {
    files: File[];
    maxDownloads: number;
    expiresInMins: number;
    passwordHash: string | null;
    rawPassword?: string;
  }) => void;
  isCreating: boolean;
}

export default function CreateLocker({ onLockerCreated, isCreating }: CreateLockerProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [maxDownloads, setMaxDownloads] = useState<number>(1);
  const [expiresInMins, setExpiresInMins] = useState<number>(60); // Default 1 hour
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Drag and Drop handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const addedFiles = Array.from(e.dataTransfer.files);
      setFiles((prev) => [...prev, ...addedFiles]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const addedFiles = Array.from(e.target.files);
      setFiles((prev) => [...prev, ...addedFiles]);
    }
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const selectFilesClick = () => {
    fileInputRef.current?.click();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;

    let pHash: string | null = null;
    if (usePassword && password) {
      pHash = await hashPassword(password);
    }

    onLockerCreated({
      files,
      maxDownloads,
      expiresInMins,
      passwordHash: pHash,
      rawPassword: usePassword ? password : undefined,
    });
  };

  // Helper file icon type selector
  const getFileIcon = (fileName: string) => {
    const ext = fileName.split(".").pop()?.toLowerCase();
    const size = 18;
    switch (ext) {
      case "mp4":
      case "mkv":
      case "mov":
      case "avi":
        return <Video size={size} className="text-indigo-400" />;
      case "mp3":
      case "wav":
      case "flac":
      case "ogg":
        return <Music size={size} className="text-emerald-400" />;
      case "png":
      case "jpg":
      case "jpeg":
      case "gif":
      case "webp":
      case "svg":
        return <ImageIcon size={size} className="text-amber-400" />;
      case "ts":
      case "tsx":
      case "js":
      case "jsx":
      case "html":
      case "css":
      case "json":
        return <Code size={size} className="text-sky-450" />;
      default:
        return <FileText size={size} className="text-slate-400" />;
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  return (
    <div className="w-full max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-6 items-start animate-in fade-in duration-200">
      {/* File Dropping Section (Col 7) */}
      <div className="md:col-span-7 glass-panel rounded-2xl p-6 flex flex-col h-full min-h-[440px] shadow-xl">
        <div className="flex justify-between items-center mb-5 select-none">
          <div>
            <h2 className="text-sm font-extrabold text-white tracking-tight">Select Transmit Materials</h2>
            <p className="text-[9px] text-slate-400 font-mono mt-0.5">DIRECT BROWSERS STREAM GATEWAY</p>
          </div>
          {files.length > 0 && (
            <span className="text-[10px] bg-slate-900/40 text-[#5eb075] font-mono px-2.5 py-1 rounded-lg border border-brand-border">
              {files.length} {files.length === 1 ? "file" : "files"} • {formatBytes(totalBytes)}
            </span>
          )}
        </div>

        {/* Drag and Drop Box */}
        <div
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          onClick={files.length === 0 ? selectFilesClick : undefined}
          className={`flex-1 flex flex-col items-center justify-center border-2 border-dashed rounded-xl transition-all duration-200 p-6 text-center cursor-pointer select-none ${
            dragActive
              ? "border-[#5eb075] bg-[#5eb075]/5 text-[#5eb075] shadow-sm"
              : files.length === 0
              ? "border-slate-700 hover:border-slate-500 hover:bg-slate-900/10"
              : "border-brand-border bg-slate-900/5 cursor-default"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
            id="file-element"
          />

          {files.length === 0 ? (
            <div className="py-12 pointer-events-none">
              <div className="w-12 h-12 bg-[#5eb075]/10 border border-[#5eb075]/15 rounded-2xl flex items-center justify-center mx-auto mb-4 text-[#5eb075] shadow-inner">
                <UploadCloud size={22} />
              </div>
              <p className="text-xs font-bold text-white mb-1 tracking-tight">
                Drag and drop files here
              </p>
              <p className="text-[10.5px] text-slate-450 max-w-[270px] mx-auto leading-relaxed">
                or <span className="text-[#5eb075] font-bold">browse local storage</span>. Streams up to 10GB+ directly.
              </p>
            </div>
          ) : (
            <div className="w-full h-full max-h-[300px] overflow-y-auto space-y-2 pr-1.5 scrollbar-thin scrollbar-thumb-slate-800">
              {files.map((file, idx) => (
                <div
                  key={idx}
                  className="group flex items-center justify-between bg-slate-950/20 border border-brand-border hover:border-slate-700 rounded-xl p-3.5 text-left transition-all duration-150 shadow-sm"
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <div className="w-9 h-9 bg-slate-900/40 rounded-lg flex items-center justify-center border border-brand-border shrink-0">
                      {getFileIcon(file.name)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-200 truncate pr-3">
                        {file.name}
                      </p>
                      <p className="text-[9.5px] text-slate-450 font-mono mt-0.5">
                        {formatBytes(file.size)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(idx);
                    }}
                    className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all duration-150 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
                    title="Remove file"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}

              <div className="pt-2.5 text-center">
                <button
                  type="button"
                  onClick={selectFilesClick}
                  className="text-xs font-mono text-slate-450 hover:text-[#5eb075] underline decoration-slate-600 hover:decoration-[#5eb075] underline-offset-4 cursor-pointer font-bold"
                >
                  Add more files
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Locker Params / Limits Controls (Col 5) */}
      <div className="md:col-span-5 space-y-5">
        <form onSubmit={handleCreate} className="space-y-5">
          <div className="glass-panel rounded-2xl p-6 space-y-5 shadow-xl">
            <div className="select-none">
              <h2 className="text-sm font-extrabold text-white tracking-tight font-sans">Locker Configuration</h2>
              <p className="text-[9px] text-slate-450 font-mono mt-0.5">ENVELOPE DESTRUCT CONDITIONS</p>
            </div>

            {/* Expire in Minutes select dropdown */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-slate-400 flex items-center select-none">
                  <Clock size={13} className="mr-1.5 text-[#5eb075]" /> TIMEOUT PERIOD
                </span>
              </div>
              <select
                value={expiresInMins}
                onChange={(e) => setExpiresInMins(Number(e.target.value))}
                className="w-full bg-slate-950/40 text-xs text-white border border-brand-border focus:border-[#5eb075] focus:ring-1 focus:ring-[#5eb075]/10 rounded-xl px-4 py-2.5 outline-none transition-all font-mono"
              >
                <option value="10">10 Minutes</option>
                <option value="60">1 Hour</option>
                <option value="240">4 Hours</option>
                <option value="1440">24 Hours</option>
              </select>
            </div>

            {/* Total download limits */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-slate-400 flex items-center select-none">
                  <CheckCircle size={13} className="mr-1.5 text-[#5eb075]" /> DOWNLOAD LIMIT
                </span>
              </div>
              <select
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(Number(e.target.value))}
                className="w-full bg-slate-950/40 text-xs text-white border border-brand-border focus:border-[#5eb075] focus:ring-1 focus:ring-[#5eb075]/10 rounded-xl px-4 py-2.5 outline-none transition-all font-mono"
              >
                <option value="1">1 Download</option>
                <option value="5">5 Downloads</option>
                <option value="10">10 Downloads</option>
                <option value="50">50 Downloads</option>
                <option value="100">Unlimited (100)</option>
              </select>
            </div>

            <hr className="border-slate-800/40" />

            {/* Password verification */}
            <div className="space-y-3">
              <div className="flex items-center justify-between select-none">
                <div className="flex items-center space-x-2 text-xs font-mono text-slate-400">
                  {usePassword ? (
                    <Lock size={13} className="text-[#5eb075]" />
                  ) : (
                    <Unlock size={13} className="text-slate-500" />
                  )}
                  <span>SECONDARY PASSWORD SHIELD</span>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={usePassword}
                    onChange={(e) => setUsePassword(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-8 h-4.5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-[#265c34] peer-checked:after:bg-white"></div>
                </label>
              </div>

              {usePassword && (
                <div className="relative animate-in slide-in-from-top-1.5 duration-150">
                  <input
                    type="password"
                    placeholder="Set secure unlock password..."
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required={usePassword}
                    className="w-full bg-slate-950/40 text-xs text-white border border-brand-border focus:border-[#5eb075] focus:ring-1 focus:ring-[#5eb075]/10 rounded-xl px-4 py-2.5 outline-none transition-all placeholder:text-slate-500 font-mono"
                  />
                  <p className="text-[9px] text-slate-450 font-mono mt-1.5 leading-relaxed select-none">
                    * Sealed symmetrically inside your browser. Server never stores unencrypted metadata.
                  </p>
                </div>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={files.length === 0 || isCreating}
            className={`w-full py-3.5 px-6 rounded-2xl flex items-center justify-center font-medium transition-all duration-200 shadow-lg ${
              files.length === 0
                ? "bg-slate-900/50 text-slate-500 cursor-not-allowed border border-brand-border"
                : "bg-[#265c34] hover:bg-[#347442] active:scale-[0.99] text-white hover:shadow-md hover:shadow-[#265c34]/20 cursor-pointer"
            }`}
          >
            {isCreating ? (
              <span className="flex items-center space-x-2.5 text-xs font-mono font-bold tracking-wider">
                <span className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin"></span>
                <span>SEALING LOCKER VAULT...</span>
              </span>
            ) : (
              <span className="flex items-center space-x-1.5 text-xs font-mono tracking-widest uppercase font-extrabold">
                <span>CREATE SECURE LOCKER VAULT</span>
                <ChevronRight size={14} />
              </span>
            )}
          </button>
        </form>

        <div className="flex items-center justify-center space-x-2 text-slate-500 text-center py-1 select-none">
          <ShieldCheck size={14} className="text-emerald-500" />
          <span className="text-[9.5px] font-mono tracking-widest uppercase font-bold">
            AES-256-GCM Browser Cryptography
          </span>
        </div>
      </div>
    </div>
  );
}
