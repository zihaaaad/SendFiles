/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Clean browser Database manager using IndexedDB to buffer file chunks.
 * This guarantees the tab doesn't crash from memory exhaustion (even on huge files, e.g. 5GB+).
 */

const DB_NAME = "FileDropP2P_Cache_v1";
const CHUNK_STORE = "file_chunks";

function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        // Create an index on room + fileIndex + chunkIndex for linear retrieval
        const store = db.createObjectStore(CHUNK_STORE, { keyPath: "id" });
        store.createIndex("by_room_file", ["roomId", "fileIndex"]);
      }
    };
  });
}

export async function saveChunkToDB(
  roomId: string,
  fileIndex: number,
  chunkIndex: number,
  data: ArrayBuffer
): Promise<void> {
  const db = await getDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const store = tx.objectStore(CHUNK_STORE);
    
    const key = `${roomId}_f${fileIndex}_c${chunkIndex}`;
    const value = {
      id: key,
      roomId,
      fileIndex,
      chunkIndex,
      data,
    };

    const req = store.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function compileFilesFromDB(
  roomId: string,
  fileIndex: number,
  totalChunks: number
): Promise<Blob[]> {
  const db = await getDB();
  return new Promise<Blob[]>((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, "readonly");
    const store = tx.objectStore(CHUNK_STORE);
    const index = store.index("by_room_file");

    const range = IDBKeyRange.only([roomId, fileIndex]);
    const req = index.openCursor(range);
    
    const chunksMap = new Map<number, ArrayBuffer>();

    req.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        const item = cursor.value;
        chunksMap.set(item.chunkIndex, item.data);
        cursor.continue();
      } else {
        // Assembly
        const finalChunks: Blob[] = [];
        for (let i = 0; i < totalChunks; i++) {
          const chunkData = chunksMap.get(i);
          if (!chunkData) {
            reject(new Error(`Missing chunk index ${i} during compilation`));
            return;
          }
          finalChunks.push(new Blob([chunkData]));
        }
        resolve(finalChunks);
      }
    };

    req.onerror = () => reject(req.error);
  });
}

export async function clearRoomFromDB(roomId: string): Promise<void> {
  const db = await getDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const store = tx.objectStore(CHUNK_STORE);
    const index = store.index("by_room_file");
    
    // Scan structure is to find all that match roomId and delete them
    const range = IDBKeyRange.bound([roomId, 0], [roomId, Infinity]);
    const req = index.openCursor(range);

    req.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        store.delete(cursor.value.id);
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}
