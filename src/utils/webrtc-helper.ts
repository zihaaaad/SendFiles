/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileMeta, TransferProgress, TransferState } from "../types";

const CHUNK_SIZE = 32768; // 32KB chunking specification size
let cachedIceConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
  ],
};

export function getIceConfig(): RTCConfiguration {
  return cachedIceConfig;
}

export async function fetchIceConfig(): Promise<RTCConfiguration> {
  try {
    const res = await fetch("/api/ice-config");
    if (res.ok) {
      const data = await res.json();
      if (data.iceServers) {
        cachedIceConfig = data;
      }
    }
  } catch (err) {
    console.error("Failed to fetch dynamic ICE config, falling back to STUNs:", err);
  }
  return cachedIceConfig;
}

export interface SpeedMeasurement {
  speed: number; // Bytes / sec
  eta: number; // seconds
}

// Calculate mathematically accurate progress, throughput speed, and estimated time remaining (ETA)
export function calculateSpeedAndETA(
  bytesTransferred: number,
  totalSize: number,
  transferStartTime: number
): SpeedMeasurement {
  const elapsedMs = Date.now() - transferStartTime;
  if (elapsedMs <= 100 || bytesTransferred === 0) {
    return { speed: 0, eta: Infinity };
  }
  const speed = bytesTransferred / (elapsedMs / 1000); // bytes per second
  const remainingBytes = Math.max(0, totalSize - bytesTransferred);
  const eta = remainingBytes / speed;
  return { speed, eta };
}

// Format throughput into a premium readable format (e.g. 5.12 MB/s or 421 KB/s)
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatTime(seconds: number): string {
  if (seconds === Infinity || isNaN(seconds)) return "estimating...";
  if (seconds < 1) return "seconds left";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s left`;
  return `${mins}m ${secs}s left`;
}

// Base websocket url detection with smart fallback for external hosting servers like Vercel
export async function getWebSocketURL(): Promise<string> {
  const loc = window.location;
  
  // 1. Check for custom environment overrides (Vercel settings)
  const metaEnv = (import.meta as any).env || {};
  let envUrl = (metaEnv.VITE_SIGNALING_SERVER || metaEnv.VITE_APP_URL || "").trim();
  
  // If the envUrl is just "/", ignore it
  if (envUrl === "/") envUrl = "";

  if (envUrl && envUrl.startsWith("http")) {
    const cleanUrl = envUrl.replace(/^http/, "ws");
    return cleanUrl.endsWith("/signaling") ? cleanUrl : `${cleanUrl}/signaling`;
  }

  // 2. Default Google Cloud Run fallback domain (The live signaling backend)
  const cloudRunFallback = "https://ais-pre-kf3wbykcpypypwsdu77fyr-35023296777.asia-east1.run.app";

  // If we are not on localhost or Cloud Run directly, default to the persistent signaling server on Cloud Run
  const isLocalOrCloudRun = loc.host.includes("localhost") || 
                            loc.host.includes("127.0.0.1") || 
                            loc.host.includes("run.app") || 
                            loc.host.includes("3000") ||
                            loc.host.includes("3001") ||
                            loc.hostname.endsWith(".local") ||
                            /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[0-1])\.|169\.254\.)/.test(loc.hostname);

  let targetHost = loc.host;
  let targetProtocol = loc.protocol === "https:" ? "wss:" : "ws:";

  if (!isLocalOrCloudRun) {
    try {
      const url = new URL(cloudRunFallback);
      targetHost = url.host;
      targetProtocol = url.protocol === "https:" ? "wss:" : "ws:";
      
      // Attempt to wake up the Cloud Run instance via HTTP ping before WSS dialing
      // Cloud Run sometimes drops cold WSS connections if the container is asleep
      await fetch(`${url.protocol}//${url.host}/api/ip`).catch(() => {});
    } catch (e) {
      console.error("Invalid cloudRunFallback URL:", e);
    }
  }

  return `${targetProtocol}//${targetHost}/signaling`;
}
