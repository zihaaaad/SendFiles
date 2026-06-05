/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Handles client-side encryption of slices of file data using AES-256-GCM.
 * The encryption keys are ephemeral and stored within the URL Hash, meaning they are
 * never transmitted to the signaling server.
 */

// Generate a brand new cryptographically secure AES-256-GCM key
export async function generateSecretKey(): Promise<CryptoKey> {
  return await window.crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    true, // exportable
    ["encrypt", "decrypt"]
  );
}

// Convert a CryptoKey object to a hex string for use in hash URL param
export async function exportKeyToHex(key: CryptoKey): Promise<string> {
  const rawKey = await window.crypto.subtle.exportKey("raw", key);
  return Array.from(new Uint8Array(rawKey))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Recreate a CryptoKey object from a exported hex string
export async function importKeyFromHex(hex: string): Promise<CryptoKey> {
  if (!hex || hex.length !== 64) {
    throw new Error("Invalid encryption key length. Must be a 256-bit Hex string.");
  }
  const bytes = new Uint8Array(
    hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  );
  return await window.crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}

// Encrypt a single chunk of array buffer data
export async function encryptChunk(
  key: CryptoKey,
  chunk: ArrayBuffer
): Promise<ArrayBuffer> {
  // Generate a random 12-byte IV for GCM
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  
  const encrypted = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    chunk
  );

  // Buffer layout: [12 bytes IV | Encrypted Buffer Payload]
  const packed = new Uint8Array(12 + encrypted.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(encrypted), 12);
  return packed.buffer;
}

// Decrypt a single packed chunk (containing 12-byte IV + encrypted data)
export async function decryptChunk(
  key: CryptoKey,
  packedChunk: ArrayBuffer
): Promise<ArrayBuffer> {
  const iv = new Uint8Array(packedChunk, 0, 12);
  const ciphertext = new Uint8Array(packedChunk, 12);

  return await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    ciphertext
  );
}

// Fast SHA-256 hashing for room passwords
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
  
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
