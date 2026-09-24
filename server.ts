/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import os from "os";
import { exec } from "child_process";
import selfsigned from "selfsigned";
import rateLimit from "express-rate-limit";
import { createClient } from "redis";

dotenv.config();

const isPackaged = typeof (process as any).pkg !== "undefined";
const isDev = process.env.NODE_ENV === "development" || (process.env.NODE_ENV !== "production" && !isPackaged && !__filename.endsWith("server.cjs"));
const isLocalDesktop = isPackaged || process.platform === "win32" || process.platform === "darwin" || (process.platform === "linux" && !!process.env.DISPLAY);

function isLocalIp(ip: string): boolean {
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
}

// ----------------------------------------------------
// Proxy trust + client IP resolution
//
// TRUST_PROXY accepts "true"/"1" (trust every hop, only safe when the app is
// never reachable except through your proxy) or a hop count such as "1", which
// is what almost every managed platform wants.
// ----------------------------------------------------
function parseTrustProxy(raw: string | undefined): boolean | number {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false" || normalized === "") return false;
  const hops = Number(normalized);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  return false;
}

const trustProxySetting = parseTrustProxy(process.env.TRUST_PROXY);
const isBehindProxy = trustProxySetting !== false && trustProxySetting !== 0;

const app = express();
app.set("trust proxy", trustProxySetting);

/**
 * Resolves the client IP for both Express requests and raw WebSocket upgrade
 * requests.
 *
 * X-Forwarded-For is only consulted when TRUST_PROXY is configured, and we walk
 * the chain from the right by the configured hop count rather than blindly
 * taking index 0 — the left-most entry is fully attacker-controlled.
 */
function getClientIp(req: any): string {
  const socketIp = req.socket?.remoteAddress || "127.0.0.1";
  if (!isBehindProxy) return socketIp;

  const forwarded = req.headers?.["x-forwarded-for"];
  if (!forwarded) return socketIp;

  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : String(forwarded))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketIp;

  if (trustProxySetting === true) {
    // Every hop trusted: the left-most entry is the originating client.
    return chain[0];
  }

  // Trust exactly `hops` proxies: step back that many entries from the right.
  const hops = trustProxySetting as number;
  const index = chain.length - hops;
  return chain[Math.max(0, Math.min(index, chain.length - 1))];
}

// ----------------------------------------------------
// Discovery scope
//
// "lan"    - peers/lockers sharing a private network are grouped together.
//            Correct for a laptop serving its own Wi-Fi, wrong for a public host.
// "strict" - only an exact client IP match groups peers together.
// "off"    - no ambient discovery at all; lockers are reachable by link only.
//
// This MUST NOT default to "lan" on a hosted deployment. Behind a reverse proxy
// every request arrives from the same private address, so "lan" would place
// every user on the planet into one discovery group.
// ----------------------------------------------------
type DiscoveryMode = "lan" | "strict" | "off";

function resolveDiscoveryMode(): DiscoveryMode {
  const configured = (process.env.DISCOVERY_MODE || "").trim().toLowerCase();
  if (configured === "lan" || configured === "strict" || configured === "off") {
    return configured;
  }
  // Behind a proxy the socket address is the proxy's, so LAN grouping is unsafe.
  if (isBehindProxy) return "strict";
  // A packaged desktop build or a dev machine is the intended LAN-sharing case.
  return isLocalDesktop ? "lan" : "strict";
}

const discoveryMode = resolveDiscoveryMode();

function ipsMatchForDiscovery(ipA: string, ipB: string): boolean {
  if (discoveryMode === "off") return false;
  if (!ipA || !ipB) return false;
  if (ipA === ipB) return true;
  if (discoveryMode === "lan" && isLocalIp(ipA) && isLocalIp(ipB)) return true;
  return false;
}

// Rate limits are only waived for genuinely local clients on a LAN deployment.
// On a hosted deployment every client looks local behind the proxy, so skipping
// there would disable rate limiting entirely.
const skipRateLimitForLocal = (req: any) => discoveryMode === "lan" && isLocalIp(getClientIp(req));

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests from this IP, please try again later." },
  keyGenerator: (req) => getClientIp(req),
  skip: skipRateLimitForLocal,
});

const createRoomLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15, // Limit each IP to 15 room creations per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many lockers created from this IP, please try again later." },
  keyGenerator: (req) => getClientIp(req),
  skip: skipRateLimitForLocal,
});

// Passcode guessing is never exempt from rate limiting, including on a LAN.
const passwordAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 passcode attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many passcode attempts. Please wait before trying again." },
  keyGenerator: (req) => getClientIp(req),
});

// Apply rate limiting
app.use("/api/", apiLimiter);

// ----------------------------------------------------
// Identifier generation & room access tokens
// ----------------------------------------------------

// Excludes visually ambiguous characters (0/O, 1/I) so codes can be read aloud.
const ROOM_ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_ID_LENGTH = 8; // 32^8 = 2^40 keyspace

/** Generates a room ID from a CSPRNG with rejection sampling to avoid modulo bias. */
function generateRoomId(): string {
  const max = 256 - (256 % ROOM_ID_ALPHABET.length);
  let out = "";
  while (out.length < ROOM_ID_LENGTH) {
    for (const byte of crypto.randomBytes(ROOM_ID_LENGTH)) {
      if (byte >= max) continue; // reject to keep the distribution uniform
      out += ROOM_ID_ALPHABET[byte % ROOM_ID_ALPHABET.length];
      if (out.length === ROOM_ID_LENGTH) break;
    }
  }
  return out;
}

/**
 * Secret used to sign locker access tokens. Set ROOM_TOKEN_SECRET to keep
 * tokens valid across restarts or share them across a Redis-backed cluster;
 * otherwise a per-process secret is generated (tokens die with the process).
 */
const ROOM_TOKEN_SECRET =
  process.env.ROOM_TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const ROOM_TOKEN_TTL_MS = 15 * 60 * 1000;

function signRoomToken(roomId: string, expiresAt: number): string {
  return crypto
    .createHmac("sha256", ROOM_TOKEN_SECRET)
    .update(`${roomId}.${expiresAt}`)
    .digest("hex");
}

function issueRoomToken(roomId: string): string {
  const expiresAt = Date.now() + ROOM_TOKEN_TTL_MS;
  return `${expiresAt}.${signRoomToken(roomId, expiresAt)}`;
}

