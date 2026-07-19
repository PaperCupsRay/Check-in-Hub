import { listAdapters, runAction, getAdapter } from "./adapters/index.js";
import {
  authRequired,
  isAuthenticated,
  verifyPassword,
  createSessionToken,
  sessionCookieHeader,
  COOKIE_NAME,
} from "./auth.js";
import uiHtml from "./ui.html";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

function normalizeChannel(input = {}) {
  const channel = {
    id: input.id || null,
    name: input.name || "channel",
    type: input.type || input.adapter || "",
    baseUrl: String(input.baseUrl || input.base_url || input.url || "").replace(/\/+$/, ""),
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
  return channel;
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

async function runScheduled(env) {
  if (!env.CHECKIN_KV) {
    return { ok: false, message: "CHECKIN_KV not bound" };
  }
  const raw = await env.CHECKIN_KV.get("channels");
  if (!raw) return { ok: false, message: "KV key `channels` is empty" };
  let channels;
  try {
    channels = JSON.parse(raw);
  } catch {
    return { ok: false, message: "KV channels is not valid JSON" };
  }
  if (!Array.isArray(channels)) return { ok: false, message: "KV channels must be an array" };

  const results = [];
  for (const item of channels) {
    const channel = normalizeChannel(item);
    try {
      const result = await runAction(channel.type, "checkin", channel);
      if (result.tokens) {
        item.auth = { ...(item.auth || {}), ...result.tokens };
      }
      results.push({
        name: channel.name,
        type: channel.type,
        baseUrl: channel.baseUrl,
        ok: !!result.ok,
        message: result.message,
      });
    } catch (err) {
      results.push({
        name: channel.name,
        type: channel.type,
        baseUrl: channel.baseUrl,
        ok: false,
        message: err.message || String(err),
      });
    }
  }
  await env.CHECKIN_KV.put("channels", JSON.stringify(channels));
  await env.CHECKIN_KV.put(
    "last_run",
    JSON.stringify({ at: new Date().toISOString(), results })
  );
  return { ok: true, results };
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
  // Cron uses its own CRON_SECRET
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

    // Auth endpoints (public)
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

    // Gate everything else when ACCESS_PASSWORD is set
    if (authRequired(env) && !isPublicPath(pathname, request.method)) {
      const ok = await isAuthenticated(request, env);
      if (!ok) {
        // HTML pages get a soft 401 page body still? Prefer 401 JSON for API, login shell for UI
        if (pathname === "/" || pathname === "/index.html") {
          // Still serve UI — front-end shows lock screen. But APIs remain protected.
          // To avoid leaking adapter list via HTML only is fine; real secrets are API.
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

    return json({ ok: false, error: "Not Found", path: pathname }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};
