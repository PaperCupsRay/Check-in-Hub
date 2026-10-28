import { kvBound, getProxies, putProxies } from "./kv.js";
import { parseProxyUrl, maskProxyUrl } from "./proxy.js";
import { timingSafeEqual } from "./auth.js";

// 事件载荷只有 jobId；含凭证的任务快照只能通过 CRON_SECRET 拉取。
const JOB_PREFIX = "proxy_test:";
const LATEST_KEY = "proxy_test_latest";
const JOB_TTL = 86400;
export const PROXY_TEST_TIMEOUT_MS = 30 * 60 * 1000;
export const PROXY_TEST_TARGET = "https://api.ipify.org?format=json";
export const PROXY_TEST_ERRORS = Object.freeze({
  DNS: "无法解析代理地址",
  CONNECT: "无法连接代理地址或端口",
  TIMEOUT: "代理连接或 HTTPS 请求超时",
  AUTH: "代理拒绝连接或认证失败",
  TLS_CERT: "TLS 证书校验失败（代理或目标证书不受信任），未绕过校验",
  TLS: "TLS 握手失败",
  HTTP: "代理隧道或 HTTPS 目标返回错误状态",
  RESPONSE: "HTTPS 响应不是有效的出口 IP",
  CURL: "GitHub 执行环境缺少 curl 或无法启动检测",
  UNKNOWN: "代理检测失败，请检查地址、认证或 GitHub 运行状态",
});

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function requireKv(env) {
  if (!kvBound(env)) throw fail("CHECKIN_KV 未绑定", 503);
}

function jobKey(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) {
    throw fail("代理检测任务编号不合法");
  }
  return JOB_PREFIX + id;
}

async function readJob(env, id) {
  requireKv(env);
  const raw = await env.CHECKIN_KV.get(jobKey(id));
  if (!raw) throw fail("代理检测任务不存在或已过期", 404);
  return JSON.parse(raw);
}

async function writeJob(env, job) {
  await env.CHECKIN_KV.put(jobKey(job.id), JSON.stringify(job), { expirationTtl: JOB_TTL });
}

function effectiveStatus(job) {
  return job.status === "queued" && Date.now() - job.createdAt > PROXY_TEST_TIMEOUT_MS
    ? "timed_out" : job.status;
}

function publicJob(job) {
  const status = effectiveStatus(job);
  const results = (job.results || []).map((r) => ({
    ...r,
    url: maskProxyUrl(job.proxies.find((p) => p.id === r.id)?.url || ""),
  }));
  const okCount = results.filter((r) => r.ok).length;
  const browserUsable = results.filter((r) => r.ok && r.browserUsable).length;
  const message = status === "completed"
    ? `GitHub HTTPS 验证通过 ${okCount}/${job.proxies.length}，浏览器认证兼容 ${browserUsable} 个`
    : status === "timed_out"
      ? "30 分钟内未收到 GitHub 结果，请检查工作流是否已推送、Actions 是否启用及 HUB_* Secrets"
      : job.error || "已提交 GitHub Actions，正在排队或检测；完成后自动回写";
  return {
    id: job.id, status, source: "github", count: job.proxies.length,
    createdAt: job.createdAt, completedAt: job.completedAt || null,
    runUrl: job.runUrl || null, okCount, browserUsable, results, message,
  };
}

