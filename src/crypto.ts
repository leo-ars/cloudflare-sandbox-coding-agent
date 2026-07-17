// WebCrypto helpers: constant-time HMAC verification for webhook authenticity,
// and AES-GCM envelope encryption for GitHub tokens stored at rest in KV.

const enc = new TextEncoder();
const dec = new TextDecoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hexStr: string): Uint8Array {
  const clean = hexStr.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** HMAC-SHA256 of `body`, returned as lowercase hex. */
export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return hex(sig);
}

/** Constant-time comparison of two equal-length strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a GitHub-style signature header `sha256=<hex>` against the raw body.
 * Returns true only if the HMAC matches.
 */
export async function verifyHmac(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(expected.toLowerCase(), provided.toLowerCase());
}

async function importAesKey(keyHex: string): Promise<CryptoKey> {
  const raw = hexToBytes(keyHex);
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENC_KEY must be 32 bytes (64 hex chars).");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt plaintext with AES-256-GCM. Output: `<iv_hex>.<ciphertext_hex>`. */
export async function encrypt(keyHex: string, plaintext: string): Promise<string> {
  const key = await importAesKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext),
  );
  return `${hex(iv.buffer)}.${hex(ct)}`;
}

/** Decrypt a value produced by `encrypt`. */
export async function decrypt(keyHex: string, payload: string): Promise<string> {
  const [ivHex, ctHex] = payload.split(".");
  if (!ivHex || !ctHex) throw new Error("Malformed ciphertext.");
  const key = await importAesKey(keyHex);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(ivHex) },
    key,
    hexToBytes(ctHex),
  );
  return dec.decode(pt);
}
