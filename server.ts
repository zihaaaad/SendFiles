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
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import os from "os";
import { exec } from "child_process";
import selfsigned from "selfsigned";

dotenv.config();

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

// Fetch Public IP
app.get("/api/ip", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const forwarded = req.headers["x-forwarded-for"];
  const publicIp = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress || "127.0.0.1";
  res.json({ ip: publicIp });
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
  senderPeerId: string | null;
  receiverPeerIds: Set<string>;
  creatorIp: string;
}

// In-Memory Room Registry
const rooms = new Map<string, Room>();

// ----------------------------------------------------
// Express Rest API Endpoints for Lockers
// ----------------------------------------------------

// 1. Create a secure locker
app.post("/api/rooms", (req, res) => {
  try {
    const { files, maxDownloads, expiresInMins, passwordHash } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "Files array is required" });
    }

    // Generate unique, readable 6-character uppercase Room ID
    let roomId = "";
    do {
      roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    } while (rooms.has(roomId));

    // Get creator public IP for local network discovery
    const forwarded = req.headers["x-forwarded-for"];
    const creatorIp = typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.socket.remoteAddress || "127.0.0.1";

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
      senderPeerId: null,
      receiverPeerIds: new Set<string>(),
      creatorIp
    };

    rooms.set(roomId, newRoom);
    console.log(`[Locker Hub] Created Locker ${roomId} | Files: ${newRoom.files.length} | IP: ${creatorIp}`);

    res.status(201).json({
      roomId: newRoom.id,
      expiresAt: newRoom.expiresAt,
      maxDownloads: newRoom.maxDownloads,
      downloadCount: newRoom.downloadCount,
      hasPassword: newRoom.passwordHash !== null,
      files: newRoom.files
    });
  } catch (err: any) {
    console.error("Error creating locker:", err);
    res.status(500).json({ error: "Failed to create secure locker" });
  }
});

// 2. Scan active lockers (Discovery Hub matching local IP)
app.get("/api/rooms", (req, res) => {
  const forwarded = req.headers["x-forwarded-for"];
  const clientIp = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress || "127.0.0.1";

  const activeRooms: any[] = [];
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.expiresAt > now && ipsMatchForDiscovery(room.creatorIp, clientIp) && room.downloadCount < room.maxDownloads) {
      activeRooms.push({
        roomId: room.id,
        expiresAt: room.expiresAt,
        maxDownloads: room.maxDownloads,
        downloadCount: room.downloadCount,
        hasPassword: room.passwordHash !== null,
        files: room.files
      });
    }
  }

  res.json(activeRooms);
});

// 3. Get specific locker details
app.get("/api/rooms/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

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
    files: room.files
  });
});

