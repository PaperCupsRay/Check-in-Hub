import { listAdapters, runAction, getAdapter } from "./adapters/index.js";
import {
  authRequired,
  isAuthenticated,
  verifyPassword,
  createSessionToken,
  sessionCookieHeader,
  COOKIE_NAME,
} from "./auth.js";
import {
  kvBound,
  getChannels,
  putChannels,
  getLastRun,
  putLastRun,
} from "./kv.js";
import uiHtml from "./ui.html";
import { sendTelegram, formatCheckinReport } from "./tg.js";
import _nacl from "tweetnacl";
import _naclUtil from "tweetnacl-util";
const { box } = _nacl;
const util = _naclUtil;
import { blake2b } from "@noble/hashes/blake2.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Cron-Secret, X-Access-Password",
  "Access-Control-Allow-Credentials": "true",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function html(content, status = 200, extraHeaders = {}) {
  return new Response(content, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function unauthorized(message = "需要访问密码") {
  return json({ ok: false, error: message, authRequired: true }, 401);
}

function isChannelEnabled(input = {}) {
  // Missing field → enabled (backward compatible with old exports)
  return input.enabled !== false;
}

function normalizeChannel(input = {}) {
  const channel = {
    id: input.id || null,
    name: input.name || "channel",
    type: input.type || input.adapter || "",
    baseUrl: String(input.baseUrl || input.base_url || input.url || "").replace(/\/+$/, ""),
    enabled: isChannelEnabled(input),
    auth: { ...(input.auth || {}) },
    options: { ...(input.options || {}) },
  };

  const flat = [
    "email",
    "password",
    "username",
    "cookie",
    "token",
    "accessToken",
    "refreshToken",
    "userId",
    "newApiUser",
    "turnstileToken",
  ];
  for (const k of flat) {
    if (input[k] != null && input[k] !== "" && channel.auth[k] == null) {
      channel.auth[k] = input[k];
    }
  }
  if (input.timezone && !channel.options.timezone) {
    channel.options.timezone = input.timezone;
  }
  if (input.turnstileSiteKey && !channel.options.turnstileSiteKey) {
    channel.options.turnstileSiteKey = input.turnstileSiteKey;
  }
  if (input.lastResult != null) channel.lastResult = input.lastResult;
  return channel;
}

/** Keep fields the UI stores (lastResult etc.) while normalizing core fields. */
function storeChannel(input = {}) {
  const ch = normalizeChannel(input);
  if (input.lastResult != null) ch.lastResult = input.lastResult;
  if (input.quotaInfo != null) ch.quotaInfo = input.quotaInfo;
  if (!ch.id && input.id) ch.id = input.id;
  ch.enabled = isChannelEnabled(input);
  return ch;
}

function publicResult(action, result) {
  return {
    ok: !!result?.ok,
    action,
    message: result?.message || (result?.ok ? "ok" : "failed"),
    user: result?.user || null,
    status: result?.status || null,
    result: result?.result || null,
    tokens: result?.tokens || null,
    raw: result?.raw ?? null,
    httpStatus: result?.httpStatus ?? null,
  };
}

async function handleCheckin(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const action = body.action || "checkin";
  const channel = normalizeChannel(body.channel || body);
  if (!channel.type) return json({ ok: false, error: "channel.type is required" }, 400);
  if (!channel.baseUrl) return json({ ok: false, error: "channel.baseUrl is required" }, 400);
  if (!/^https?:\/\//i.test(channel.baseUrl)) {
    return json({ ok: false, error: "channel.baseUrl must start with http(s)://" }, 400);
  }

  const allowed = new Set(["login", "me", "status", "checkin", "refresh"]);
  if (!allowed.has(action)) {
    return json({ ok: false, error: `unsupported action: ${action}` }, 400);
  }

  try {
    getAdapter(channel.type);
    const result = await runAction(channel.type, action, channel);
    return json(publicResult(action, result), result?.ok ? 200 : 422);
  } catch (err) {
    const status = err.status || 500;
    return json(
      {
        ok: false,
        error: err.message || String(err),
        stack: err.stack,
      },
      status
    );
  }
}

async function handleBatch(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const action = body.action || "checkin";
  const list = Array.isArray(body.channels) ? body.channels : [];
  if (!list.length) return json({ ok: false, error: "channels[] is required" }, 400);

  const results = [];
  for (const item of list) {
    const channel = normalizeChannel(item);
    try {
      getAdapter(channel.type);
      const result = await runAction(channel.type, action, channel);
      results.push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        baseUrl: channel.baseUrl,
        ...publicResult(action, result),
      });
    } catch (err) {
      results.push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        baseUrl: channel.baseUrl,
        ok: false,
        action,
        message: err.message || String(err),
      });
    }
  }
  return json({
    ok: results.every((r) => r.ok),
    count: results.length,
    results,
  });
}

