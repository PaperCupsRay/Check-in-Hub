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
  getProxies,
  putProxies,
} from "./kv.js";
import { normalizeProxy, maskProxyUrl, testSocks5 } from "./proxy.js";
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

/**
 * 签到降级链：worker 直连（同时验证 token/凭证可用性）→ GitHub Actions API 出口
 * → GitHub Actions CloakBrowser 模拟登录。每一级失败（IP 被封 / CF 挑战 / 凭证
 * 失效）才降到下一级；降级是异步 fire-and-forget：dispatch 返回后 GHA 结果经
 * /api/gh/result 回传写 KV + TG 通知，本次调用先返回「已降级分发」状态。
 */
async function ghDispatchChannels(env, runners, names) {
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
        runners,
        names,
        callbackSecret: crypto.randomUUID(),
        requestedAt: new Date().toISOString(),
      },
    }),
  });
  if (resp.status !== 204) {
    const gBody = await resp.text().catch(() => "");
    throw new Error(`GitHub API 返回 ${resp.status}: ${gBody.slice(0, 200)}`);
  }
}

/** 降级分发是否可用（未配 GitHub 集成时只能停在 worker 级） */
function ghFallbackAvailable(env) {
  return !!(env.GH_TOKEN && env.GH_REPO);
}

// 换出口也不会成功的失败（凭证缺失/接口不存在/类型配错）不降级，避免浪费 Actions 运行
const PERMANENT_FAIL_RE = /缺少|需要|未配置|不存在|404|无可用|未知渠道|不支持/;