// 4. Verify password PIN
app.post("/api/rooms/:roomId/verify-password", (req, res) => {
  const { roomId } = req.params;
  const { passwordHash } = req.body;
  const room = rooms.get(roomId);

  if (!room || room.expiresAt <= Date.now()) {
    return res.status(404).json({ error: "Locker not found or has expired" });
  }

  if (room.passwordHash === passwordHash) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Incorrect passcode PIN" });
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
    .filter(p => !p.roomId) // only broadcast zero-config peers
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

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, request) => {
  const requestUrl = new URL(request.url || "", `http://${request.headers.host}`);
  const peerId = requestUrl.searchParams.get("peerId");
  const name = requestUrl.searchParams.get("name") || "Mystic Guest";

  // Room config parameters
  const roomId = requestUrl.searchParams.get("roomId");
  const role = requestUrl.searchParams.get("role");

  if (!peerId) {
    ws.send(JSON.stringify({ type: "error", message: "Missing peerId identifier" }));
    ws.close();
    return;
  }

  const forwarded = request.headers["x-forwarded-for"];
  const clientIp = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : request.socket.remoteAddress || "127.0.0.1";

  const newPeer: ConnectedPeer = {
    peerId,
    name,
    ip: clientIp,
    ws,
    lastActive: Date.now(),
    roomId: roomId || undefined,
    role: role || undefined
  };

  // If room is specified, validate and wire up room discovery
  if (roomId && role) {
    const room = rooms.get(roomId);
    if (!room || room.expiresAt <= Date.now()) {
      ws.send(JSON.stringify({ type: "error", message: "Locker has expired or does not exist." }));
      ws.close();
      return;
    }

    activePeers.set(peerId, newPeer);
    console.log(`[Discovery Hub] Room Join: "${name}" as ${role} in Room ${roomId}`);

    if (role === "sender") {
      room.senderPeerId = peerId;
    } else if (role === "receiver") {
      room.receiverPeerIds.add(peerId);
      
      // Notify sender that a receiver joined, sharing receiver's peerId to initiate WebRTC offer
      if (room.senderPeerId) {
        const sender = activePeers.get(room.senderPeerId);
        if (sender && sender.ws.readyState === WebSocket.OPEN) {
          sender.ws.send(JSON.stringify({
            type: "peer-joined",
            senderPeerId: peerId, // Receiver peerId
            payload: {}
          }));
        }
      }
    }
  } else {
    // Normal zero-config P2P client connection
    activePeers.set(peerId, newPeer);
    console.log(`[Discovery Hub] Joint connection: Name: "${name}" | ID: ${peerId} | IP: ${clientIp}`);
    setTimeout(() => {
      broadcastPeersList();
    }, 100);
  }

  // Heartbeat check interval
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 15000);

  ws.on("message", (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());
      const { type, targetPeerId, payload } = message;

      // Keep alive timestamp
      const peer = activePeers.get(peerId);
      if (peer) {
        peer.lastActive = Date.now();
      }

      // Check for download completion signals to update locker stats
      if (type === "download-complete" && roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.downloadCount++;
          console.log(`[Locker Hub] Room ${roomId} download completed. Total: ${room.downloadCount}/${room.maxDownloads}`);
          if (room.downloadCount >= room.maxDownloads) {
            console.log(`[Locker Hub] Room ${roomId} reached download limit. Instantly pruning room.`);
            // Close active websocket connections for this locker
            for (const [pId, activePeer] of activePeers.entries()) {
              if (activePeer.roomId === roomId) {
                try {
                  activePeer.ws.send(JSON.stringify({ type: "error", message: "Locker download limit reached" }));
                  activePeer.ws.close();
                } catch {}
                activePeers.delete(pId);
              }
            }
            rooms.delete(roomId);
          }
        }
      }

      // 1. Direct relay channels
      if (targetPeerId) {
        const target = activePeers.get(targetPeerId);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify({
            type,
            senderPeerId: peerId,
            senderName: name,
            payload
          }));
        }
      } else if (roomId) {
        // 2. Room-based signaling channel (fallback when targetPeerId is omitted by receivers)
        const room = rooms.get(roomId);
        if (room) {
          if (role === "receiver" && room.senderPeerId) {
            // Forward back to sender
            const sender = activePeers.get(room.senderPeerId);
            if (sender && sender.ws.readyState === WebSocket.OPEN) {
              sender.ws.send(JSON.stringify({
                type,
                senderPeerId: peerId,
                senderName: name,
                payload
              }));
            }
          } else if (role === "sender") {
            // Broadcast to all receivers in the room
            for (const rxId of room.receiverPeerIds) {
              const rx = activePeers.get(rxId);
              if (rx && rx.ws.readyState === WebSocket.OPEN) {
                rx.ws.send(JSON.stringify({
                  type,
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

  ws.on("close", () => {
    clearInterval(pingInterval);
    activePeers.delete(peerId);
    console.log(`[Discovery Hub] Left connection: ID ${peerId} ("${name}")`);

    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        if (role === "sender") {
          room.senderPeerId = null;
          // Notify receivers that sender went offline
          for (const rxId of room.receiverPeerIds) {
            const rx = activePeers.get(rxId);
            if (rx && rx.ws.readyState === WebSocket.OPEN) {
              rx.ws.send(JSON.stringify({
                type: "sender-disconnected",
                senderPeerId: peerId
              }));
            }
          }
        } else if (role === "receiver") {
          room.receiverPeerIds.delete(peerId);
          // Notify sender that receiver left
          if (room.senderPeerId) {
            const sender = activePeers.get(room.senderPeerId);
            if (sender && sender.ws.readyState === WebSocket.OPEN) {
              sender.ws.send(JSON.stringify({
                type: "peer-left",
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

// Upgrade handling for WebSockets
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
setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000; // 10 minutes max inactive

  // Clean inactive sockets
  for (const [pId, info] of activePeers.entries()) {
    if (now - info.lastActive > timeout) {
      console.log(`[Discovery Hub] Pruning inactive peer ${pId}`);
      info.ws.close();
      activePeers.delete(pId);
    }
  }

  // Clean expired rooms
  for (const [rId, room] of rooms.entries()) {
    if (now > room.expiresAt || room.downloadCount >= room.maxDownloads) {
      console.log(`[Locker Hub] Pruning expired/exhausted Locker Room ${rId}`);
      // Close active websocket connections for this locker
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
}, 60000);

// Vite Middleware for Asset Serving / Compilation
async function startApp() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const isPackaged = typeof (process as any).pkg !== "undefined";
    const distPath = isPackaged ? __dirname : path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Start HTTP Server
  server.listen(PORT, "0.0.0.0", () => {
    // Shared logging is handled in the HTTPS server startup block
  });

  // Start HTTPS Server
  httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    const localUrlHttp = `http://localhost:${PORT}`;
    const localUrlHttps = `https://localhost:${HTTPS_PORT}`;
    console.log(`\n==================================================`);
    console.log(`P2P Direct SendFiles platform ready & listening.`);
    console.log(`HTTP Local Access URL:  \x1b[36m${localUrlHttp}\x1b[0m`);
    console.log(`HTTPS Local Access URL: \x1b[36m${localUrlHttps}\x1b[0m (Recommended for LAN sharing)`);
    
    // Log local network IPs
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

    // Auto-open browser in dev mode
    if (process.env.NODE_ENV !== "production") {
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
