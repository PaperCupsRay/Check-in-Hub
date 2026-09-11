/** Cloudflare KV helpers for channel persistence (CHECKIN_KV). */

export const CHANNELS_KEY = "channels";
export const LAST_RUN_KEY = "last_run";
export const PROXIES_KEY = "proxies";

export function kvBound(env) {
  return !!(env && env.CHECKIN_KV);
}

export async function getChannels(env) {
  if (!kvBound(env)) {
    const err = new Error("CHECKIN_KV not bound");
    err.status = 503;
    err.code = "KV_NOT_BOUND";
    throw err;
  }
  const raw = await env.CHECKIN_KV.get(CHANNELS_KEY);
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const err = new Error("KV channels is not valid JSON");
    err.status = 500;
    err.code = "KV_INVALID_JSON";
    throw err;
  }
  if (!Array.isArray(data)) {
    const err = new Error("KV channels must be an array");
    err.status = 500;
    err.code = "KV_INVALID_SHAPE";
    throw err;
  }
  return data;
}

export async function putChannels(env, channels) {
  if (!kvBound(env)) {
    const err = new Error("CHECKIN_KV not bound");
    err.status = 503;
    err.code = "KV_NOT_BOUND";
    throw err;
  }
  if (!Array.isArray(channels)) {
    const err = new Error("channels must be an array");
    err.status = 400;
    throw err;
  }
  const payload = JSON.stringify(channels);
  await env.CHECKIN_KV.put(CHANNELS_KEY, payload);
  return channels;
}

/**
 * 代理池（住宅 SOCKS5 出口，供 GHA 浏览器通道使用）。
 *
 * 存在 KV 而不是 GitHub Secrets：代理会频繁失效、需要随时增删和测连通性，
 * 走面板改比改 Secrets 方便；且与渠道凭证同处一地，权限模型一致。
 * 形状：[{ url, note, enabled, lastCheck: { ok, ms, ip, at, error } }]
 */
export async function getProxies(env) {
  if (!kvBound(env)) return [];
  const raw = await env.CHECKIN_KV.get(PROXIES_KEY);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function putProxies(env, proxies) {
  if (!kvBound(env)) {
    const err = new Error("CHECKIN_KV not bound");
    err.status = 503;
    err.code = "KV_NOT_BOUND";
    throw err;
  }
  if (!Array.isArray(proxies)) {
    const err = new Error("proxies must be an array");
    err.status = 400;
    throw err;
  }
  await env.CHECKIN_KV.put(PROXIES_KEY, JSON.stringify(proxies));
  return proxies;
}

export async function getLastRun(env) {
  if (!kvBound(env)) return null;
  const raw = await env.CHECKIN_KV.get(LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export async function putLastRun(env, data) {
  if (!kvBound(env)) return;
  await env.CHECKIN_KV.put(LAST_RUN_KEY, JSON.stringify(data));
}
