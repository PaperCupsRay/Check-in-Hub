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
  return { ok: true, results, skipped, lastRun };
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
  return false;
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