async function handleKvStatus(env) {
  const bound = kvBound(env);
  let count = null;
  let lastRun = null;
  if (bound) {
    try {
      const channels = await getChannels(env);
      count = channels.length;
      lastRun = await getLastRun(env);
    } catch {
      count = null;
    }
  }
  return json({
    ok: true,
    kvBound: bound,
    channelsKey: "channels",
    channelCount: count,
    lastRun,
  });
}

async function handleKvGetChannels(env) {
  try {
    const channels = await getChannels(env);
    const lastRun = await getLastRun(env);
    return json({
      ok: true,
      kvBound: true,
      count: channels.length,
      channels,
      lastRun,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err.message || String(err),
        code: err.code || null,
        kvBound: kvBound(env),
      },
      err.status || 500
    );
  }
}

async function handleKvPutChannels(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const list = Array.isArray(body.channels)
    ? body.channels
    : Array.isArray(body)
      ? body
      : null;
  if (!list) {
    return json({ ok: false, error: "channels[] is required" }, 400);
  }

  const channels = list.map((item) => storeChannel(item));

  try {
    await putChannels(env, channels);
    return json({
      ok: true,
      kvBound: true,
      count: channels.length,
      message: `已写入 ${channels.length} 个渠道到 KV`,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err.message || String(err),
        code: err.code || null,
        kvBound: kvBound(env),
      },
      err.status || 500
    );
  }
}

async function handleKvDeleteChannels(env) {
  try {
    await putChannels(env, []);
    return json({ ok: true, kvBound: true, count: 0, message: "已清空 KV 渠道列表" });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err.message || String(err),
        code: err.code || null,
        kvBound: kvBound(env),
      },
      err.status || 500
    );
  }
}

async function runScheduled(env) {
  if (!kvBound(env)) {
    return { ok: false, message: "CHECKIN_KV not bound" };
  }
  let channels;
  try {
    channels = await getChannels(env);
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
  if (!channels.length) return { ok: false, message: "KV key `channels` is empty" };

  const results = [];
  let skipped = 0;
  for (const item of channels) {
    if (!isChannelEnabled(item)) {
      skipped += 1;
      results.push({
        name: item.name || "channel",
        type: item.type || "",
        baseUrl: item.baseUrl || "",
        ok: true,
        skipped: true,
        message: "未启用，已跳过",
      });
      continue;
    }
    const channel = normalizeChannel(item);
    try {
      const result = await runAction(channel.type, "checkin", channel);
      if (result.tokens) {
        item.auth = { ...(item.auth || {}), ...result.tokens };
      }
      item.lastResult = {
        ok: !!result.ok,
        summary: `checkin: ${result.message || (result.ok ? "ok" : "failed")}`,
        at: Date.now(),
      };
      results.push({
        name: channel.name,
        type: channel.type,
        baseUrl: channel.baseUrl,
        ok: !!result.ok,
        message: result.message,
      });
    } catch (err) {
      item.lastResult = {
        ok: false,
        summary: `checkin: ${err.message || String(err)}`,
        at: Date.now(),
      };
      results.push({
        name: channel.name,
        type: channel.type,
        baseUrl: channel.baseUrl,
        ok: false,
        message: err.message || String(err),
      });
    }
  }
  await putChannels(env, channels);
  const ran = results.filter((r) => !r.skipped);
  if (!ran.length && skipped) {
    const lastRun = { at: new Date().toISOString(), results, skipped };
    await putLastRun(env, lastRun);
    return { ok: false, message: "全部渠道均未启用", results, skipped, lastRun };
  }
  const lastRun = { at: new Date().toISOString(), results, skipped };
  await putLastRun(env, lastRun);
  // TG 通知（未配置 secrets 时静默跳过）
  const tg = await sendTelegram(
    env,
    formatCheckinReport("📋 定时签到报告", results.map(({ name, ok, message }) => ({ name, ok, message })))
  );
  if (!tg.ok && !tg.skipped) console.log("TG 通知失败:", tg.error || tg.status);
  return { ok: true, results, skipped, lastRun, tg };
}

function cookieSecureFlag(request) {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true;
  }
}

