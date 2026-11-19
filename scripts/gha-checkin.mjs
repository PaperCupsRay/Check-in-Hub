/**
 * GitHub Actions 签到 runner。
 *
 * 流程：从 Worker 面板拉取渠道列表 → 按通道过滤 → 在 Actions runner 上
 * 逐站执行签到 → 把结果回传给 Worker 写入 KV。
 *
 * 两种通道：
 *   gha_api     纯 HTTP，直接复用本项目适配器（覆盖「封 CDN IP」站点）
 *   gha_browser CloakBrowser 反检测浏览器先解 WAF（acw_tc/acw_sc__v2/CF 挑战），
 *               拿到 WAF cookie 后再走适配器请求（覆盖 gorouter/SeekAi 等）
 *
 * 触发方式：
 *   repository_dispatch 的 client_payload.runners 指定本次通道（数组）；
 *   手动/定时触发时用环境变量 RUNNERS（逗号分隔），缺省跑 gha_api。
 *
 * 所需环境变量（配置在 GitHub Secrets 中）：
 *   HUB_BASE_URL         面板地址，如 https://checkin.example.com
 *   HUB_SECRET           面板的 CRON_SECRET（回传结果时鉴权）
 *   HUB_ACCESS_PASSWORD  面板访问密码（开启密码时必填）
 *   CHECKIN_HEADLESS     browser 通道是否无头（GHA 用 xvfb 时设 false）
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isPermanentCheckinFailure } from "../src/checkin-retry.js";

const HUB = (process.env.HUB_BASE_URL || "").replace(/\/+$/, "");
const SECRET = process.env.HUB_SECRET || "";
const PASSWORD = process.env.HUB_ACCESS_PASSWORD || "";
const HEADLESS = (process.env.CHECKIN_HEADLESS || "true") !== "false";
// Cloudflare 会按 UA 拦默认的 node fetch（undici），与浏览器保持一致
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/**
 * 浏览器通道能兜住的渠道类型（与 scripts/browser-checkin.py 的流程一一对应）。
 * nodeseek / linuxsb 是 2026-10-13 加进来的：这两站全站挂在 Cloudflare 后面，而
 * cf_clearance 与出口 IP 绑定，Worker 与 Azure 出口实测都是 302/403，只有真浏览器
 * 过得了挑战（详见 scripts/browser-checkin.py 里那两个 browser 流程的说明）。
 */
const BROWSER_TYPES = new Set(["sub2api", "newapi", "nodeseek", "linuxsb"]);

