/** Cloudflare KV helpers for channel persistence (CHECKIN_KV). */

export const CHANNELS_KEY = "channels";
export const LAST_RUN_KEY = "last_run";

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