async function handleAuthLogin(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const password = body.password || "";
  if (!authRequired(env)) {
    return json({ ok: true, authRequired: false, message: "未启用访问密码" });
  }
  const ok = await verifyPassword(password, env);
  if (!ok) {
    return json({ ok: false, error: "访问密码错误" }, 401);
  }
  const token = await createSessionToken(env);
  const secure = cookieSecureFlag(request);
  return json(
    {
      ok: true,
      authRequired: true,
      token,
      message: "登录成功",
      cookieName: COOKIE_NAME,
    },
    200,
    { "Set-Cookie": sessionCookieHeader(token, env, { secure }) }
  );
}

function handleAuthLogout(request, env) {
  return json(
    { ok: true, message: "已退出" },
    200,
    { "Set-Cookie": sessionCookieHeader("", env, { clear: true, secure: cookieSecureFlag(request) }) }
  );
}

async function handleAuthStatus(request, env) {
  const required = authRequired(env);
  const authenticated = await isAuthenticated(request, env);
  return json({
    ok: true,
    authRequired: required,
    authenticated: required ? authenticated : true,
  });
}

/** Paths that stay reachable without access password */
function isPublicPath(pathname, method) {
  if (pathname === "/api/auth/status" && method === "GET") return true;
  if (pathname === "/api/auth/login" && method === "POST") return true;
  if (pathname === "/api/auth/logout" && method === "POST") return true;
  if (pathname === "/api/health" && method === "GET") return true;
  if (pathname === "/api/cron/run" && method === "POST") return true;
  if (pathname === "/api/gh/result" && method === "POST") return true;
  return false;
}

/**
 * 签到通道：每渠道可独立选择
 *   worker      — Worker 出口直连（默认，多数站可用）
 *   gha_api     — GitHub Actions 纯 HTTP（Azure 出口，过「封 CDN IP」站）
 *   gha_browser — GitHub Actions + CloakBrowser 反检测浏览器（过 WAF/CF 挑战站）
 */
const RUNNERS = new Set(["worker", "gha_api", "gha_browser"]);

function runnerOf(channel) {
  return RUNNERS.has(channel?.options?.runner) ? channel.options.runner : "worker";
}

/**
 * GitHub Actions 执行端：签到不再从 Worker 出口直连目标站（部分站点封禁
 * Cloudflare CDN IP），改为 Worker 通过 repository_dispatch 触发 GitHub
 * Actions（Azure 出口 IP），Actions 执行完成后把结果回传到 /api/gh/result。
 * payload.runners 指定本次要跑的通道（如 ["gha_api"] 或 ["gha_api","gha_browser"]），
 * 下发渠道名单，Actions 端据此过滤执行。
 */
