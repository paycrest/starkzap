import { describe, expect, it } from "vitest";
import nodeCrypto from "node:crypto";
import { encryptRecipient } from "@/paycrest";

/**
 * Generate an in-memory RSA key pair to encrypt against, then verify the
 * SDK's encryptor (`crypto.subtle` in modern Node) produces ciphertext
 * the matching private key can decrypt back to the original plaintext.
 *
 * This validates both:
 *   - PEM (SPKI) → SubtleCrypto importKey path
 *   - RSA-OAEP-SHA256 round-trip end to end
 */
describe("paycrest encryption (RSA-OAEP-SHA256)", () => {
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
        padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
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
});
