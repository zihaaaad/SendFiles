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
