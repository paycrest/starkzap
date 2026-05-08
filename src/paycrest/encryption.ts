/**
 * RSA-OAEP-SHA256 encryption for Paycrest recipient details (gateway path).
 *
 * Auto-detects the runtime: prefers `globalThis.crypto.subtle` (browsers,
 * React Native via polyfills, modern workers) and falls back to Node's
 * `node:crypto.publicEncrypt` when SubtleCrypto isn't available.
 *
 * The Cairo Gateway expects the encrypted blob as a UTF-8 ByteArray on
 * `create_order`. Both code paths return a base64-encoded string; pass it
 * straight to `populateCreateOrder({ messageHash })`.
 */

const PEM_BEGIN = "-----BEGIN PUBLIC KEY-----";
const PEM_END = "-----END PUBLIC KEY-----";

/**
 * Strip PEM armor and base64-decode the SPKI body to a Uint8Array
 * suitable for `crypto.subtle.importKey("spki", ...)`.
 */
function pemToSpki(pem: string): Uint8Array {
  const trimmed = pem.trim();
  const start = trimmed.indexOf(PEM_BEGIN);
  const end = trimmed.indexOf(PEM_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Paycrest public key is not a valid PEM (missing BEGIN/END PUBLIC KEY markers)"
    );
  }
  const body = trimmed
    .slice(start + PEM_BEGIN.length, end)
    .replace(/[\r\n\s]+/g, "");
  return base64Decode(body);
}

function base64Decode(value: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node fallback (atob is global on Node 18+, but be defensive).
  const buf = (
    globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }
  ).Buffer?.from(value, "base64");
  if (buf) return new Uint8Array(buf);
  throw new Error("No base64 decoder available in this environment");
}

function base64Encode(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return globalThis.btoa(binary);
  }
  const Buf = (
    globalThis as {
      Buffer?: { from(b: Uint8Array): { toString(e: string): string } };
    }
  ).Buffer;
  if (Buf) return Buf.from(bytes).toString("base64");
  throw new Error("No base64 encoder available in this environment");
}

interface SubtleCryptoLike {
  importKey(
    format: "spki",
    keyData: BufferSource,
    algorithm: { name: "RSA-OAEP"; hash: "SHA-256" },
    extractable: boolean,
    keyUsages: ["encrypt"]
  ): Promise<CryptoKey>;
  encrypt(
    algorithm: { name: "RSA-OAEP" },
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer>;
}

function getSubtle(): SubtleCryptoLike | null {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } })
    .crypto?.subtle;
  return subtle ?? null;
}

async function encryptViaSubtle(
  subtle: SubtleCryptoLike,
  pem: string,
  plaintext: string
): Promise<string> {
  const spki = pemToSpki(pem);
  const key = await subtle.importKey(
    "spki",
    toArrayBuffer(spki),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    toArrayBuffer(encoded)
  );
  return base64Encode(new Uint8Array(ciphertext));
}

/**
 * Copy a `Uint8Array` into a fresh `ArrayBuffer` so it satisfies the
 * `BufferSource` constraint on SubtleCrypto methods (TS now requires
 * `ArrayBufferView<ArrayBuffer>`, not `ArrayBufferLike`).
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}

async function encryptViaNode(pem: string, plaintext: string): Promise<string> {
  // Lazy-load `node:crypto` so bundlers don't pull it into browser builds.
  const nodeCrypto =
    (await import("node:crypto")) as typeof import("node:crypto");
  const ciphertext = nodeCrypto.publicEncrypt(
    {
      key: pem,
      padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(plaintext, "utf8")
  );
  return ciphertext.toString("base64");
}

/**
 * Encrypts `plaintext` with the aggregator's RSA public key (PEM, SPKI).
 *
 * - Uses `crypto.subtle.encrypt({name: "RSA-OAEP"}, ...)` when SubtleCrypto
 *   is available (browsers, React Native, modern workers).
 * - Falls back to `node:crypto.publicEncrypt(..., RSA_PKCS1_OAEP_PADDING,
 *   oaepHash: "sha256")` in Node.
 *
 * Returns base64-encoded ciphertext. Output of both paths decrypts to the
 * same plaintext via the corresponding private key.
 */
export async function encryptRecipient(
  publicKeyPem: string,
  plaintext: string
): Promise<string> {
  const subtle = getSubtle();
  if (subtle) return encryptViaSubtle(subtle, publicKeyPem, plaintext);
  return encryptViaNode(publicKeyPem, plaintext);
}
