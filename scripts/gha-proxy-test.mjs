/** GitHub 代理诊断：只请求公开 IP 服务，不读取渠道或发送签到凭证。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseProxyUrl } from "../src/proxy.js";
import { PROXY_TEST_ERRORS, PROXY_TEST_TARGET } from "../src/proxy-test.js";

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function curlUrl(parsed, credentials = true) {
  const scheme = parsed.scheme === "socks5" ? "socks5h" : parsed.scheme === "socks4" ? "socks4a" : parsed.scheme;
  const auth = credentials && parsed.username
    ? `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password)}@` : "";
  return `${scheme}://${auth}${parsed.host}:${parsed.port}`;
}

export function curlErrorCode(error) {
  if (error.killed || error.signal || Number(error.code) === 28) return "TIMEOUT";
  const code = Number(error.code);
  if ([5, 6].includes(code)) return "DNS";
  if ([51, 60].includes(code)) return "TLS_CERT";
  if ([35, 59].includes(code)) return "TLS";
  if ([67, 97].includes(code) || /\b407\b/.test(error.stderr || "")) return "AUTH";
  if ([7, 52, 55, 56].includes(code)) return "CONNECT";
  if (code === 22) return "HTTP";
  if (error.code === "ENOENT" || error.code === "EACCES") return "CURL";
  return "UNKNOWN";
}

export async function curlProbe(proxyUrl, { timeoutMs = 12000, exec = execute } = {}) {
  const started = Date.now();
  const duration = Math.min(20000, Math.max(1000, Number(timeoutMs) || 12000));
  try {
    const { stdout } = await exec("curl", [
      // 必须第一个参数：不读取 .curlrc，杜绝被本地配置偷偷打开 --insecure。
      "--disable", "--silent", "--show-error", "--fail",
      "--proxy", proxyUrl, "--noproxy", "", "--proxy-basic",
      "--proto", "=https", "--connect-timeout", String(Math.min(duration / 1000, 10)),
      "--max-time", String(duration / 1000), "--max-filesize", "4096",
      PROXY_TEST_TARGET,
    ], { timeout: duration + 2000, maxBuffer: 16384, encoding: "utf8", windowsHide: true });
    let ip;
    try { ip = JSON.parse(stdout).ip; } catch { /* 下方统一处理无效响应 */ }
    if (typeof ip !== "string" || !isIP(ip)) return { ok: false, ms: Date.now() - started, errorCode: "RESPONSE" };
    return { ok: true, ms: Date.now() - started, ip, tlsVerified: true };
  } catch (error) {
    // execFile 的 message 可能包含完整命令（代理密码），绝不输出它或原始 stderr。
    return { ok: false, ms: Date.now() - started, errorCode: curlErrorCode(error) };
  }
}

export async function testSavedProxy(entry, { probe = curlProbe, timeoutMs = 12000 } = {}) {
  const parsed = parseProxyUrl(entry.url);
  if (!parsed) return { id: entry.id, ok: false, ms: 0, errorCode: "CONNECT", browserUsable: false };
  const socks = parsed.scheme.startsWith("socks");
  // 浏览器不给 SOCKS 提供密码；先按浏览器的免认证行为测，再区分“只能带认证使用”。
  let result = await probe(curlUrl(parsed, !socks), { timeoutMs });
  let authUsed = !socks && parsed.username ? "basic" : "none";
  let browserUsable = result.ok;
  if (!result.ok && socks && parsed.username) {
    result = await probe(curlUrl(parsed), { timeoutMs });
    authUsed = "userpass";
    browserUsable = false;
  }
  return { ...result, id: entry.id, authUsed, browserUsable };
}

export async function testProxyBatch(entries, { concurrency = 5, test = testSavedProxy, timeoutMs = 12000 } = {}) {
  const results = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(entries.length, Math.max(1, concurrency)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= entries.length) return;
      try {
        results[i] = await test(entries[i], { timeoutMs });
      } catch {
        results[i] = { id: entries[i].id, ok: false, ms: 0, errorCode: "UNKNOWN", browserUsable: false };
      }
    }
  }));
  return results;
}

export async function runProxyJob(env = process.env, { fetchImpl = fetch, delay = sleep, testBatch = testProxyBatch, save = writeFile, log = console.log } = {}) {
  const jobId = env.PROXY_TEST_JOB_ID;
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(jobId || "")) throw new Error("缺少或无效的 PROXY_TEST_JOB_ID");
  if (!env.HUB_BASE_URL || !env.HUB_SECRET) throw new Error("缺少 GitHub Secrets: HUB_BASE_URL / HUB_SECRET");
  let base;
  try { base = new URL(env.HUB_BASE_URL); } catch { throw new Error("HUB_BASE_URL 不是有效 URL"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("HUB_BASE_URL 必须是不含凭证、查询串的 HTTPS 地址");
  }
  async function hubRequest(path, body) {
    // KV 跨区域可见性可能延迟约一分钟；首次 404 也要重试，避免把排队当成任务丢失。
    const waits = [2000, 5000, 15000, 30000, 30000];
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      try {
        const response = await fetchImpl(new URL(path, base.origin), {
          method: body ? "POST" : "GET", redirect: "error",
          headers: { "Content-Type": "application/json", "X-Cron-Secret": env.HUB_SECRET },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(20000),
        });
        status = response.status;
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.ok === true) return data;
      } catch { /* 不转发 fetch 异常中可能出现的 URL 或请求信息 */ }
      const retryable = status === 0 || status === 429 || status >= 500 || (!body && status === 404);
      if (!retryable || attempt >= waits.length) {
        throw new Error(`Hub ${body ? "结果回写" : "任务读取"}失败（${status ? `HTTP ${status}` : "网络或响应错误"}），请检查工作流与 HUB_* Secrets`);
      }
      await delay(waits[attempt]);
    }
  }
  const { job } = await hubRequest(`/api/proxies/test/task?id=${jobId}`);
  if (!job || job.id !== jobId || job.targetUrl !== PROXY_TEST_TARGET || !Array.isArray(job.proxies) || !job.proxies.length || job.proxies.length > 100) {
    throw new Error("Hub 返回的代理任务格式不合法");
  }
  const results = await testBatch(job.proxies, { timeoutMs: job.timeoutMs });
  const payload = { jobId, results, runId: env.GITHUB_RUN_ID || "" };
  // 产物没有地址、密码或原始 curl 错误，仅包含任务内编号及诊断结果。
  await save("proxy-results.json", JSON.stringify(payload, null, 2));
  for (const r of results) log(`代理 #${r.id}: ${r.ok ? `HTTPS 通过 ${r.ms}ms${r.browserUsable ? "" : "（需要 SOCKS 认证）"}` : PROXY_TEST_ERRORS[r.errorCode] || PROXY_TEST_ERRORS.UNKNOWN}`);
  const response = await hubRequest("/api/proxies/test/result", payload);
  log(`已回写 ${response.merged || 0} 个代理结果；验证通过 ${results.filter((r) => r.ok).length}/${results.length}`);
  return response;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runProxyJob().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