async function handleGhDispatch(request, env) {
  if (!env.GH_TOKEN || !env.GH_REPO) {
    return json(
      {
        ok: false,
        error:
          "未配置 GitHub 集成。请设置 secrets: GH_TOKEN（需 repo scope 的 PAT）、GH_REPO（owner/repo 格式）",
      },
      400
    );
  }
  // 允许 body 指定本次通道；缺省 = 所有非 worker 通道的启用渠道
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const requested = Array.isArray(body.runners) ? body.runners.filter((r) => RUNNERS.has(r)) : null;

  let channels = [];
  try {
    channels = await getChannels(env);
  } catch (err) {
    return json({ ok: false, error: `读取 KV 失败: ${err.message}` }, 500);
  }
  const names = channels
    .filter((c) => c.enabled !== false)
    .filter((c) => (requested ? requested.includes(runnerOf(c)) : runnerOf(c) !== "worker"))
    .map((c) => c.name);
  if (!names.length) {
    return json({ ok: false, error: "没有属于所选通道的启用渠道" }, 422);
  }

  const resp = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GH_TOKEN}`,
      "User-Agent": "checkin-hub",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "checkin-run",
      client_payload: {
        runners: requested || ["gha_api", "gha_browser"],
        names,
        callbackSecret: crypto.randomUUID(),
        requestedAt: new Date().toISOString(),
      },
    }),
  });
  if (resp.status === 204) {
    return json({
      ok: true,
      message: `已触发 GitHub Actions（${(requested || ["gha_api", "gha_browser"]).join(" + ")}），渠道 ${names.length} 个：${names.join("、")}`,
    });
  }
  const gBody = await resp.text().catch(() => "");
  return json(
    { ok: false, error: `GitHub API 返回 ${resp.status}`, body: gBody.slice(0, 400) },
    resp.status
  );
}

async function handleGhResult(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!env.CRON_SECRET || body.secret !== env.CRON_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const results = Array.isArray(body.results) ? body.results : [];
  if (!results.length) {
    return json({ ok: false, error: "results[] is required" }, 400);
  }
  // 将 Actions 回传的结果合并进 KV 渠道的 lastResult
  let channels = [];
  try {
    channels = await getChannels(env);
  } catch (err) {
    return json({ ok: false, error: `读取 KV 失败: ${err.message}` }, 500);
  }
  const byName = new Map(channels.map((c) => [c.name, c]));
  let merged = 0;
  for (const r of results) {
    const ch = byName.get(r.name);
    if (!ch) continue;
    ch.lastResult = {
      ok: !!r.ok,
      action: "checkin",
      summary: `gha: ${r.message || (r.ok ? "ok" : "failed")}`,
      at: Date.now(),
    };
    if (r.quotaInfo) ch.quotaInfo = { ...(ch.quotaInfo || {}), ...r.quotaInfo };
    merged++;
  }
  if (merged) await putChannels(env, channels);
  const flat = results.map((r) => ({ name: r.name, ok: !!r.ok, message: r.message }));
  await putLastRun(env, {
    at: new Date().toISOString(),
    runner: "github-actions",
    results: flat,
  });
  // TG 通知 GitHub Actions 回传的签到结果
  await sendTelegram(env, formatCheckinReport("🤖 GitHub Actions 签到报告", flat));
  return json({ ok: true, merged, count: results.length });
}

/**
 * 仓库 Secrets 管理：通过 GitHub API 写入 Actions Secrets。
 * GitHub 要求 secret 值用仓库公钥加密（libsodium sealed box）。
 * 需要面板登录；GH_TOKEN 需 repo 权限。GET 读取现有名称，PUT 写入。
 */
async function ghRepoPublicKey(env) {
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/secrets/public-key`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GH_TOKEN}`,
      "User-Agent": "checkin-hub",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`获取仓库公钥失败: ${res.status} ${data.message || ""}`);
  return { key: data.key, keyId: data.key_id };
}

async function handleGhSecrets(request, env) {
  if (!env.GH_TOKEN || !env.GH_REPO) {
    return json({ ok: false, error: "未配置 GH_TOKEN / GH_REPO" }, 400);
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GH_TOKEN}`,
    "User-Agent": "checkin-hub",
    "Content-Type": "application/json",
  };

  if (request.method === "GET") {
    const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/secrets`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ ok: false, error: `GitHub API ${res.status}`, body: data }, res.status);
    return json({ ok: true, secrets: (data.secrets || []).map((s) => s.name) });
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }
    const { name, value } = body || {};
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(String(name || "")) || !String(value || "")) {
      return json({ ok: false, error: "需要 name（字母数字下划线）和 value" }, 400);
    }
    let pk;
    try {
      pk = await ghRepoPublicKey(env);
    } catch (e) {
      return json({ ok: false, error: e.message }, 502);
    }
    // libsodium sealed box：Worker 无 sodium 依赖，用纯 JS 实现（tweetnacl 方式）
    // 这里选择交给 GitHub 的 secret 加密需要 sodium；为避免引依赖，改用
    // @noble/secrets 不行——GitHub 只接受 sealed box。因此内置一个最小 sealed box。
    let sealed;
    try {
      sealed = sealBox(pk.key, String(value));
    } catch (e) {
      return json({ ok: false, error: `sealBox 加密失败: ${e.message || e}` }, 500);
    }
    const res = await fetch(
      `https://api.github.com/repos/${env.GH_REPO}/actions/secrets/${encodeURIComponent(name)}`,
      { method: "PUT", headers, body: JSON.stringify({ encrypted_value: sealed, key_id: pk.keyId }) }
    );
    if (res.status === 201 || res.status === 204) {
      return json({ ok: true, message: `已写入仓库 Secret ${name}` });
    }
    const t = await res.text().catch(() => "");
    return json({ ok: false, error: `GitHub API ${res.status}`, body: t.slice(0, 300) }, res.status);
  }

  return json({ ok: false, error: "method not allowed" }, 405);
}