function verifyRoomToken(roomId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator === -1) return false;

  const expiresAt = Number(token.substring(0, separator));
  const signature = token.substring(separator + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  return timingSafeEqualHex(signature, signRoomToken(roomId, expiresAt));
}

/** Constant-time comparison for equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Peer IDs are client-supplied, so they are format-checked before use as map
// keys or routing targets.
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_PEER_NAME_LENGTH = 64;

// ----------------------------------------------------
// Request payload validation
// ----------------------------------------------------
const MAX_FILES_PER_ROOM = 256;
const MAX_EXPIRY_MINS = 24 * 60; // 24 hours, matching the UI's longest option
const MAX_DOWNLOAD_LIMIT = 1000;
const MAX_FILE_NAME_LENGTH = 255;

function isHexOfLength(value: unknown, length: number): boolean {
  return typeof value === "string" && value.length === length && /^[0-9a-fA-F]+$/.test(value);
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * File names are echoed back to every client that can see the locker, so strip
 * path separators and control characters before storing them.
 */
function sanitizeFileName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) return "unnamed_file";
  const cleaned = name
    .replace(/[\\/]/g, "_")
    .replace(/\p{Cc}/gu, "")
    .trim();
  return cleaned.slice(0, MAX_FILE_NAME_LENGTH) || "unnamed_file";
}

const PORT = parseInt(process.env.PORT || "3000", 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "3001", 10);

// Generate or load self-signed SSL certificate
let sslCert: any = null;
try {
  const sslDir = path.join(os.tmpdir(), "sendfiles-ssl-v2");
  if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir, { recursive: true });
  }
  const keyPath = path.join(sslDir, "key.pem");
  const certPath = path.join(sslDir, "cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    sslCert = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
  } else {
    const attrs = [{ name: "commonName", value: "SendFiles" }];
    const pems = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    sslCert = {
      key: pems.private,
      cert: pems.cert
    };
  }
} catch (err) {
  console.error("Failed to generate/load SSL certificate, using in-memory fallback:", err);
  const attrs = [{ name: "commonName", value: "SendFiles" }];
  const pems = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
  sslCert = {
    key: pems.private,
    cert: pems.cert
  };
}

const server = http.createServer(app);
const httpsServer = https.createServer(sslCert, app);

app.use(express.json());

// Redis Integration
let redisClient: any = null;
let redisPub: any = null;
let redisSub: any = null;
const REDIS_URL = process.env.REDIS_URL;

async function initRedis() {
  if (REDIS_URL) {
    try {
      redisClient = createClient({ url: REDIS_URL });
      redisPub = createClient({ url: REDIS_URL });
      redisSub = createClient({ url: REDIS_URL });
      
      await redisClient.connect();
      await redisPub.connect();
      await redisSub.connect();
      
      setupRedisPubSub();
      console.log("[Redis Cluster] Connected to Redis for state replication & Pub/Sub signaling.");
    } catch (err) {
      console.error("[Redis Cluster] Redis initialization failed. Falling back to local Map storage:", err);
      redisClient = null;
      redisPub = null;
      redisSub = null;
    }
  }
}

// Fetch Public IP
app.get("/api/ip", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ ip: getClientIp(req) });
});

// Fetch local network IPs of the server
app.get("/api/network-ips", (_req, res) => {
  const ips: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    if (iface) {
      for (const alias of iface) {
        if (alias.family === "IPv4" && !alias.internal) {
          ips.push(alias.address);
        }
      }
    }
  }
  res.json({ ips });
});

// Ice Traversal Configuration Endpoint
app.get("/api/ice-config", (_req, res) => {
  const iceServers: any[] = [];

  if (process.env.OFFLINE_MODE !== "true") {
    iceServers.push(
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" }
    );
  }

  if (process.env.TURN_SERVER_URL) {
    iceServers.push({
      urls: process.env.TURN_SERVER_URL,
      username: process.env.TURN_SERVER_USERNAME,
      credential: process.env.TURN_SERVER_CREDENTIAL
    });
  }
  if (process.env.STUN_SERVER_URL) {
    iceServers.push({
      urls: process.env.STUN_SERVER_URL
    });
  }
  res.json({ iceServers });
});

// File Metadata interfaces
interface FileMetadata {
  name: string;
  size: number;
  type: string;
}

// Room state definition
interface Room {
  id: string;
  expiresAt: number;
  files: FileMetadata[];
  maxDownloads: number;
  downloadCount: number;
  passwordHash: string | null;
  passwordSalt: string | null;
  senderPeerId: string | null;
  receiverPeerIds: Set<string>;
  /**
   * Receivers already counted against maxDownloads. A download is one receiver
   * completing the whole locker, not one file — without this a 3-file locker
   * with maxDownloads=1 would prune itself after the first file.
   */
  countedPeerIds: Set<string>;
  creatorIp: string;
}

// In-Memory Room Registry fallback
const rooms = new Map<string, Room>();

// Serialization utilities for Redis
function serializeRoom(room: Room): string {
  return JSON.stringify({
    ...room,
    receiverPeerIds: Array.from(room.receiverPeerIds),
    countedPeerIds: Array.from(room.countedPeerIds)
  });
}

function deserializeRoom(json: string): Room {
  const data = JSON.parse(json);
  return {
    ...data,
    receiverPeerIds: new Set(data.receiverPeerIds || []),
    countedPeerIds: new Set(data.countedPeerIds || [])
  };
}

async function saveRoom(room: Room): Promise<void> {
  if (redisClient) {
    const key = `sendfiles:room:${room.id}`;
    const ttl = room.expiresAt - Date.now();
    if (ttl <= 0) {
      // Already expired: drop it rather than issuing an invalid PX of <= 0.
      await deleteRoom(room.id);
      return;
    }
    await redisClient.set(key, serializeRoom(room), { PX: ttl });
    await redisClient.sAdd("sendfiles:active_rooms", room.id);
  } else {
    rooms.set(room.id, room);
  }
}

async function getRoom(roomId: string): Promise<Room | null> {
  if (redisClient) {
    const key = `sendfiles:room:${roomId}`;
    const json = await redisClient.get(key);
    if (!json) {
      await redisClient.sRem("sendfiles:active_rooms", roomId);
      return null;
    }
    return deserializeRoom(json);
  } else {
    return rooms.get(roomId) || null;
  }
}

async function deleteRoom(roomId: string): Promise<void> {
  if (redisClient) {
    await redisClient.del(`sendfiles:room:${roomId}`);
    await redisClient.sRem("sendfiles:active_rooms", roomId);
  } else {
    rooms.delete(roomId);
  }
}

