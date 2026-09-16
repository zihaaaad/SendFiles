/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  generateSecretKey,
  exportKeyToHex,
  importKeyFromHex,
  encryptChunk,
  decryptChunk,
  hashPassword,
  generateKeyAgreementPair,
  deriveSharedKey,
  computeSafetyCode,
} from "./crypto";

beforeAll(() => {
  // Mock window context for Node.js environment so that window.crypto is resolved
  if (typeof window === "undefined") {
    global.window = globalThis as any;
  }
});

describe("SendFiles Cryptography Module", () => {
  it("should generate a cryptographically secure key", async () => {
    const key = await generateSecretKey();
    expect(key).toBeDefined();
    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
  });

  it("should export and import keys correctly (round-trip)", async () => {
    const key = await generateSecretKey();
    const hex = await exportKeyToHex(key);
    expect(hex).toHaveLength(64); // 256-bit key in hex is 64 characters

    const importedKey = await importKeyFromHex(hex);
    expect(importedKey).toBeDefined();
    expect(importedKey.type).toBe("secret");
  });

  it("should encrypt and decrypt chunks accurately", async () => {
    const key = await generateSecretKey();
    
    // Create a mock 100-byte file chunk
    const originalData = new Uint8Array(100);
    for (let i = 0; i < 100; i++) {
      originalData[i] = i;
    }

    const encryptedData = await encryptChunk(key, originalData.buffer);
    expect(encryptedData.byteLength).toBe(100 + 12 + 16); // Original + 12-byte IV + 16-byte auth tag (GCM)

    const decryptedData = await decryptChunk(key, encryptedData);
    const decryptedBytes = new Uint8Array(decryptedData);

    expect(decryptedBytes).toEqual(originalData);
  });

  it("should hash passwords consistently using PBKDF2 key stretching", async () => {
    const password = "SuperSecretPassword123";
    
    // Hash without providing salt (generates a new salt)
    const result1 = await hashPassword(password);
    expect(result1.hash).toBeDefined();
    expect(result1.salt).toBeDefined();
    expect(result1.salt).toHaveLength(32); // 16 bytes in hex is 32 characters

    // Hash again with the same password and the first salt
    const result2 = await hashPassword(password, result1.salt);
    expect(result2.hash).toBe(result1.hash);
    expect(result2.salt).toBe(result1.salt);

    // Hash with a different salt
    const result3 = await hashPassword(password);
    expect(result3.hash).not.toBe(result1.hash);
    expect(result3.salt).not.toBe(result1.salt);

    // Hash a different password with the same salt
    const result4 = await hashPassword("DifferentPassword456", result1.salt);
    expect(result4.hash).not.toBe(result1.hash);
    expect(result4.salt).toBe(result1.salt);
  });
});

describe("Direct Beam key agreement", () => {
  it("derives an identical shared key on both sides", async () => {
    const alice = await generateKeyAgreementPair();
    const bob = await generateKeyAgreementPair();

    const aliceKey = await deriveSharedKey(alice.keyPair.privateKey, bob.publicKeyHex);
    const bobKey = await deriveSharedKey(bob.keyPair.privateKey, alice.publicKeyHex);

    const aliceHex = await exportKeyToHex(aliceKey);
    const bobHex = await exportKeyToHex(bobKey);
    expect(aliceHex).toBe(bobHex);
    expect(aliceHex).toHaveLength(64);
  });

  it("produces an uncompressed P-256 public key", async () => {
    const pair = await generateKeyAgreementPair();
    expect(pair.publicKeyHex).toHaveLength(130);
    expect(pair.publicKeyHex.startsWith("04")).toBe(true);
  });

  it("rejects a malformed peer public key", async () => {
    const pair = await generateKeyAgreementPair();
    await expect(deriveSharedKey(pair.keyPair.privateKey, "deadbeef")).rejects.toThrow();
  });

  it("shows a matching 6-digit safety code to both peers, and a different one to a third party", async () => {
    const alice = await generateKeyAgreementPair();
    const bob = await generateKeyAgreementPair();
    const mallory = await generateKeyAgreementPair();

    const aliceKey = await deriveSharedKey(alice.keyPair.privateKey, bob.publicKeyHex);
    const bobKey = await deriveSharedKey(bob.keyPair.privateKey, alice.publicKeyHex);
    const malloryKey = await deriveSharedKey(mallory.keyPair.privateKey, alice.publicKeyHex);

    const aliceCode = await computeSafetyCode(aliceKey);
    const bobCode = await computeSafetyCode(bobKey);
    const malloryCode = await computeSafetyCode(malloryKey);

    expect(aliceCode).toMatch(/^[0-9]{6}$/);
    expect(aliceCode).toBe(bobCode);
    expect(malloryCode).not.toBe(aliceCode);
  });

  it("encrypts and decrypts a chunk under the agreed key", async () => {
    const alice = await generateKeyAgreementPair();
    const bob = await generateKeyAgreementPair();
    const aliceKey = await deriveSharedKey(alice.keyPair.privateKey, bob.publicKeyHex);
    const bobKey = await deriveSharedKey(bob.keyPair.privateKey, alice.publicKeyHex);

    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sealed = await encryptChunk(aliceKey, payload.buffer);
    const opened = await decryptChunk(bobKey, sealed);
    expect(new Uint8Array(opened)).toEqual(payload);
  });
});
