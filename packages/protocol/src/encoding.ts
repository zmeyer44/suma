/**
 * Portable byte/string encoding helpers. WebCrypto-adjacent code in this
 * package must run unchanged in Node, Cloudflare Workers, and Electron
 * (main + renderer), so only Web-platform APIs are used here.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return textDecoder.decode(b);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Canonical, unambiguous concatenation: each part is prefixed with its byte
 * length as a 4-byte big-endian integer. Used everywhere a deterministic
 * byte encoding feeds an HMAC or signature — plain string joins are
 * ambiguous ("a"+"bc" vs "ab"+"c") and must never be signed.
 */
export function lengthPrefixed(parts: ReadonlyArray<string | Uint8Array>): Uint8Array {
  const encoded = parts.map((p) => (typeof p === "string" ? utf8(p) : p));
  const total = encoded.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of encoded) {
    view.setUint32(offset, p.length, false);
    out.set(p, offset + 4);
    offset += 4 + p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