function payloadRunners() {
  // repository_dispatch payload 通过 GITHUB_EVENT_PATH 传入
  try {
    const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const r = ev?.client_payload?.runners;
    if (Array.isArray(r) && r.length) return r;
  } catch {}
  const env = (process.env.RUNNERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return env.length ? env : ["gha_api"];
}

function usd(quota, perUnit = 500000) {
  const n = Number(quota) / (Number(perUnit) || 500000);
  return Number.isFinite(n) ? `$${n.toFixed(Math.abs(n) < 0.01 && n !== 0 ? 4 : 2)}` : String(quota);
}

async function hubLogin() {
  if (!PASSWORD) return null;
  const res = await fetch(`${HUB}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`面板登录失败: ${data.error || res.status}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { token: data.token, cookie };
}

async function fetchChannels() {
  const auth = await hubLogin();
  const headers = { Accept: "application/json", "User-Agent": UA };
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth?.cookie) headers.Cookie = auth.cookie;
  const res = await fetch(`${HUB}/api/kv/channels`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`拉取渠道失败: ${data.error || res.status}`);
  return (data.channels || []).filter((c) => c.enabled !== false && c.baseUrl);
}


/** gha_browser 通道：读取 waf-cookies.py 产出并合并进渠道 cookie */
function mergeWafCookies(channel) {
  try {
    const map = JSON.parse(fs.readFileSync("waf_cookies.json", "utf8"));
    const entry = map[channel.name];
    if (!entry?.cookies || !Object.keys(entry.cookies).length) return channel;
    const waf = Object.entries(entry.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    return { ...channel, auth: { ...channel.auth, cookie: [channel.auth?.cookie, waf].filter(Boolean).join("; ") } };
  } catch {
    return channel;
  }
}

export async function runOne(channel, runner, action = null) {
  const runAction = action || (await import("../src/adapters/index.js")).runAction;
  const started = Date.now();
  try {
    let ch = channel;
    if (runner === "gha_browser") {
      ch = mergeWafCookies(channel);
      const hasWaf = /acw_tc|acw_sc__v2|cf_clearance|cdn_sec_tc/i.test(ch.auth?.cookie || "");
      if (!hasWaf) {
        return { name: channel.name, type: channel.type, ok: false, runner, message: "无可用 WAF cookie（浏览器解挑战未产出）", ms: Date.now() - started };
      }
    }
    const r = await runAction(channel.type, "checkin", ch);
    const u = r.user || {};
    const qi = u.quota != null
      ? {
          quota: u.quota,
          usedQuota: u.usedQuota ?? u.raw?.used_quota,
          quotaPerUnit: u.quotaPerUnit ?? u.raw?.quota_per_unit ?? 500000,
          account: u.displayName || u.username || u.email || "",
          updatedAt: started,
          lastReward: r.result?.reward ?? null,
        }
      : null;
    return {
      name: channel.name,
      type: channel.type,
      ok: !!r.ok,
      runner,
      message: r.message || (r.ok ? "ok" : "failed"),
      httpStatus: r.httpStatus ?? null,
      needsBrowser: !!r.needsBrowser,
      // runAction 已执行共享重试；这里只保留最终结论与刷新出的凭证，不再重试 HTTP。
      retryable: isPermanentCheckinFailure(r) ? false : r.retryable,
      attempts: r.attempts ?? null,
      maxAttempts: r.maxAttempts ?? null,
      newTokens: r.tokens || null,
      // 签到顺带的抽奖结论（适配器放在 result.lottery 里）：回传后 TG 报告单独占一行
      lottery: r.result?.lottery || null,
      quotaInfo: qi,
      ms: Date.now() - started,
    };
  } catch (e) {
    return { name: channel.name, type: channel.type, ok: false, runner,
      httpStatus: e.status ?? null, message: e.message || String(e), ms: Date.now() - started };
  }
}

export async function report(results) {
  if (!HUB || !SECRET) {
    console.log("未配置 HUB_BASE_URL / HUB_SECRET，跳过回传（结果仅存 artifact）");
    return false;
  }
  const res = await fetch(`${HUB}/api/gh/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ secret: SECRET, results }),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`回传结果: HTTP ${res.status} merged=${data.merged ?? "?"}`);
  if (!res.ok || !data.ok) throw new Error(`回传结果失败: HTTP ${res.status}`);
  return true;
}

function payloadNames() {
  // 本次精确要跑的渠道名（Worker 降级链分发时指定）；空 = 不过滤，按通道跑全部
  try {
    const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const n = ev?.client_payload?.names;
    if (Array.isArray(n) && n.length) return n.map(String);
  } catch {}
  return null;
}

/**
 * 反向请求面板触发浏览器通道（只带这批渠道）。
 *
 * 用于「本次 run 不带 browser job」的场景：那时 gha-fallback.json 没人接手，
 * api 侧再失败也传不出去，渠道会一直漏签到浏览器通道能解为止。
 */
export async function dispatchBrowserFallback(names) {
  if (!HUB) {
    console.log(`无处转交浏览器通道（缺 HUB_BASE_URL）: ${names.join("、")}`);
    return false;
  }
  try {
    // 面板开了访问密码就用无状态头，省掉一次登录往返（也避开 set-cookie 的脆弱解析）；
    // 面板没开密码时这个头无所谓，照发。
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": UA,
      ...(PASSWORD ? { "X-Access-Password": PASSWORD } : {}),
    };
    const res = await fetch(`${HUB}/api/gh/dispatch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runners: ["gha_browser"], names }),
    });
    const data = await res.json().catch(() => ({}));
    console.log(
      `已请求面板触发浏览器通道（${names.join("、")}）: HTTP ${res.status} ${data.message || data.error || ""}`
    );
    return !!(res.ok && data.ok);
  } catch (e) {
    console.log(`触发浏览器通道失败: ${e.message || e}`);
    return false;
  }
}