async function getAllActiveRooms(clientIp: string): Promise<Room[]> {
  // With discovery off there is no ambient listing at all; lockers are link-only.
  if (discoveryMode === "off") return [];

  const activeRoomsList: Room[] = [];
  const now = Date.now();
  const isVisible = (room: Room) =>
    room.expiresAt > now &&
    room.downloadCount < room.maxDownloads &&
    ipsMatchForDiscovery(room.creatorIp, clientIp);

  if (redisClient) {
    const roomIds: string[] = await redisClient.sMembers("sendfiles:active_rooms");
    if (roomIds.length === 0) return [];

    // One MGET instead of a round-trip per room; this endpoint is polled by
    // every connected client.
    const payloads: (string | null)[] = await redisClient.mGet(
      roomIds.map((rId) => `sendfiles:room:${rId}`)
    );

    const staleIds: string[] = [];
    payloads.forEach((json, idx) => {
      if (!json) {
        staleIds.push(roomIds[idx]);
        return;
      }
      try {
        const room = deserializeRoom(json);
        if (isVisible(room)) activeRoomsList.push(room);
      } catch {
        staleIds.push(roomIds[idx]);
      }
    });

    if (staleIds.length > 0) {
      await redisClient.sRem("sendfiles:active_rooms", staleIds);
    }
  } else {
    for (const room of rooms.values()) {
      if (isVisible(room)) activeRoomsList.push(room);
    }
  }

  // Stable order: Map iteration and Redis set order both shift as lockers come
  // and go, which made rows jump between polls in the discovery UI.
  return activeRoomsList.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ----------------------------------------------------
// Express Rest API Endpoints for Lockers
// ----------------------------------------------------

// 1. Create a secure locker
app.post("/api/rooms", createRoomLimiter, async (req, res) => {
  try {
    const { files, maxDownloads, expiresInMins, passwordHash, passwordSalt } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "Files array is required" });
    }
    if (files.length > MAX_FILES_PER_ROOM) {
      return res.status(400).json({ error: `A locker may hold at most ${MAX_FILES_PER_ROOM} files` });
    }
    if (passwordHash !== undefined && passwordHash !== null && !isHexOfLength(passwordHash, 64)) {
      return res.status(400).json({ error: "passwordHash must be a 64-character hex digest" });
    }
    if (passwordSalt !== undefined && passwordSalt !== null && !isHexOfLength(passwordSalt, 32)) {
      return res.status(400).json({ error: "passwordSalt must be a 32-character hex string" });
    }
    if (passwordHash && !passwordSalt) {
      return res.status(400).json({ error: "passwordSalt is required when a passcode is set" });
    }

    // Generate unique Room ID from a CSPRNG.
    let roomId = "";
    let roomExists = false;
    do {
      roomId = generateRoomId();
      roomExists = redisClient ? (await redisClient.exists(`sendfiles:room:${roomId}`)) > 0 : rooms.has(roomId);
    } while (roomExists);

    const creatorIp = getClientIp(req);

    const expiryMins = clampNumber(Number(expiresInMins), 1, MAX_EXPIRY_MINS, 60);
    const downloadLimit = clampNumber(Number(maxDownloads), 1, MAX_DOWNLOAD_LIMIT, 1);

    const newRoom: Room = {
      id: roomId,
      expiresAt: Date.now() + expiryMins * 60 * 1000,
      files: files.map((f: any) => ({
        name: sanitizeFileName(f?.name),
        size: Math.max(0, Number(f?.size) || 0),
        type: typeof f?.type === "string" && f.type ? f.type.slice(0, 128) : "application/octet-stream"
      })),
      maxDownloads: downloadLimit,
      downloadCount: 0,
      passwordHash: passwordHash || null,
      passwordSalt: passwordSalt || null,
      senderPeerId: null,
      receiverPeerIds: new Set<string>(),
      countedPeerIds: new Set<string>(),
      creatorIp
    };

    await saveRoom(newRoom);
    console.log(`[Locker Hub] Created Locker ${roomId} | Files: ${newRoom.files.length} | IP: ${creatorIp}`);

    res.status(201).json({
      roomId: newRoom.id,
      expiresAt: newRoom.expiresAt,
      maxDownloads: newRoom.maxDownloads,
      downloadCount: newRoom.downloadCount,
      hasPassword: newRoom.passwordHash !== null,
      passwordSalt: newRoom.passwordSalt || undefined,
      files: newRoom.files
    });
  } catch (err) {
    console.error("Error creating locker:", err);
    res.status(500).json({ error: "Failed to create secure locker" });
  }
});

// 2. Scan active lockers (Discovery Hub matching local IP)
app.get("/api/rooms", async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const activeRooms = await getAllActiveRooms(clientIp);

    res.json(activeRooms.map(room => ({
      roomId: room.id,
      expiresAt: room.expiresAt,
      maxDownloads: room.maxDownloads,
      downloadCount: room.downloadCount,
      hasPassword: room.passwordHash !== null,
      passwordSalt: room.passwordSalt || undefined,
      files: room.files
    })));
  } catch (err) {
    console.error("Scan error:", err);
    res.status(500).json({ error: "Failed to list active rooms" });
  }
});

// 3. Get specific locker details
app.get("/api/rooms/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await getRoom(roomId);

    if (!room || room.expiresAt <= Date.now()) {
      return res.status(404).json({ error: "Locker not found or has expired" });
    }

    if (room.downloadCount >= room.maxDownloads) {
      return res.status(410).json({ error: "Locker download limit has been reached" });
    }

    res.json({
      roomId: room.id,
      expiresAt: room.expiresAt,
      maxDownloads: room.maxDownloads,
      downloadCount: room.downloadCount,
      hasPassword: room.passwordHash !== null,
      passwordSalt: room.passwordSalt || undefined,
      files: room.files
    });
  } catch (err) {
    res.status(500).json({ error: "Server lookup error" });
  }
});

// 4. Verify password PIN and issue a short-lived locker access token.
//
// The token is what actually gates joining the locker's signalling room. The
// previous version only returned {success:true} and let the client decide
// whether it was authorised, which made the passcode purely decorative.
app.post("/api/rooms/:roomId/verify-password", passwordAttemptLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { passwordHash } = req.body;
    const room = await getRoom(roomId);

    if (!room || room.expiresAt <= Date.now()) {
      return res.status(404).json({ error: "Locker not found or has expired" });
    }

    if (!room.passwordHash) {
      // No passcode configured: hand out a token so the join path is uniform.
      return res.json({ success: true, accessToken: issueRoomToken(room.id) });
    }

    if (!isHexOfLength(passwordHash, 64) || !timingSafeEqualHex(passwordHash, room.passwordHash)) {
      return res.status(401).json({ error: "Incorrect passcode PIN" });
    }

    res.json({ success: true, accessToken: issueRoomToken(room.id) });
  } catch (err) {
    console.error("Passcode verification error:", err);
    res.status(500).json({ error: "Verification server error" });
  }
});

