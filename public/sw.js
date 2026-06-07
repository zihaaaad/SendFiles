/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Service Worker for streaming files from IndexedDB to the local disk
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname === "/api/download-stream") {
    const roomId = url.searchParams.get("roomId");
    const fileIndex = parseInt(url.searchParams.get("fileIndex") || "0", 10);
    const totalChunks = parseInt(url.searchParams.get("totalChunks") || "0", 10);
    const fileName = url.searchParams.get("name") || "download";
    const fileSize = parseInt(url.searchParams.get("size") || "0", 10);

    if (!roomId) {
      event.respondWith(new Response("Missing roomId parameter", { status: 400 }));
      return;
    }

    const DB_NAME = "FileDropP2P_Cache_v1";
    const CHUNK_STORE = "file_chunks";

    // Helper to open IndexedDB
    const openDB = () => {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    };

    // Helper to retrieve a chunk
    const getChunk = (db, roomId, fileIdx, chunkIdx) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(CHUNK_STORE, "readonly");
        const store = tx.objectStore(CHUNK_STORE);
        const key = `${roomId}_f${fileIdx}_c${chunkIdx}`;
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ? req.result.data : null);
        req.onerror = () => reject(req.error);
      });
    };

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const db = await openDB();
          for (let i = 0; i < totalChunks; i++) {
            let chunk = await getChunk(db, roomId, fileIndex, i);
            
            // Retry mechanism if the chunk is still writing (unlikely but safe)
            let retries = 0;
            while (!chunk && retries < 5) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              chunk = await getChunk(db, roomId, fileIndex, i);
              retries++;
            }

            if (!chunk) {
              throw new Error(`Missing chunk index ${i} during streaming assembly`);
            }
            
            controller.enqueue(new Uint8Array(chunk));
          }
          controller.close();
        } catch (err) {
          console.error("Streaming download failed:", err);
          controller.error(err);
        }
      }
    });

    const safeAsciiName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    const contentDisposition = `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

    event.respondWith(
      new Response(stream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": contentDisposition,
          "Content-Length": fileSize.toString(),
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "X-Content-Type-Options": "nosniff",
        },
      })
    );
  }
});
