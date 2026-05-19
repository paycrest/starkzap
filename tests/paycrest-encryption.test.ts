import { describe, expect, it } from "vitest";
import nodeCrypto from "node:crypto";
import { encryptRecipient } from "@/paycrest";

describe("paycrest encryption (RSA PKCS1 v1.5)", () => {
  it("encrypts a plaintext that decrypts via the matching private key", async () => {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const plaintext = JSON.stringify({
      institution: "GTBINGLA",
      accountIdentifier: "1234567890",
      accountName: "Test User",
      metadata: { apiKey: "test-key" },
    });

    const base64Ciphertext = await encryptRecipient(publicKey, plaintext);
    expect(typeof base64Ciphertext).toBe("string");
    expect(base64Ciphertext.length).toBeGreaterThan(0);
    expect(base64Ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);

    const decrypted = nodeCrypto.privateDecrypt(
      {
        key: privateKey,
        padding: nodeCrypto.constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(base64Ciphertext, "base64")
    );
    expect(decrypted.toString("utf8")).toBe(plaintext);
  });

  it("throws on a malformed PEM (no BEGIN PUBLIC KEY armor)", async () => {
    await expect(encryptRecipient("not-a-pem", "hello")).rejects.toThrow(
      /PEM/i
    );
  });

  it("uses the browser BigInt fallback when process.versions.node is absent", async () => {
    // Simulate a true browser/RN/Workers environment by hiding
    // process.versions.node. The encryptor should switch to the
    // BigInt-based PKCS1 v1.5 path and still produce ciphertext
    // the matching private key can decrypt. Guards against the
    // bundler-specific error-message-matching the old fallback
    // depended on (Webpack, Vite, Rollup each emit different strings).
    const g = globalThis as { process?: unknown };
    const original = g.process;
    g.process = undefined;
    try {
      const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const plaintext = "browser-path roundtrip";
      const base64Ciphertext = await encryptRecipient(publicKey, plaintext);
      const decrypted = nodeCrypto.privateDecrypt(
        {
          key: privateKey,
          padding: nodeCrypto.constants.RSA_PKCS1_PADDING,
        },
        Buffer.from(base64Ciphertext, "base64")
      );
      expect(decrypted.toString("utf8")).toBe(plaintext);
    } finally {
      g.process = original;
    }
  });
});
