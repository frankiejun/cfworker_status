/**
 * Password hashing and session cookies.
 *
 * - Passwords are stored as PBKDF2-SHA256 with a random salt, so the KV config
 *   never holds anything that can be replayed.
 * - Sessions are HMAC-signed payloads. The signing key is derived from the
 *   stored password hash, which means changing the password invalidates every
 *   existing session for free.
 */

const PBKDF2_ITERATIONS = 100_000;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_COOKIE = "cfstatus_session";

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Returns a string of the form `pbkdf2$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  try {
    const salt = b64urlDecode(parts[2]!);
    const expected = b64urlDecode(parts[3]!);
    const actual = await pbkdf2(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Constant-time string comparison, for bootstrap tokens. */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

async function sessionKey(passwordHash: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`cfworker-status:session:${passwordHash}`),
  );
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Session token: `<base64url payload>.<base64url signature>`. */
export async function createSession(passwordHash: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ exp: expiresAt })));
  const key = await sessionKey(passwordHash);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return `${payload}.${b64urlEncode(signature)}`;
}

export async function verifySession(token: string, passwordHash: string): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  try {
    const key = await sessionKey(passwordHash);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(signature),
      new TextEncoder().encode(payload),
    );
    if (!valid) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as { exp?: number };
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** `secure: false` is only for local `wrangler dev` over plain http. */
export function sessionCookie(token: string, secure: boolean): string {
  const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
  return `${SESSION_COOKIE}=${token}; ${flags}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  const flags = "HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
  return `${SESSION_COOKIE}=; ${flags}${secure ? "; Secure" : ""}`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}
