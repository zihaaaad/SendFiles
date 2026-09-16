/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileMeta, TransferProgress, TransferState } from "../types";

const CHUNK_SIZE = 1048576; // 1MB LAN-optimized chunking size

const defaultPublicIceServers: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

let cachedIceConfig: RTCConfiguration = {
  iceServers: typeof navigator !== "undefined" && navigator.onLine ? defaultPublicIceServers : [],
};

/** Extracts the host from an ICE URL such as "stun:stun.example.com:19302". */
function iceUrlHost(url: string): string {
  const withoutScheme = url.replace(/^(stun|stuns|turn|turns):/i, "");
  const withoutQuery = withoutScheme.split("?")[0];
  // Strip the port, taking care not to break bracketed IPv6 literals.
  if (withoutQuery.startsWith("[")) {
    return withoutQuery.slice(0, withoutQuery.indexOf("]") + 1).toLowerCase();
  }
  return withoutQuery.split(":")[0].toLowerCase();
}

function isReachableOffline(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  );
}

export function getIceConfig(): RTCConfiguration {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
  if (isOnline || !cachedIceConfig.iceServers) return cachedIceConfig;

  // Offline: keep only servers that can actually be reached on the local
  // network, so ICE fails fast instead of stalling on public STUN timeouts.
  return {
    ...cachedIceConfig,
    iceServers: cachedIceConfig.iceServers.filter((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.every((url) => isReachableOffline(iceUrlHost(url)));
    })
  };
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

/**
 * Resolves the signalling WebSocket URL.
 *
 * Same-origin by default. Set VITE_SIGNALING_SERVER at build time to point a
 * statically-hosted frontend at a separate signalling backend.
 *
 * There is deliberately no built-in remote fallback: silently redirecting
 * signalling to a third-party host would leak peer names, IP addresses, file
 * metadata and — on the relay path — file contents to an operator the person
 * running this never chose.
 */
export async function getWebSocketURL(): Promise<string> {
  const loc = window.location;

  const metaEnv = (import.meta as any).env || {};
  let envUrl = String(metaEnv.VITE_SIGNALING_SERVER || "").trim();
  if (envUrl === "/") envUrl = "";

  if (envUrl) {
    let parsed: URL;
    try {
      parsed = new URL(envUrl, loc.origin);
    } catch {
      throw new Error(`VITE_SIGNALING_SERVER is not a valid URL: ${envUrl}`);
    }
    if (!/^(https?|wss?):$/.test(parsed.protocol)) {
      throw new Error(`VITE_SIGNALING_SERVER must use http(s) or ws(s): ${envUrl}`);
    }
    const protocol =
      parsed.protocol === "https:" || parsed.protocol === "wss:" ? "wss:" : "ws:";
    const path = parsed.pathname.replace(/\/+$/, "");
    const signalingPath = path.endsWith("/signaling") ? path : `${path}/signaling`;
    return `${protocol}//${parsed.host}${signalingPath}`;
  }

  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc.host}/signaling`;
}