// 5. Issue an access token for a locker that has no passcode.
app.post("/api/rooms/:roomId/access", async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await getRoom(roomId);

    if (!room || room.expiresAt <= Date.now()) {
      return res.status(404).json({ error: "Locker not found or has expired" });
    }
    if (room.downloadCount >= room.maxDownloads) {
      return res.status(410).json({ error: "Locker download limit has been reached" });
    }
    if (room.passwordHash) {
      return res.status(401).json({ error: "This locker requires a passcode" });
    }

    res.json({ success: true, accessToken: issueRoomToken(room.id) });
  } catch (err) {
    console.error("Access token error:", err);
    res.status(500).json({ error: "Server lookup error" });
  }
});

// ----------------------------------------------------
// WebSocket Discovery & Signaling Server
// ----------------------------------------------------

interface ConnectedPeer {
  peerId: string;
  name: string;
  ip: string;
  ws: WebSocket;
  lastActive: number;
  roomId?: string;
  role?: string;
  /** Last peers-list JSON sent, so identical updates can be skipped. */
  lastPeersPayload?: string;
}

interface DirectoryPeer {
  peerId: string;
  name: string;
  ip: string;
}

const activePeers = new Map<string, ConnectedPeer>();

// Identifies this process in the shared Redis peer directory.
const INSTANCE_ID = crypto.randomBytes(8).toString("hex");
const PEER_DIRECTORY_KEY = "sendfiles:peers";
const PEER_DIRECTORY_TTL_MS = 90 * 1000;
const PEER_DIRECTORY_REFRESH_MS = 30 * 1000;

/** Publishes/refreshes a discoverable peer in the shared directory. */
async function registerPeerInDirectory(peer: ConnectedPeer): Promise<void> {
  if (!redisClient || peer.roomId) return;
  try {
    await redisClient.hSet(
      PEER_DIRECTORY_KEY,
      peer.peerId,
      JSON.stringify({
        peerId: peer.peerId,
        name: peer.name,
        ip: peer.ip,
        instanceId: INSTANCE_ID,
        updatedAt: Date.now()
      })
    );
  } catch (err) {
    console.error("[Redis Cluster] Failed to register peer:", err);
  }
}

async function unregisterPeerFromDirectory(peerId: string): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.hDel(PEER_DIRECTORY_KEY, peerId);
  } catch (err) {
    console.error("[Redis Cluster] Failed to unregister peer:", err);
  }
}

/**
 * Returns every discoverable peer across the cluster. Without Redis this is
 * just the local process; with Redis it is the union of all instances, so
 * discovery actually works when scaled horizontally.
 */
async function getDirectoryPeers(): Promise<DirectoryPeer[]> {
  const local: DirectoryPeer[] = Array.from(activePeers.values())
    .filter((p) => !p.roomId)
    .map((p) => ({ peerId: p.peerId, name: p.name, ip: p.ip }));

  if (!redisClient) return sortPeers(local);

  try {
    const entries: Record<string, string> = await redisClient.hGetAll(PEER_DIRECTORY_KEY);
    const now = Date.now();
    const merged = new Map<string, DirectoryPeer>();
    const stalePeerIds: string[] = [];

    for (const [peerId, raw] of Object.entries(entries)) {
      try {
        const parsed = JSON.parse(raw);
        // Drop entries whose owning instance died without cleaning up.
        if (now - Number(parsed.updatedAt || 0) > PEER_DIRECTORY_TTL_MS) {
          stalePeerIds.push(peerId);
          continue;
        }
        merged.set(peerId, { peerId, name: parsed.name, ip: parsed.ip });
      } catch {
        stalePeerIds.push(peerId);
      }
    }

    // Local peers are authoritative for this instance.
    for (const peer of local) merged.set(peer.peerId, peer);

    if (stalePeerIds.length > 0) {
      await redisClient.hDel(PEER_DIRECTORY_KEY, stalePeerIds);
    }
    return sortPeers(Array.from(merged.values()));
  } catch (err) {
    console.error("[Redis Cluster] Peer directory read failed, using local peers:", err);
    return sortPeers(local);
  }
}

/**
 * Deterministic ordering by peer ID.
 *
 * Both Map iteration order and Redis hash order shift as peers come and go, so
 * an unsorted list made rows jump around in every client's UI whenever anyone
 * joined or left.
 */
function sortPeers(peers: DirectoryPeer[]): DirectoryPeer[] {
  return peers.sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
}

/**
 * Sends each client only the peers it is allowed to discover.
 *
 * This filtering previously existed only in the browser, so every connected
 * client received the full global peer list regardless of network.
 */
async function broadcastPeersList(): Promise<void> {
  const directory = await getDirectoryPeers();

  for (const client of activePeers.values()) {
    if (client.roomId || client.ws.readyState !== WebSocket.OPEN) continue;

    const visiblePeers =
      discoveryMode === "off"
        ? []
        : directory.filter(
            (p) => p.peerId !== client.peerId && ipsMatchForDiscovery(p.ip, client.ip)
          );

    const payload = JSON.stringify({
      type: "peers-list",
      // The client no longer needs raw peer IPs to group the list itself.
      peers: visiblePeers.map((p) => ({ peerId: p.peerId, name: p.name })),
      yourIp: client.ip,
      discoveryMode
    });

    // Skip clients whose view of the network is unchanged. Most joins and
    // leaves are irrelevant to most clients, and a re-sent identical list still
    // costs them a re-render.
    if (client.lastPeersPayload === payload) continue;
    client.lastPeersPayload = payload;
    client.ws.send(payload);
  }
}

// Coalescing window for peer-list broadcasts.
const PEERS_BROADCAST_DEBOUNCE_MS = 250;
let peersBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let peersBroadcastPending = false;

/**
 * Coalesces peer-list broadcasts.
 *
 * Every join and leave used to fan out immediately to every client, so N
 * clients reconnecting at once produced N broadcasts of N messages each. A
 * short trailing window collapses a burst into one broadcast without making
 * discovery feel laggy.
 */