async function tryWorkerCheckin(channel) {
  try {
    return await runAction(channel.type, "checkin", channel);
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

/**
 * 批量签到降级核心（runScheduled / handleBatch / 单渠道共用）。
 *
 * 每个渠道按 worker → gha_api → gha_browser 降级：
 * - options.runner = gha_api / gha_browser 的渠道：站点已知封 CF IP 或需浏览器，
 *   跳过注定失败的 worker 直连，直接按配置通道分发；
 * - worker 渠道：Worker 出口真实请求一次（这本身就是 token 有效性验证），
 *   失败且非永久性错误 → 降级 gha_api；
 * - 全部收集完再按通道各发一次 dispatch（一次 workflow run 承载整组渠道，
 *   避免逐渠道分发造成 N 次运行 N 份报告）；gha_api 内失败的渠道由
 *   gha-checkin.mjs 写 fallback 清单转交同次运行的 browser job。
 *
 * 返回 [{ item, result, via }]：via = "worker" 为真实结果；via = "gha_api" /
 * "gha_browser" 是占位（ok=true），真实结果由 GHA 经 /api/gh/result 回传覆盖
 * KV lastResult + TG 通知。占位保留 worker 尝试刷新出的 tokens 供持久化。
 */
async function batchCheckinCore(items, env) {
  const out = [];
  const canFallback = !!(env && ghFallbackAvailable(env));
  const groups = new Map(); // runner -> [{ item, reason, tokens }]

  for (const item of items) {
    const channel = normalizeChannel(item);
    const runner = runnerOf(channel);
    if (runner !== "worker") {
      if (canFallback) {
        if (!groups.has(runner)) groups.set(runner, []);
        groups.get(runner).push({ item, reason: null, tokens: null });
        out.push({
          item,
          via: runner,
          result: { ok: true, degraded: true, message: `已按配置通道 ${runner} 分发（结果回传后更新）` },
        });
      } else {
        // 未配 GitHub 集成：退回 worker 直连尽力而为
        out.push({ item, via: "worker", result: await tryWorkerCheckin(channel) });
      }
      continue;
    }

    const result = await tryWorkerCheckin(channel);
    if (!result.ok && canFallback && !PERMANENT_FAIL_RE.test(String(result.message || ""))) {
      if (!groups.has("gha_api")) groups.set("gha_api", []);
      const reason = String(result.message || "").slice(0, 80) || "worker 直连失败";
      groups.get("gha_api").push({ item, reason, tokens: result.tokens || null });
      out.push({
        item,
        via: "gha_api",
        result: {
          ok: true,
          degraded: true,
          tokens: result.tokens || null,
          message: `worker 失败（${reason}），已降级 GitHub Actions（结果回传后更新）`,
        },
      });
      continue;
    }
    out.push({ item, via: "worker", result });
  }

  for (const [runner, entries] of groups) {
    const names = [...new Set(entries.map((e) => e.item.name))];
    try {
      await ghDispatchChannels(env, [runner], names);
    } catch (err) {
      // dispatch 整组失败（GitHub API 不可用等）：占位回退为真实失败说明
      for (const o of out) {
        if (o.via !== runner || !o.result?.degraded) continue;
        const entry = entries.find((e) => e.item === o.item);
        o.via = "worker";
        o.result = {
          ok: false,
          ...(entry?.tokens ? { tokens: entry.tokens } : {}),
          message: entry?.reason
            ? `worker 失败（${entry.reason}），且 GHA 分发失败：${err.message || err}`
            : `GHA 分发失败：${err.message || err}`,
        };
      }
    }
  }
  return out;
}

/** 单渠道便捷封装（保持既有导出签名） */
async function checkinWithFallback(channel, env) {
  const [out] = await batchCheckinCore([channel], env);
  return { result: out.result, via: out.via };
}

async function handleCheckin(request, env) {
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
    let result, via = "worker";
    if (action === "checkin") {
      ({ result, via } = await checkinWithFallback(channel, env));
    } else {
      result = await runAction(channel.type, action, channel);
    }
    // 签到推送 TG（余额/状态查询不打扰）。降级分发（via=gfa_*）的真实结果
    // 由 GHA 回传时推送，此处只在 worker 直连出结果时推送，避免重复。
    if (action === "checkin" && env && via === "worker" && (channel.options?.runner || "worker") === "worker") {
      await sendTelegram(
        env,
        formatCheckinReport("📌 单渠道签到", [
          { name: channel.name, ok: !!result?.ok, message: result?.message || (result?.ok ? "ok" : "failed") },
        ])
      );
    }
    const payload = publicResult(action, result);
    payload.via = via;
    return json(payload, result?.ok ? 200 : 422);
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

async function handleBatch(request, env) {
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
  if (action === "checkin") {
    // 批量核心：worker 直连 + 统一降级分发（整组一次 dispatch）
    const outcomes = await batchCheckinCore(list, env);
    for (const { item, result, via } of outcomes) {
      const pushed = {
        id: item.id,
        name: item.name,
        type: item.type,
        baseUrl: item.baseUrl,
        ...publicResult(action, result),
        via,
      };
      results.push(pushed);
    }
  } else {
    for (const raw of list) {
      const channel = normalizeChannel(raw);
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
        // 适配器降级刷新出的新 token 写回请求体，供调用方（UI/KV 同步）持久化
        if (result.tokens) {
          results[results.length - 1].tokens = result.tokens;
        }
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
  }
  // 签到动作推送 TG 报告（余额/状态查询不打扰）
  if (action === "checkin" && env) {
    await sendTelegram(
      env,
      formatCheckinReport(
        "📋 全部签到报告",
        results.map(({ name, ok, message }) => ({ name, ok, message }))
      )
    );
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

/**
 * 代理池管理（住宅 SOCKS5 出口）。
 *
 * 用途：GHA 机房 IP 拿不到 Turnstile token（Cloudflare 静默不签发挑战），
 * 住宅 IP 可以。浏览器通道带上代理后才能过这类站。
 *
 * GET  /api/proxies        列出（凭证打码）
 * PUT  /api/proxies        整表覆盖写入（body.proxies 支持字符串或对象数组）
 * POST /api/proxies/test   测连通性（body.url 测单条；body.all=true 测全部并回写结果）
 */
async function handleProxiesGet(env) {
  try {
    const proxies = await getProxies(env);
    return json({
      ok: true,
      count: proxies.length,
      proxies: proxies.map((p) => ({ ...p, url: maskProxyUrl(p.url), rawUrl: p.url })),
    });
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, err.status || 500);
  }
}

async function handleProxiesPut(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const list = Array.isArray(body.proxies) ? body.proxies : Array.isArray(body) ? body : null;
  if (!list) return json({ ok: false, error: "proxies[] is required" }, 400);

  const seen = new Set();
  const proxies = [];
  const rejected = [];
  for (const item of list) {
    const norm = normalizeProxy(item);
    if (!norm) {
      rejected.push(typeof item === "string" ? item.slice(0, 60) : JSON.stringify(item).slice(0, 60));
      continue;
    }
    if (seen.has(norm.url)) continue; // 同一代理填两次只留一条
    seen.add(norm.url);
    proxies.push(norm);
  }
  try {
    await putProxies(env, proxies);
    return json({
      ok: true,
      count: proxies.length,
      rejected,
      message: `已保存 ${proxies.length} 个代理${rejected.length ? `，${rejected.length} 条格式不合法已忽略` : ""}`,
    });
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, err.status || 500);
  }
}

async function handleProxiesTest(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // 单条测试：不落库，用于「填之前先试一下」
  if (body.url) {
    const r = await testSocks5(String(body.url), {
      targetHost: body.targetHost || "api.ipify.org",
      timeoutMs: Number(body.timeoutMs) || 12000,
    });
    return json({ ok: true, result: { url: maskProxyUrl(String(body.url)), ...r } });
  }

  // 全量测试：并发跑完后把结果写回 KV，面板直接显示每条的状态
  let proxies;
  try {
    proxies = await getProxies(env);
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, err.status || 500);
  }
  if (!proxies.length) return json({ ok: false, error: "代理池为空" }, 422);

  const targetHost = body.targetHost || "api.ipify.org";
  const timeoutMs = Number(body.timeoutMs) || 12000;
  const results = await Promise.all(
    proxies.map(async (p) => {
      const r = await testSocks5(p.url, { targetHost, timeoutMs });
      return { entry: p, r };
    })
  );
  const at = Date.now();
  for (const { entry, r } of results) {
    entry.lastCheck = {
      ok: r.ok,
      ms: r.ms ?? null,
      authUsed: r.authUsed || null,
      browserUsable: r.browserUsable ?? null,
      error: r.error || null,
      at,
    };
  }
  try {
    await putProxies(env, proxies);
  } catch {
    /* 结果仍然返回，只是没存下来 */
  }
  const okCount = results.filter((x) => x.r.ok).length;
  const usable = results.filter((x) => x.r.ok && x.r.browserUsable).length;
  return json({
    ok: true,
    count: results.length,
    okCount,
    browserUsable: usable,
    message:
      `连通 ${okCount}/${results.length}` +
      (okCount ? `，其中 ${usable} 个免认证（浏览器可用）` : "") +
      (okCount > usable ? `；带认证的 ${okCount - usable} 个 Chromium 用不了` : ""),
    results: results.map(({ entry, r }) => ({
      url: maskProxyUrl(entry.url),
      ok: r.ok,
      ms: r.ms ?? null,
      authUsed: r.authUsed || null,
      browserUsable: r.browserUsable ?? null,
      error: r.error || null,
    })),
  });
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
  // enabled[i] 与 outcomes[i] 一一对应，跑完后统一处理降级分发与 KV 回写
  const enabled = [];
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
    enabled.push(item);
  }

  // 批量核心：worker 渠道直连、非 worker 渠道标记分发、失败渠道收集降级
  const outcomes = await batchCheckinCore(enabled, env);
  for (const { item, result, via } of outcomes) {
    if (result.tokens) {
      item.auth = { ...(item.auth || {}), ...result.tokens };
    }
    item.lastResult = {
      ok: !!result.ok,
      summary: `checkin: ${result.message || (result.ok ? "ok" : "failed")}`,
      at: Date.now(),
    };
    results.push({
      name: item.name,
      type: item.type,
      baseUrl: item.baseUrl,
      ok: !!result.ok,
      message: result.message,
      ...(via !== "worker" ? { via } : {}),
    });
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
  // 允许 body 指定本次通道与渠道名单；names 缺省时按通道推全部启用渠道。
  // names 必须原样透传（降级链靠它精确分发单个渠道）——不能按 runner 重新过滤，
  // 否则 worker 渠道的降级请求会被「没有属于该通道的渠道」拒绝或偷换成整组重跑。
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const requested = Array.isArray(body.runners) ? body.runners.filter((r) => RUNNERS.has(r)) : null;
  const requestedNames = Array.isArray(body.names) ? body.names.map(String).filter(Boolean) : null;

  let channels = [];
  try {
    channels = await getChannels(env);
  } catch (err) {
    return json({ ok: false, error: `读取 KV 失败: ${err.message}` }, 500);
  }
  const names = requestedNames
    ? [...new Set(requestedNames)]
    : channels
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
    // 浏览器登录流程产生的新 token 写回 KV（sub2api 账密登录刷新）
    if (r.newTokens) {
      ch.auth = { ...(ch.auth || {}) };
      if (r.newTokens.accessToken) ch.auth.accessToken = r.newTokens.accessToken;
      if (r.newTokens.refreshToken) ch.auth.refreshToken = r.newTokens.refreshToken;
    }
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

// 命名导出仅供本地单测/脚本复用；Worker 入口仍是 default export
export { handleCheckin, handleBatch, runScheduled, checkinWithFallback, batchCheckinCore };

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
          bodyHead: text.slice(0, Number(body.maxLen) || 300),
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
      return handleCheckin(request, env);
    }

    if (request.method === "POST" && pathname === "/api/batch") {
      return handleBatch(request, env);
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

    // 代理池（住宅 SOCKS5 出口，供 GHA 浏览器通道过 Turnstile）
    if (pathname === "/api/proxies" && request.method === "GET") {
      return handleProxiesGet(env);
    }
    if (pathname === "/api/proxies" && (request.method === "PUT" || request.method === "POST")) {
      return handleProxiesPut(request, env);
    }
    if (pathname === "/api/proxies/test" && request.method === "POST") {
      return handleProxiesTest(request, env);
    }

    return json({ ok: false, error: "Not Found", path: pathname }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};
