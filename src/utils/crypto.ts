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

// ----------------------------------------------------
// Direct Beam key agreement (ECDH P-256)
//
// Direct Beam has no shared link secret, so both sides derive one over the
// signalling channel. The server only ever sees public keys, which means a
// relay fallback no longer carries plaintext file bytes through it.
//
// NOTE: this is unauthenticated ECDH. It stops a passive signalling server from
// reading transfers, but an active server could still substitute its own keys.
// compareSafetyCode() below lets both people detect that by eye.
// ----------------------------------------------------

export interface KeyAgreementPair {
  keyPair: CryptoKeyPair;
  publicKeyHex: string;
}

/** Creates an ephemeral ECDH key pair for a single transfer. */
export async function generateKeyAgreementPair(): Promise<KeyAgreementPair> {
  const keyPair = await window.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );
  const raw = await window.crypto.subtle.exportKey("raw", keyPair.publicKey);
  return { keyPair, publicKeyHex: bytesToHex(new Uint8Array(raw)) };
}

/** Derives the shared AES-256-GCM transfer key from the peer's public key. */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  peerPublicKeyHex: string
): Promise<CryptoKey> {
  const peerPublicKey = await importPeerPublicKey(peerPublicKeyHex);
  return await window.crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function importPeerPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  // Uncompressed P-256 points are 65 bytes: 0x04 || X(32) || Y(32).
  if (!/^[0-9a-fA-F]{130}$/.test(publicKeyHex) || !publicKeyHex.startsWith("04")) {
    throw new Error("Invalid peer public key for key agreement.");
  }
  return await window.crypto.subtle.importKey(
    "raw",
    hexToBytes(publicKeyHex),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}

/**
 * Derives a short human-comparable code from the agreed key. Both devices show
 * the same six digits when no one is sitting in the middle.
 */
export async function computeSafetyCode(sharedKey: CryptoKey): Promise<string> {
  const raw = await window.crypto.subtle.exportKey("raw", sharedKey);
  const digest = await window.crypto.subtle.digest("SHA-256", raw);
  const view = new DataView(digest);
  return String(view.getUint32(0, false) % 1000000).padStart(6, "0");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
}

export interface PasswordHashResult {
  hash: string;
  salt: string;
}

// Secure PBKDF2 hashing for room passwords (600,000 iterations of SHA-256)
export async function hashPassword(password: string, saltHex?: string): Promise<PasswordHashResult> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  
  let salt: Uint8Array;
  if (saltHex) {
    salt = new Uint8Array(
      saltHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );
  } else {
    salt = window.crypto.getRandomValues(new Uint8Array(16));
  }
  
  const baseKey = await window.crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );
  
  const derivedBits = await window.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 600000,
      hash: "SHA-256",
    },
    baseKey,
    256
  );
  
  const hash = Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
    
  const saltStr = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
    
  return { hash, salt: saltStr };
}
