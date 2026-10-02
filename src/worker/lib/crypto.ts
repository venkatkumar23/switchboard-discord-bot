// WebCrypto helpers. Portable between workerd and Node 22 (used by scripts/ too),
// so only standard `crypto.subtle` APIs are allowed in here.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input))));
}

/** Constant-time comparison (length is not secret here). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ── Passwords: PBKDF2-SHA256 ─────────────────────────────────────────
// workerd caps PBKDF2 at 100k iterations; it runs natively so it fits the CPU budget.
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltB64, hashB64] = stored.split("$");
  const iterations = Number(iter);
  if (scheme !== "pbkdf2_sha256" || !saltB64 || !hashB64 || !Number.isInteger(iterations)) return false;
  if (iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const actual = await pbkdf2(password, base64ToBytes(saltB64), iterations);
  return timingSafeEqual(actual, base64ToBytes(hashB64));
}

// ── Secrets at rest: AES-256-GCM ─────────────────────────────────────
// Format: v1.<iv base64>.<ciphertext+tag base64>. The key comes from the ENCRYPTION_KEY secret.
const aesKeys = new Map<string, Promise<CryptoKey>>();

function aesKey(keyB64: string): Promise<CryptoKey> {
  let key = aesKeys.get(keyB64);
  if (!key) {
    const raw = base64ToBytes(keyB64);
    if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes of base64");
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    aesKeys.set(keyB64, key);
  }
  return key;
}

export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), encoder.encode(plaintext));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decryptSecret(sealed: string, keyB64: string): Promise<string> {
  const [version, ivB64, ctB64] = sealed.split(".");
  if (version !== "v1" || !ivB64 || !ctB64) throw new Error("unrecognised ciphertext format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    await aesKey(keyB64),
    base64ToBytes(ctB64),
  );
  return decoder.decode(pt);
}
