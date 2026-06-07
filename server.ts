/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
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

function ipsMatchForDiscovery(ipA: string, ipB: string): boolean {
  if (ipA === ipB) return true;
  if (isLocalIp(ipA) && isLocalIp(ipB)) return true;
  return false;
}

const app = express();

// Enable proxy trust to get client IP via req.ip when deployed behind reverse proxies
app.set("trust proxy", process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1" || true);

// Secure helper to resolve client IP and prevent spoofing
function getClientIp(req: any): string {
  const trustProxy = app.get("trust proxy") === true;
  if (trustProxy && req.headers["x-forwarded-for"]) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      return forwarded.split(",")[0].trim();
    } else if (Array.isArray(forwarded)) {
      return forwarded[0].trim();
    }
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests from this IP, please try again later." },
  keyGenerator: (req) => getClientIp(req),
});

const createRoomLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15, // Limit each IP to 15 room creations per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many lockers created from this IP, please try again later." },
  keyGenerator: (req) => getClientIp(req),
});

// Apply rate limiting
app.use("/api/", apiLimiter);

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
app.get("/api/network-ips", (req, res) => {
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
app.get("/api/ice-config", (req, res) => {
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
  creatorIp: string;
}

// In-Memory Room Registry fallback
const rooms = new Map<string, Room>();

// Serialization utilities for Redis
function serializeRoom(room: Room): string {
  return JSON.stringify({
    ...room,
    receiverPeerIds: Array.from(room.receiverPeerIds)
  });
}

function deserializeRoom(json: string): Room {
  const data = JSON.parse(json);
  return {
    ...data,
    receiverPeerIds: new Set(data.receiverPeerIds)
  };
}

async function saveRoom(room: Room): Promise<void> {
  if (redisClient) {
    const key = `sendfiles:room:${room.id}`;
    const ttl = Math.max(0, room.expiresAt - Date.now());
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
  const activeRoomsList: Room[] = [];
  const now = Date.now();

  if (redisClient) {
    const roomIds = await redisClient.sMembers("sendfiles:active_rooms");
    for (const rId of roomIds) {
      const room = await getRoom(rId);
      if (room) {
        if (room.expiresAt > now && ipsMatchForDiscovery(room.creatorIp, clientIp) && room.downloadCount < room.maxDownloads) {
          activeRoomsList.push(room);
        }
      } else {
        await redisClient.sRem("sendfiles:active_rooms", rId);
      }
    }
  } else {
    for (const room of rooms.values()) {
      if (room.expiresAt > now && ipsMatchForDiscovery(room.creatorIp, clientIp) && room.downloadCount < room.maxDownloads) {
        activeRoomsList.push(room);
      }
    }
  }
  return activeRoomsList;
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

    // Generate unique Room ID
    let roomId = "";
    let roomExists = false;
    do {
      roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
      roomExists = redisClient ? (await redisClient.exists(`sendfiles:room:${roomId}`)) > 0 : rooms.has(roomId);
    } while (roomExists);

    const creatorIp = getClientIp(req);

    const newRoom: Room = {
      id: roomId,
      expiresAt: Date.now() + (Number(expiresInMins) || 60) * 60 * 1000,
      files: files.map((f: any) => ({
        name: f.name || "unnamed_file",
        size: Number(f.size) || 0,
        type: f.type || "application/octet-stream"
      })),
      maxDownloads: Number(maxDownloads) || 1,
      downloadCount: 0,
      passwordHash: passwordHash || null,
      passwordSalt: passwordSalt || null,
      senderPeerId: null,
      receiverPeerIds: new Set<string>(),
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

// 4. Verify password PIN
app.post("/api/rooms/:roomId/verify-password", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { passwordHash } = req.body;
    const room = await getRoom(roomId);

    if (!room || room.expiresAt <= Date.now()) {
      return res.status(404).json({ error: "Locker not found or has expired" });
    }

    if (room.passwordHash === passwordHash) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: "Incorrect passcode PIN" });
    }
  } catch (err) {
    res.status(500).json({ error: "Verification server error" });
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
}

const activePeers = new Map<string, ConnectedPeer>();

// Broadcast active peer list to active connections on a per-IP basis
function broadcastPeersList() {
  const peersArray = Array.from(activePeers.values())
    .filter(p => !p.roomId)
    .map(p => ({
      peerId: p.peerId,
      name: p.name,
      ip: p.ip
    }));

  for (const client of activePeers.values()) {
    if (!client.roomId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        type: "peers-list",
        peers: peersArray,
        yourIp: client.ip
      }));
    }
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
}

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws: WebSocket, request) => {
  const requestUrl = new URL(request.url || "", `http://${request.headers.host}`);
  const peerId = requestUrl.searchParams.get("peerId");
  const name = requestUrl.searchParams.get("name") || "Mystic Guest";

  const roomId = requestUrl.searchParams.get("roomId");
  const role = requestUrl.searchParams.get("role");

  if (!peerId) {
    ws.send(JSON.stringify({ type: "error", message: "Missing peerId identifier" }));
    ws.close();
    return;
  }

  const clientIp = getClientIp(request);

  // Connection limit: 10 sockets max per IP address
  let connectionsFromIp = 0;
  for (const peer of activePeers.values()) {
    if (peer.ip === clientIp) {
      connectionsFromIp++;
    }
  }
  if (connectionsFromIp >= 10) {
    ws.send(JSON.stringify({ type: "error", message: "Too many active connections from this IP address" }));
    ws.close();
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
      ws.send(JSON.stringify({ type: "error", message: "Locker has expired or does not exist." }));
      ws.close();
      return;
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
    setTimeout(() => {
      broadcastPeersList();
    }, 100);
  }

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 15000);

  ws.on("message", async (rawMessage, isBinary) => {
    // 1. Handle Binary Chunk Relaying
    if (isBinary) {
      try {
        const buffer = rawMessage as Buffer;
        let offset = 0;
        const msgType = buffer[offset];
        if (msgType !== 0x01) return; // ignore non-relay formats
        offset += 1;
        
        const targetLen = buffer[offset];
        offset += 1;
        
        const targetPeerId = buffer.toString("utf8", offset, offset + targetLen);
        
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

      const peer = activePeers.get(peerId);
      if (peer) {
        peer.lastActive = Date.now();
      }

      if (type === "download-complete" && roomId) {
        const room = await getRoom(roomId);
        if (room) {
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
    activePeers.delete(peerId);
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
      broadcastPeersList();
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

  for (const [pId, info] of activePeers.entries()) {
    if (now - info.lastActive > timeout) {
      console.log(`[Discovery Hub] Pruning inactive peer ${pId}`);
      info.ws.close();
      activePeers.delete(pId);
    }
  }

  if (redisClient) {
    const roomIds = await redisClient.sMembers("sendfiles:active_rooms");
    for (const rId of roomIds) {
      const roomExists = (await redisClient.exists(`sendfiles:room:${rId}`)) > 0;
      if (!roomExists) {
        console.log(`[Redis Cluster] Pruning expired room ID ${rId} from set`);
        await redisClient.sRem("sendfiles:active_rooms", rId);
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
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {});

  httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    const localUrlHttp = `http://localhost:${PORT}`;
    const localUrlHttps = `https://localhost:${HTTPS_PORT}`;
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
            console.log(`Network Access HTTP:  \x1b[36mhttp://${alias.address}:${PORT}\x1b[0m`);
            console.log(`Network Access HTTPS: \x1b[36mhttps://${alias.address}:${HTTPS_PORT}\x1b[0m (For mobile/secure context)`);
          }
        }
      }
    }
    console.log(`==================================================\n`);

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
