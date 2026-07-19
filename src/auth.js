/**
 * Access password protection for Check-in Hub.
 *
 * Env:
 *   ACCESS_PASSWORD - if empty/unset, auth is disabled (open access)
 *   SESSION_TTL_SECONDS - optional, default 7 days
 *
 * Session token: base64url(JSON({exp})).base64url(HMAC-SHA256)
 * Accepted via:
 *   - Cookie: checkin_hub_session=<token>
 *   - Header: Authorization: Bearer <token>
 *   - Header: X-Access-Password: <password>  (stateless, for scripts)
 */

const COOKIE_NAME = "checkin_hub_session";
const DEFAULT_TTL = 7 * 24 * 60 * 60; // 7 days

export function authRequired(env) {
  return Boolean(env.ACCESS_PASSWORD && String(env.ACCESS_PASSWORD).length > 0);
}

function b64urlEncode(buf) {
  let bin = "";
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecodeToString(str) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64);
}

function b64urlDecodeToBytes(str) {
  const s = b64urlDecodeToString(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = typeof a === "string" ? enc.encode(a) : a;
  const bb = typeof b === "string" ? enc.encode(b) : b;
  if (ba.length !== bb.length) {
    // still walk to reduce trivial timing leaks on length
    let diff = ba.length ^ bb.length;
    const n = Math.max(ba.length, bb.length);
    for (let i = 0; i < n; i++) {
      diff |= (ba[i] || 0) ^ (bb[i] || 0);
    }
    return false;
  }
  let out = 0;
  for (let i = 0; i < ba.length; i++) out |= ba[i] ^ bb[i];
  return out === 0;
}

async function hmacKey(env) {
  // Prefer dedicated session secret; fall back to access password
  const secret = env.SESSION_SECRET || env.ACCESS_PASSWORD || "checkin-hub-dev";
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(payloadB64, env) {
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return b64urlEncode(sig);
}

export async function createSessionToken(env) {
  const ttl = Number(env.SESSION_TTL_SECONDS) || DEFAULT_TTL;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify({ exp, v: 1 })));
  const sig = await sign(payloadB64, env);
  return `${payloadB64}.${sig}`;
}

export async function verifySessionToken(token, env) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;
  const expected = await sign(payloadB64, env);
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const json = b64urlDecodeToString(payloadB64);
    const payload = JSON.parse(json);
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getBearer(request) {
  const h = request.headers.get("Authorization") || request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

export async function isAuthenticated(request, env) {
  if (!authRequired(env)) return true;

  // One-shot password header for scripts / curl
  const direct = request.headers.get("X-Access-Password") || "";
  if (direct && timingSafeEqual(direct, String(env.ACCESS_PASSWORD))) return true;

  const token = getBearer(request) || parseCookies(request.headers.get("Cookie") || "")[COOKIE_NAME] || "";
  if (!token) return false;
  return verifySessionToken(token, env);
}

export function sessionCookieHeader(token, env, { clear = false, secure = true } = {}) {
  const ttl = Number(env.SESSION_TTL_SECONDS) || DEFAULT_TTL;
  const securePart = secure ? "; Secure" : "";
  if (clear) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly${securePart}; SameSite=Lax; Max-Age=0`;
  }
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly${securePart}; SameSite=Lax; Max-Age=${ttl}`;
}

export async function verifyPassword(password, env) {
  if (!authRequired(env)) return true;
  return timingSafeEqual(String(password || ""), String(env.ACCESS_PASSWORD));
}

export { COOKIE_NAME };