function scheduleBroadcastPeersList(): void {
  if (peersBroadcastTimer) {
    peersBroadcastPending = true;
    return;
  }

  const run = () => {
    peersBroadcastTimer = setTimeout(() => {
      peersBroadcastTimer = null;
      if (peersBroadcastPending) {
        peersBroadcastPending = false;
        run();
      }
    }, PEERS_BROADCAST_DEBOUNCE_MS);

    broadcastPeersList().catch((err) =>
      console.error("[Discovery Hub] Failed to broadcast peer list:", err)
    );
  };

  run();
}

/**
 * Authorises a relay hop. Previously any socket could address any peer ID,
 * which let an attacker who guessed an ID inject signalling or file chunks
 * into an unrelated transfer.
 *
 * A hop is allowed when both peers belong to the same locker room, or when
 * both are ambient peers that are permitted to discover each other.
 */
async function canRelayTo(
  fromPeerId: string,
  fromRoomId: string | null,
  targetPeerId: string
): Promise<boolean> {
  if (fromPeerId === targetPeerId) return false;

  // Locker room traffic: sender <-> receivers of that same room.
  if (fromRoomId) {
    const room = await getRoom(fromRoomId);
    if (!room) return false;
    return room.senderPeerId === targetPeerId || room.receiverPeerIds.has(targetPeerId);
  }

  // Direct Beam traffic: only between peers that may discover one another.
  const source = activePeers.get(fromPeerId);
  const target = activePeers.get(targetPeerId);
  if (!source || source.roomId) return false;

  if (target) {
    if (target.roomId) return false;
    return ipsMatchForDiscovery(source.ip, target.ip);
  }

  // Target lives on another instance: consult the shared directory.
  if (!redisClient) return false;
  try {
    const raw = await redisClient.hGet(PEER_DIRECTORY_KEY, targetPeerId);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return ipsMatchForDiscovery(source.ip, parsed.ip);
  } catch {
    return false;
  }
}

// Setup Redis Pub/Sub listeners for scaling Websockets horizontally
function setupRedisPubSub() {
  if (!redisSub) return;

  redisSub.subscribe("sendfiles:signaling", (msgStr: string) => {
    try {
      const { type, targetPeerId, senderPeerId, senderName, payload } = JSON.parse(msgStr);
      const target = activePeers.get(targetPeerId);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({
          type,
          senderPeerId,
          senderName,
          payload
        }));
      }
    } catch (err) {
      console.error("[Redis Cluster] Signaling forward error:", err);
    }
  });

  redisSub.subscribe("sendfiles:signaling_binary", (msgStr: string) => {
    try {
      const { targetPeerId, bufferBase64 } = JSON.parse(msgStr);
      const target = activePeers.get(targetPeerId);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        const buffer = Buffer.from(bufferBase64, "base64");
        target.ws.send(buffer, { binary: true });
      }
    } catch (err) {
      console.error("[Redis Cluster] Binary forward error:", err);
    }
  });

  redisSub.subscribe("sendfiles:room_prune", (rId: string) => {
    for (const [pId, activePeer] of activePeers.entries()) {
      if (activePeer.roomId === rId) {
        try {
          activePeer.ws.send(JSON.stringify({ type: "error", message: "Locker download limit reached" }));
          activePeer.ws.close();
        } catch {}
        activePeers.delete(pId);
      }
    }
  });

  // A peer joined or left on some instance: refresh this instance's clients so
  // discovery reflects the whole cluster, not just the local process.
  redisSub.subscribe("sendfiles:presence", (originInstanceId: string) => {
    if (originInstanceId === INSTANCE_ID) return;
    scheduleBroadcastPeersList();
  });
}

async function publishPresenceChange(): Promise<void> {
  if (!redisPub) return;
  try {
    await redisPub.publish("sendfiles:presence", INSTANCE_ID);
  } catch (err) {
    console.error("[Redis Cluster] Presence publish failed:", err);
  }
}

// Chunks are 1MB plus framing overhead; anything materially larger is abuse.
const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Concurrent sockets allowed per client IP.
 *
 * A single shared address is normal here, not suspicious: everyone behind one
 * office NAT, or on a phone carrier's CGNAT, arrives from the same IP. The old
 * hard limit of 10 rejected the 11th real user, whose client then retried in a
 * loop — which is exactly the kind of churn that makes everyone else's device
 * list flicker. Override with MAX_CONNECTIONS_PER_IP.
 */
const MAX_CONNECTIONS_PER_IP = (() => {
  const configured = Number(process.env.MAX_CONNECTIONS_PER_IP);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return 64;
})();

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

/** Rejects a handshake with a reason the client can display, then closes. */
function rejectConnection(ws: WebSocket, message: string): void {
  try {
    ws.send(JSON.stringify({ type: "error", message }));
  } catch {}
  ws.close();
}