/**
 * libsodium crypto_box_seal（GitHub Actions Secrets 要求的加密格式）。
 * sealed = epk(32B) || crypto_box(m, nonce, rpk, esk)；
 * nonce = crypto_generichash_blake2b(epk||rpk, 24)，与 libsodium 一致。
 * 依赖（esm.sh，纯 JS）：tweetnacl + @noble/hashes 的 blake2b。
 */

function sealBox(publicKeyB64, message) {
  const rpk = util.decodeBase64(publicKeyB64);
  const eph = box.keyPair();
  const nonceIn = new Uint8Array(eph.publicKey.length + rpk.length);
  nonceIn.set(eph.publicKey, 0);
  nonceIn.set(rpk, eph.publicKey.length);
  const nonce = blake2b(nonceIn, { dkLen: 24 });
  const sealed = box(util.decodeUTF8(message), nonce, rpk, eph.secretKey);
  const out = new Uint8Array(32 + sealed.length);
  out.set(eph.publicKey, 0);
  out.set(sealed, 32);
  return util.encodeBase64(out);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (pathname === "/api/auth/status" && request.method === "GET") {
      return handleAuthStatus(request, env);
    }
    if (pathname === "/api/auth/login" && request.method === "POST") {
      return handleAuthLogin(request, env);
    }
    if (pathname === "/api/auth/logout" && request.method === "POST") {
      return handleAuthLogout(request, env);
    }

    if (request.method === "GET" && pathname === "/api/health") {
      return json({
        ok: true,
        service: "checkin-hub",
        authRequired: authRequired(env),
        kvBound: kvBound(env),
        adapters: listAdapters().map((a) => a.id),
        time: new Date().toISOString(),
      });
    }

    if (request.method === "POST" && pathname === "/api/cron/run") {
      const secret = request.headers.get("X-Cron-Secret") || url.searchParams.get("secret") || "";
      if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const result = await runScheduled(env);
      return json(result, result.ok ? 200 : 500);
    }

    // 出站探测（诊断用，需登录）：POST /api/probe {url, headers} -> 状态/类型
    if (request.method === "POST" && pathname === "/api/probe") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400);
      }
      const target = String(body.url || "");
      if (!/^https:\/\//.test(target)) return json({ ok: false, error: "url required" }, 400);
      try {
        const r = await fetch(target, {
          method: body.method || "GET",
          headers: body.headers || { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36" },
          body: body.body || undefined,
          redirect: "manual",
        });
        const text = await r.text();
        return json({
          ok: true,
          status: r.status,
          cfMitigated: r.headers.get("cf-mitigated"),
          server: r.headers.get("server"),
          isBlockPage: /sorry, you have been blocked|attention required/i.test(text),
          isChallenge: /just a moment|cf-browser-verification|cdn-cgi\//i.test(text),
          bodyHead: text.slice(0, 300),
        });
      } catch (e) {
        return json({ ok: false, error: e.message }, 502);
      }
    }

    // GHA 运行日志（诊断用，需登录）：GET /api/gh/runs -> 最近 runs；GET /api/gh/jobs/:id -> jobs 与结论
    if (pathname === "/api/gh/runs" && request.method === "GET") {
      const r = await fetch(
        `https://api.github.com/repos/${env.GH_REPO}/actions/runs?per_page=3`,
        { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "checkin-hub" } }
      );
      const d = await r.json().catch(() => ({}));
      return json({ ok: r.ok, runs: (d.workflow_runs || []).map((w) => ({ id: w.id, status: w.status, conclusion: w.conclusion, at: w.created_at })), status: r.status });
    }
    if (pathname.startsWith("/api/gh/jobs/") && request.method === "GET") {
      const runId = pathname.split("/").pop();
      const r = await fetch(
        `https://api.github.com/repos/${env.GH_REPO}/actions/runs/${runId}/jobs?per_page=5`,
        { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "checkin-hub" } }
      );
      const d = await r.json().catch(() => ({}));
      return json({ ok: r.ok, jobs: (d.jobs || []).map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, steps: (j.steps || []).map((st) => ({ name: st.name, conclusion: st.conclusion })) })), status: r.status });
    }

    // GHA job 日志内容（诊断用，需登录）：/api/gh/joblog/:jobId
    if (pathname.startsWith("/api/gh/joblog/") && request.method === "GET") {
      const jobId = pathname.split("/").pop();
      const r = await fetch(
        `https://api.github.com/repos/${env.GH_REPO}/actions/jobs/${jobId}/logs`,
        { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "checkin-hub" }, redirect: "follow" }
      );
      const text = r.text().catch(() => "");
      return new Response(await text, { status: r.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // 仓库 Secrets 管理：GET 列名称 / PUT 写入（需登录）
    if (pathname === "/api/gh/repo-secrets") {
      return handleGhSecrets(request, env);
    }

    // 触发 GitHub Actions 执行签到（需登录）
    if (request.method === "POST" && pathname === "/api/gh/dispatch") {
      return handleGhDispatch(request, env);
    }

    // GitHub Actions 回传签到结果（用 CRON_SECRET 鉴权，公开路径但需口令）
    if (request.method === "POST" && pathname === "/api/gh/result") {
      return handleGhResult(request, env);
    }

    if (authRequired(env) && !isPublicPath(pathname, request.method)) {
      const ok = await isAuthenticated(request, env);
      if (!ok) {
        if (pathname === "/" || pathname === "/index.html") {
          return html(uiHtml);
        }
        return unauthorized();
      }
    }

    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return html(uiHtml);
    }


    if (request.method === "GET" && pathname === "/api/adapters") {
      return json({ ok: true, adapters: listAdapters() });
    }

    // TG 通知连通性测试（需登录；发送一条测试消息）
    if (request.method === "POST" && pathname === "/api/tg/test") {
      const r = await sendTelegram(env, "✅ <b>Check-in Hub</b> TG 通知配置成功");
      return json(
        { ok: r.ok, skipped: !!r.skipped, detail: r.reason || r.error || r.status || null },
        r.ok ? 200 : 400
      );
    }

    if (request.method === "POST" && pathname === "/api/checkin") {
      return handleCheckin(request);
    }

    if (request.method === "POST" && pathname === "/api/batch") {
      return handleBatch(request);
    }

    if (pathname === "/api/kv/status" && request.method === "GET") {
      return handleKvStatus(env);
    }
    if (pathname === "/api/kv/channels" && request.method === "GET") {
      return handleKvGetChannels(env);
    }
    if (pathname === "/api/kv/channels" && (request.method === "PUT" || request.method === "POST")) {
      return handleKvPutChannels(request, env);
    }
    if (pathname === "/api/kv/channels" && request.method === "DELETE") {
      return handleKvDeleteChannels(env);
    }

    return json({ ok: false, error: "Not Found", path: pathname }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};