/** 先持久化待确认结果，再启动独立 browser run，避免旧回传覆盖新 run 的终态。 */
export async function reportWithBrowserFallback(results, runners, ghaBrowserNames = [], {
  reportResults = report,
  dispatch = dispatchBrowserFallback,
  writeFallback = (names) => fs.writeFileSync("gha-fallback.json", JSON.stringify(names, null, 2)),
} = {}) {
  const fallback = results.filter((r) => r.runner === "gha_api" && !r.ok &&
    BROWSER_TYPES.has(r.type) && !isPermanentCheckinFailure(r));
  const needBrowser = [...new Set(fallback.map((r) => r.name))];
  const nameSet = new Set(needBrowser);
  const browserInRun = runners.includes("gha_browser");
  // API-only 只反向 dispatch；含 browser 的同 run 才把清单交给 artifact 流程。
  writeFallback(browserInRun ? needBrowser : []);
  const reason = (r) => r.message || "HTTP 签到失败";
  let reported = results.map((r) => nameSet.has(r.name) && fallback.includes(r) ? {
    ...r,
    pending: true,
    message: `HTTP通道未完成，正在自动转浏览器，等待最终结果（原始原因：${reason(r)}）`,
  } : r);
  const persisted = await reportResults(reported);
  if (!needBrowser.length || browserInRun) return reported;

  // 带上常规 browser 渠道，避免 GitHub 同组取消旧的 pending run 后漏签。
  const names = [...new Set([...needBrowser, ...ghaBrowserNames])];
  console.log(`需要浏览器通道: ${needBrowser.join("、")}`);
  const dispatched = persisted !== false && await dispatch(names);
  if (!dispatched) {
    const failed = fallback.map((r) => ({
      ...r,
      pending: false,
      message: `HTTP通道未完成，浏览器任务启动失败，签到最终失败（原始原因：${reason(r)}）`,
    }));
    // 仅更新启动失败的渠道，不能拿本批其他旧结果覆盖新的回传。
    await reportResults(failed);
    const byName = new Map(failed.map((r) => [r.name, r]));
    reported = reported.map((r) => nameSet.has(r.name) && r.pending ? byName.get(r.name) : r);
  }
  return reported;
}

async function main() {
  if (!HUB) {
    console.error("缺少 HUB_BASE_URL");
    process.exit(1);
  }
  const runners = payloadRunners();
  const names = payloadNames();
  console.log(`本次通道: ${runners.join(", ")}${names ? ` | 指定渠道: ${names.join("、")}` : " | 全部"}`);

  const channels = await fetchChannels();
  // 反向补触发浏览器通道时要一并带上的常规 browser 渠道。
  const ghaBrowserNames = channels
    .filter((c) => (c.options?.runner || "worker") === "gha_browser")
    .map((c) => c.name);
  // 精确分发（降级链）按 names 选渠道，并把其执行通道视为请求的主通道——
  // 渠道配置的 runner 是「常规调度」的归属，降级请求本身已决定用哪条通道。
  // 常规触发（无 names）仍按渠道配置的 runner 过滤。
  const nameSet = names ? new Set(names) : null;
  const targets = channels.filter((c) => {
    if (nameSet) return nameSet.has(c.name);
    return runners.includes(c.options?.runner || "worker");
  });
  console.log(`匹配渠道 ${targets.length}/${channels.length} 个: ${targets.map((c) => c.name).join("、") || "(无)"}`);

  const results = [];
  for (const ch of targets) {
    const runner = nameSet ? runners[0] : ch.options?.runner || "worker";
    process.stdout.write(`→ [${runner}] ${ch.name} (${ch.type}) ... `);
    const r = await runOne(ch, runner);
    console.log(r.ok ? "OK" : "FAIL", "-", (r.message || "").slice(0, 120));
    results.push(r);
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n完成: ${okCount}/${results.length} 成功`);
  for (const r of results) {
    if (r.ok && r.quotaInfo?.quota != null) {
      console.log(`  ${r.name}: ${usd(r.quotaInfo.quota, r.quotaInfo.quotaPerUnit)}`);
    }
  }

  const reported = await reportWithBrowserFallback(results, runners, ghaBrowserNames);
  fs.writeFileSync("gha-results.json", JSON.stringify(reported, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