wss.on("connection", async (ws: WebSocket, request) => {
  const requestUrl = new URL(request.url || "", `http://${request.headers.host}`);
  const peerId = requestUrl.searchParams.get("peerId");
  const rawName = requestUrl.searchParams.get("name") || "Mystic Guest";
  const name = rawName.replace(/\p{Cc}/gu, "").trim().slice(0, MAX_PEER_NAME_LENGTH) || "Mystic Guest";

  const roomId = requestUrl.searchParams.get("roomId");
  const role = requestUrl.searchParams.get("role");
  const accessToken = requestUrl.searchParams.get("token");

  if (!peerId) {
    rejectConnection(ws, "Missing peerId identifier");
    return;
  }
  // Client-supplied IDs become map keys and routing targets, so validate shape.
  if (!PEER_ID_PATTERN.test(peerId)) {
    rejectConnection(ws, "Invalid peerId format");
    return;
  }
  if (role && role !== "sender" && role !== "receiver") {
    rejectConnection(ws, "Invalid role");
    return;
  }

  const clientIp = getClientIp(request);

  // Reject peer ID collisions instead of silently overwriting the existing
  // entry, which previously let anyone take over another peer's signalling
  // session just by reconnecting with their ID.
  const existingPeer = activePeers.get(peerId);
  if (existingPeer) {
    if (existingPeer.ws.readyState === WebSocket.OPEN || existingPeer.ip !== clientIp) {
      rejectConnection(ws, "This peer ID is already in use. Reconnecting with a new identity.");
      return;
    }
    // Same client whose previous socket is already closing: reclaim the slot.
    activePeers.delete(peerId);
  }

  // Connection limit per IP address
  let connectionsFromIp = 0;
  for (const peer of activePeers.values()) {
    if (peer.ip === clientIp) {
      connectionsFromIp++;
    }
  }
  if (connectionsFromIp >= MAX_CONNECTIONS_PER_IP) {
    rejectConnection(ws, "Too many active connections from this IP address");
    return;
  }

  const newPeer: ConnectedPeer = {
    peerId,
    name,
    ip: clientIp,
    ws,
    lastActive: Date.now(),
    roomId: roomId || undefined,
    role: role || undefined
  };

  if (roomId && role) {
    const room = await getRoom(roomId);
    if (!room || room.expiresAt <= Date.now()) {
      rejectConnection(ws, "Locker has expired or does not exist.");
      return;
    }
    if (room.downloadCount >= room.maxDownloads) {
      rejectConnection(ws, "Locker download limit has been reached.");
      return;
    }

    // Receivers must present a token from /verify-password (or /access for an
    // unprotected locker). Without this the passcode was advisory only: the
    // browser decided for itself whether it had passed.
    if (role === "receiver" && !verifyRoomToken(roomId, accessToken)) {
      rejectConnection(ws, "A valid locker access token is required.");
      return;
    }

    // Only the creator's own session may claim the sender role.
    if (role === "sender" && room.senderPeerId && room.senderPeerId !== peerId) {
      const existingSender = activePeers.get(room.senderPeerId);
      if (existingSender && existingSender.ws.readyState === WebSocket.OPEN) {
        rejectConnection(ws, "This locker already has an active sender.");
        return;
      }
    }

    activePeers.set(peerId, newPeer);
    console.log(`[Discovery Hub] Room Join: "${name}" as ${role} in Room ${roomId}`);

    if (role === "sender") {
      room.senderPeerId = peerId;
      await saveRoom(room);
    } else if (role === "receiver") {
      room.receiverPeerIds.add(peerId);
      await saveRoom(room);
      
      // Notify sender that a receiver joined to initiate WebRTC offer
      if (room.senderPeerId) {
        const sender = activePeers.get(room.senderPeerId);
        if (sender && sender.ws.readyState === WebSocket.OPEN) {
          sender.ws.send(JSON.stringify({
            type: "peer-joined",
            senderPeerId: peerId,
            payload: {}
          }));
        } else if (redisPub) {
          await redisPub.publish("sendfiles:signaling", JSON.stringify({
            type: "peer-joined",
            targetPeerId: room.senderPeerId,
            senderPeerId: peerId,
            payload: {}
          }));
        }
      }
    }
  } else {
    // Normal P2P client connection
    activePeers.set(peerId, newPeer);
    console.log(`[Discovery Hub] Joint connection: Name: "${name}" | ID: ${peerId} | IP: ${clientIp}`);
    await registerPeerInDirectory(newPeer);
    await publishPresenceChange();
    // Broadcasts are already coalesced, so no ad-hoc delay is needed here.
    scheduleBroadcastPeersList();
  }

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 15000);

  // A socket busy streaming binary chunks is alive even though it sends no JSON.
  ws.on("pong", () => {
    const peer = activePeers.get(peerId);
    if (peer && peer.ws === ws) peer.lastActive = Date.now();
  });

  ws.on("message", async (rawMessage, isBinary) => {
    // Refresh liveness for every frame, binary included. Previously the binary
    // branch returned before this ran, so a peer streaming a large file over
    // the relay looked idle and was pruned after 10 minutes mid-transfer.
    const peer = activePeers.get(peerId);
    if (peer && peer.ws === ws) {
      peer.lastActive = Date.now();
    }

    // 1. Handle Binary Chunk Relaying
    if (isBinary) {
      try {
        const buffer = rawMessage as Buffer;
        let offset = 0;
        if (buffer.length < 2) return;

        const msgType = buffer[offset];
        if (msgType !== 0x01) return; // ignore non-relay formats
        offset += 1;

        const targetLen = buffer[offset];
        offset += 1;
        if (targetLen === 0 || buffer.length < offset + targetLen + 1) return;

        const targetPeerId = buffer.toString("utf8", offset, offset + targetLen);
        offset += targetLen;

        const senderLen = buffer[offset];
        offset += 1;
        if (senderLen === 0 || buffer.length < offset + senderLen) return;
        const claimedSenderId = buffer.toString("utf8", offset, offset + senderLen);

        // The frame carries its own sender ID, which the receiver trusts. Bind
        // it to the authenticated connection so a peer cannot inject chunks
        // into someone else's transfer by forging the header.
        if (claimedSenderId !== peerId) {
          console.warn(`[Discovery Hub] Dropping binary frame: sender ${claimedSenderId} does not match connection ${peerId}`);
          return;
        }
        if (!PEER_ID_PATTERN.test(targetPeerId)) return;
        if (!(await canRelayTo(peerId, roomId, targetPeerId))) {
          console.warn(`[Discovery Hub] Dropping binary frame from ${peerId} to unrelated peer ${targetPeerId}`);
          return;
        }

        // Forward buffer
        const target = activePeers.get(targetPeerId);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(buffer, { binary: true });
        } else if (redisPub) {
          await redisPub.publish("sendfiles:signaling_binary", JSON.stringify({
            targetPeerId,
            bufferBase64: buffer.toString("base64")
          }));
        }
      } catch (err) {
        console.error("[Discovery Hub] Binary routing error:", err);
      }
      return;
    }

    // 2. Handle Text (JSON) Messages
    try {
      const message = JSON.parse(rawMessage.toString());
      const { type, targetPeerId, payload } = message;

      if (typeof type !== "string") return;
      if (targetPeerId !== undefined && targetPeerId !== null) {
        if (typeof targetPeerId !== "string" || !PEER_ID_PATTERN.test(targetPeerId)) return;
        if (!(await canRelayTo(peerId, roomId, targetPeerId))) {
          console.warn(`[Discovery Hub] Dropping ${type} from ${peerId} to unrelated peer ${targetPeerId}`);
          return;
        }
      }

      // A download counts once per receiver completing the whole locker. The
      // client now sends this only on "all-complete"; countedPeerIds keeps the
      // tally correct even if the message arrives more than once.
      if (type === "download-complete" && roomId && role === "receiver") {
        const room = await getRoom(roomId);
        if (room && !room.countedPeerIds.has(peerId)) {
          room.countedPeerIds.add(peerId);
          room.downloadCount++;
          console.log(`[Locker Hub] Room ${roomId} download completed. Total: ${room.downloadCount}/${room.maxDownloads}`);
          if (room.downloadCount >= room.maxDownloads) {
            console.log(`[Locker Hub] Room ${roomId} reached download limit. Instantly pruning room.`);
            
            for (const [pId, activePeer] of activePeers.entries()) {
              if (activePeer.roomId === roomId) {
                try {
                  activePeer.ws.send(JSON.stringify({ type: "error", message: "Locker download limit reached" }));
                  activePeer.ws.close();
                } catch {}
                  activePeers.delete(pId);
              }
            }
            if (redisPub) {
              await redisPub.publish("sendfiles:room_prune", roomId);
            }
            await deleteRoom(roomId);
          } else {
            await saveRoom(room);
          }
        }
      }

      // Relay
      if (targetPeerId) {
        const target = activePeers.get(targetPeerId);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify({
            type,
            senderPeerId: peerId,
            senderName: name,
            payload
          }));
        } else if (redisPub) {
          await redisPub.publish("sendfiles:signaling", JSON.stringify({
            type,
            targetPeerId,
            senderPeerId: peerId,
            senderName: name,
            payload
          }));
        }
      } else if (roomId) {
        const room = await getRoom(roomId);
        if (room) {
          if (role === "receiver" && room.senderPeerId) {
            const sender = activePeers.get(room.senderPeerId);
            if (sender && sender.ws.readyState === WebSocket.OPEN) {
              sender.ws.send(JSON.stringify({
                type,
                senderPeerId: peerId,
                senderName: name,
                payload
              }));
            } else if (redisPub) {
              await redisPub.publish("sendfiles:signaling", JSON.stringify({
                type,
                targetPeerId: room.senderPeerId,
                senderPeerId: peerId,
                senderName: name,
                payload
              }));
            }
          } else if (role === "sender") {
            for (const rxId of room.receiverPeerIds) {
              const rx = activePeers.get(rxId);
              if (rx && rx.ws.readyState === WebSocket.OPEN) {
                rx.ws.send(JSON.stringify({
                  type,
                  senderPeerId: peerId,
                  senderName: name,
                  payload
                }));
              } else if (redisPub) {
                await redisPub.publish("sendfiles:signaling", JSON.stringify({
                  type,
                  targetPeerId: rxId,
                  senderPeerId: peerId,
                  senderName: name,
                  payload
                }));
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[Discovery Hub] Message routing error:", err);
    }
  });

  ws.on("close", async () => {
    clearInterval(pingInterval);
    // Only clear the registry slot if it still belongs to this socket.
    const current = activePeers.get(peerId);
    if (current && current.ws === ws) {
      activePeers.delete(peerId);
    }
    console.log(`[Discovery Hub] Left connection: ID ${peerId} ("${name}")`);

    if (roomId) {
      const room = await getRoom(roomId);
      if (room) {
        if (role === "sender") {
          room.senderPeerId = null;
          await saveRoom(room);
          
          for (const rxId of room.receiverPeerIds) {
            const rx = activePeers.get(rxId);
            if (rx && rx.ws.readyState === WebSocket.OPEN) {
              rx.ws.send(JSON.stringify({
                type: "sender-disconnected",
                senderPeerId: peerId
              }));
            } else if (redisPub) {
              await redisPub.publish("sendfiles:signaling", JSON.stringify({
                type: "sender-disconnected",
                targetPeerId: rxId,
                senderPeerId: peerId
              }));
            }
          }
        } else if (role === "receiver") {
          room.receiverPeerIds.delete(peerId);
          await saveRoom(room);
          
          if (room.senderPeerId) {
            const sender = activePeers.get(room.senderPeerId);
            if (sender && sender.ws.readyState === WebSocket.OPEN) {
              sender.ws.send(JSON.stringify({
                type: "peer-left",
                senderPeerId: peerId
              }));
            } else if (redisPub) {
              await redisPub.publish("sendfiles:signaling", JSON.stringify({
                type: "peer-left",
                targetPeerId: room.senderPeerId,
                senderPeerId: peerId
              }));
            }
          }
        }
      }
    } else {
      await unregisterPeerFromDirectory(peerId);
      await publishPresenceChange();
      scheduleBroadcastPeersList();
    }
  });

  ws.on("error", (err) => {
    console.error(`[Discovery Hub] WebSocket Error for peer ${peerId}:`, err);
  });
});

const handleUpgrade = (request: any, socket: any, head: any) => {
  const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
  if (pathname === "/signaling") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
};

server.on("upgrade", handleUpgrade);
httpsServer.on("upgrade", handleUpgrade);

// Clean stale inactive connections and expired rooms
setInterval(async () => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000;

  let prunedAnyPeer = false;
  for (const [pId, info] of activePeers.entries()) {
    if (now - info.lastActive > timeout) {
      console.log(`[Discovery Hub] Pruning inactive peer ${pId}`);
      info.ws.close();
      activePeers.delete(pId);
      await unregisterPeerFromDirectory(pId);
      prunedAnyPeer = true;
    }
  }
  if (prunedAnyPeer) {
    await publishPresenceChange();
    scheduleBroadcastPeersList();
  }

  if (redisClient) {
    const roomIds: string[] = await redisClient.sMembers("sendfiles:active_rooms");
    if (roomIds.length > 0) {
      // Single round-trip instead of one EXISTS per room.
      const payloads: (string | null)[] = await redisClient.mGet(
        roomIds.map((rId) => `sendfiles:room:${rId}`)
      );
      const staleIds = roomIds.filter((_, idx) => !payloads[idx]);
      if (staleIds.length > 0) {
        console.log(`[Redis Cluster] Pruning ${staleIds.length} expired room(s) from set`);
        await redisClient.sRem("sendfiles:active_rooms", staleIds);
      }
    }
  } else {
    for (const [rId, room] of rooms.entries()) {
      if (now > room.expiresAt || room.downloadCount >= room.maxDownloads) {
        console.log(`[Locker Hub] Pruning expired/exhausted Locker Room ${rId}`);
        for (const [pId, activePeer] of activePeers.entries()) {
          if (activePeer.roomId === rId) {
            try {
              activePeer.ws.send(JSON.stringify({ type: "error", message: "Locker room expired or pruned" }));
              activePeer.ws.close();
            } catch {}
            activePeers.delete(pId);
          }
        }
        rooms.delete(rId);
      }
    }
  }
}, 60000);