/** 面板与 Telegram 共用；只检测已保存且启用的代理，最多 100 条。 */
export async function startProxyTest(env, { urls, notify = true } = {}) {
  requireKv(env);
  if (!env.GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GH_REPO || "")) {
    throw fail("请先配置 GH_TOKEN 和 GH_REPO（owner/repo），并推送代理检测工作流");
  }
  if (!env.CRON_SECRET) throw fail("请先配置 CRON_SECRET，并在 GitHub 设置同值的 HUB_SECRET");
  if (urls !== undefined && (!Array.isArray(urls) || !urls.length || urls.some((u) => typeof u !== "string"))) {
    throw fail("urls 必须是非空的已保存代理地址数组");
  }
  const stored = await getProxies(env);
  const wanted = urls && new Set(urls);
  const selected = stored.filter((p) => p && p.enabled !== false && parseProxyUrl(p.url) && (!wanted || wanted.has(p.url)));
  if (wanted && [...wanted].some((u) => !selected.some((p) => p.url === u))) {
    throw fail("指定的代理不存在、格式不合法或已停用", 422);
  }
  if (!selected.length) throw fail("没有可检测的启用代理，请先保存并启用代理", 422);
  if (selected.length > 100) throw fail("单次最多检测 100 个代理，请停用多余代理后重试", 422);
  const job = {
    id: crypto.randomUUID(), status: "queued", createdAt: Date.now(), notify: notify === true,
    proxies: selected.map((p, i) => ({ id: String(i), url: p.url })),
  };
  await writeJob(env, job);
  await env.CHECKIN_KV.put(LATEST_KEY, job.id, { expirationTtl: JOB_TTL });
  try {
    const response = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}`,
        "User-Agent": "checkin-hub", "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: "proxy-test", client_payload: { jobId: job.id } }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 204) throw fail(`GitHub 分发失败（HTTP ${response.status}），请检查仓库与令牌权限`, 502);
  } catch (error) {
    job.status = "failed";
    job.error = error.status ? error.message : "GitHub 分发请求失败或超时，请检查网络及令牌配置";
    await writeJob(env, job);
    throw fail(job.error, 502);
  }
  const view = publicJob(job);
  return { ok: true, job: view, message: view.message };
}

export async function getProxyTestStatus(env, id = "") {
  requireKv(env);
  const selectedId = id || await env.CHECKIN_KV.get(LATEST_KEY);
  if (!selectedId) return { ok: true, job: null };
  const job = await readJob(env, selectedId);
  return { ok: true, job: publicJob(job) };
}

export function proxyRunnerAuthenticated(request, env) {
  const secret = request.headers.get("X-Cron-Secret") || "";
  return !!(env.CRON_SECRET && secret && timingSafeEqual(secret, String(env.CRON_SECRET)));
}

/** 仅在入口校验 runner secret 后调用；不包含渠道或其它任务的凭证。 */
export async function getProxyTestTask(env, id) {
  const job = await readJob(env, id);
  if (effectiveStatus(job) !== "queued") throw fail("代理检测任务已结束或超时", 409);
  return { ok: true, job: { id: job.id, proxies: job.proxies, targetUrl: PROXY_TEST_TARGET, timeoutMs: 12000 } };
}

function validIp(ip) {
  if (typeof ip !== "string" || ip.length > 45) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip.split(".").every((part) => Number(part) <= 255);
  if (!ip.includes(":") || !/^[\da-fA-F:.]+$/.test(ip)) return false;
  try { return new URL(`http://[${ip}]/`).hostname.startsWith("["); } catch { return false; }
}

function safeResult(input, proxy) {
  if (!input || typeof input.ok !== "boolean" || !Number.isFinite(input.ms) || input.ms < 0 || input.ms > 120000) {
    throw fail("代理检测结果格式不合法");
  }
  const ip = validIp(input.ip) ? input.ip : null;
  if (input.ok && (!ip || input.tlsVerified !== true || typeof input.browserUsable !== "boolean")) {
    throw fail("成功结果必须包含出口 IP、TLS 验证及浏览器认证兼容性");
  }
  const code = Object.hasOwn(PROXY_TEST_ERRORS, input.errorCode) ? input.errorCode : "UNKNOWN";
  return {
    id: proxy.id, ok: input.ok, ms: Math.round(input.ms), ip,
    source: "github", scheme: parseProxyUrl(proxy.url).scheme,
    tlsVerified: input.ok, browserUsable: input.ok && input.browserUsable,
    authUsed: ["none", "userpass", "basic"].includes(input.authUsed) ? input.authUsed : null,
    certUntrusted: !input.ok && code === "TLS_CERT",
    errorCode: input.ok ? null : code,
    // 不存 runner 原始 stderr，避免 curl 报错意外泄露代理密码。
    error: input.ok ? null : PROXY_TEST_ERRORS[code],
  };
}

/** 按任务内 id 验证结果，再按原 URL 合并当前池；删除/改密/新结果都不会被旧任务覆盖。 */
export async function completeProxyTest(env, body) {
  if (!body || typeof body !== "object") throw fail("请求体必须是对象");
  const job = await readJob(env, body.jobId);
  if (job.status === "completed") return { ok: true, duplicate: true, merged: 0, job: publicJob(job) };
  if (effectiveStatus(job) !== "queued") throw fail("代理检测任务已结束或超时", 409);
  if (!Array.isArray(body.results) || body.results.length !== job.proxies.length) {
    throw fail("results 必须包含本任务的全部代理，数量不匹配");
  }
  const byId = new Map();
  for (const r of body.results) {
    if (!r || typeof r.id !== "string" || byId.has(r.id) || !job.proxies.some((p) => p.id === r.id)) {
      throw fail("results 包含重复或不属于本任务的代理编号");
    }
    byId.set(r.id, r);
  }
  const results = job.proxies.map((p) => safeResult(byId.get(p.id), p));
  const current = await getProxies(env);
  const byUrl = new Map(current.map((p) => [p.url, p]));
  const at = Date.now();
  let merged = 0;
  for (let i = 0; i < job.proxies.length; i++) {
    const entry = byUrl.get(job.proxies[i].url);
    if (!entry || (entry.lastCheck?.requestedAt ?? entry.lastCheck?.at ?? 0) > job.createdAt) continue;
    const { id, ...result } = results[i];
    entry.lastCheck = { ...result, at, requestedAt: job.createdAt, jobId: job.id };
    merged++;
  }
  if (merged) await putProxies(env, current);
  job.status = "completed";
  job.completedAt = at;
  job.results = results;
  if (/^\d+$/.test(String(body.runId || ""))) job.runUrl = `https://github.com/${env.GH_REPO}/actions/runs/${body.runId}`;
  await writeJob(env, job);
  return { ok: true, merged, notify: job.notify, job: publicJob(job) };
}