// Keep this instance's directory entries fresh so other instances don't age
// them out mid-session.
setInterval(() => {
  if (!redisClient) return;
  for (const peer of activePeers.values()) {
    if (!peer.roomId && peer.ws.readyState === WebSocket.OPEN) {
      registerPeerInDirectory(peer).catch(() => {});
    }
  }
}, PEER_DIRECTORY_REFRESH_MS);

/**
 * Probes ports starting at `preferred` and returns the first one this server
 * can bind, or null if none in the range are free.
 *
 * The probe binds and releases a throwaway listener so the caller can then
 * listen normally. EADDRINUSE and EACCES are both treated as "taken" — Windows
 * reports an excluded or reserved port range as EACCES.
 */
async function findAvailablePort(
  preferred: number,
  label: string,
  reserved: Set<number>,
  attempts = 10
): Promise<number | null> {
  for (let offset = 0; offset < attempts; offset++) {
    const candidate = preferred + offset;
    // A probe only proves the port was free a moment ago, so ports already
    // handed out in this same pass must be skipped explicitly.
    if (reserved.has(candidate)) continue;

    const free = await new Promise<boolean>((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(candidate, "0.0.0.0");
    });

    if (free) {
      if (candidate !== preferred) {
        console.warn(
          `\x1b[33m[warn] ${label} port ${preferred} is unavailable; using ${candidate} instead.\x1b[0m`
        );
      }
      reserved.add(candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * Turns a listen failure into a readable message instead of an unhandled
 * 'error' event. A probe can still lose a race with another process, and a
 * double-clicked binary must not die with a raw Node stack trace.
 */
function attachListenErrorHandler(server: http.Server | https.Server, label: string): void {
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" || err.code === "EACCES") {
      console.error(
        `\n\x1b[31m${label} could not start: port is already in use.\n` +
        `Pick your own ports, for example:\n` +
        `  PORT=8080 HTTPS_PORT=8443 ${isPackaged ? "sendfiles" : "npm start"}\x1b[0m\n`
      );
    } else {
      console.error(`\n\x1b[31m${label} server error: ${err.message}\x1b[0m\n`);
    }
    process.exit(1);
  });
}

async function startApp() {
  await initRedis();
  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = __dirname;
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      // Unknown API routes must 404 rather than silently returning the SPA
      // shell, which otherwise surfaces as a JSON parse error in the client.
      if (req.path.startsWith("/api/")) {
        return res.status(404).json({ error: "Not found" });
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Find free ports before binding. A packaged binary is launched by
  // double-clicking, and port 3000 is very often already taken; the process
  // used to die with an unhandled 'error' event and a raw Node stack trace.
  const reservedPorts = new Set<number>();
  const httpPort = await findAvailablePort(PORT, "HTTP", reservedPorts);
  const httpsPort = await findAvailablePort(HTTPS_PORT, "HTTPS", reservedPorts);

  attachListenErrorHandler(server, "HTTP");
  attachListenErrorHandler(httpsServer, "HTTPS");

  if (httpPort === null || httpsPort === null) {
    console.error(
      `\n\x1b[31mCould not start: no free port found near ${PORT}/${HTTPS_PORT}.\n` +
      `Close whatever is using those ports, or pick your own:\n` +
      `  PORT=8080 HTTPS_PORT=8443 ${isPackaged ? "sendfiles" : "npm start"}\x1b[0m\n`
    );
    process.exit(1);
  }

  server.listen(httpPort, "0.0.0.0", () => {});

  httpsServer.listen(httpsPort, "0.0.0.0", () => {
    const localUrlHttp = `http://localhost:${httpPort}`;
    const localUrlHttps = `https://localhost:${httpsPort}`;
    console.log(`\n==================================================`);
    console.log(`P2P Direct SendFiles platform ready & listening.`);
    console.log(`HTTP Local Access URL:  \x1b[36m${localUrlHttp}\x1b[0m`);
    console.log(`HTTPS Local Access URL: \x1b[36m${localUrlHttps}\x1b[0m (Recommended for LAN sharing)`);
    
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
      const iface = interfaces[devName];
      if (iface) {
        for (const alias of iface) {
          if (alias.family === "IPv4" && !alias.internal) {
            console.log(`Network Access HTTP:  \x1b[36mhttp://${alias.address}:${httpPort}\x1b[0m`);
            console.log(`Network Access HTTPS: \x1b[36mhttps://${alias.address}:${httpsPort}\x1b[0m (For mobile/secure context)`);
          }
        }
      }
    }
    console.log(`--------------------------------------------------`);
    console.log(`Discovery mode: ${discoveryMode}${process.env.DISCOVERY_MODE ? " (from DISCOVERY_MODE)" : " (auto-detected)"}`);
    console.log(`Trust proxy:    ${isBehindProxy ? String(trustProxySetting) : "disabled"}`);
    if (!isLocalDesktop && !isBehindProxy) {
      console.warn(
        `\x1b[33m[warn] Serving on a non-desktop host without TRUST_PROXY. If a reverse proxy\n` +
        `       sits in front of this server, set TRUST_PROXY=1 so client IPs and rate\n` +
        `       limits are evaluated correctly.\x1b[0m`
      );
    }
    if (discoveryMode === "lan" && isBehindProxy) {
      console.warn(
        `\x1b[33m[warn] DISCOVERY_MODE=lan combined with a reverse proxy places every client\n` +
        `       into one discovery group. Use "strict" or "off" for public deployments.\x1b[0m`
      );
    }
    if (!process.env.ROOM_TOKEN_SECRET) {
      console.log(`Locker tokens:  ephemeral (set ROOM_TOKEN_SECRET to persist across restarts)`);
    }
    console.log(`==================================================\n`);

    // Machine-readable handshake for the Electron shell, which spawns this
    // server as a child process and needs the port that was actually bound
    // (the preferred one may have been taken).
    console.log(
      `SENDFILES_READY ${JSON.stringify({
        httpPort,
        httpsPort,
        httpUrl: localUrlHttp,
        httpsUrl: localUrlHttps
      })}`
    );

    if (isLocalDesktop && process.env.NO_OPEN !== "true") {
      const startCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${startCommand} ${localUrlHttp}`, (err) => {
        if (err) {
          console.log(`Could not automatically open browser: ${err.message}`);
        } else {
          console.log(`Opened browser to ${localUrlHttp}`);
        }
      });
    }
  });
}

startApp().catch((err) => {
  console.error("Critical error starting Express WebRTC application:", err);
});
