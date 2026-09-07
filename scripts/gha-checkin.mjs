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

const HUB = (process.env.HUB_BASE_URL || "").replace(/\/+$/, "");
const SECRET = process.env.HUB_SECRET || "";
const PASSWORD = process.env.HUB_ACCESS_PASSWORD || "";
const HEADLESS = (process.env.CHECKIN_HEADLESS || "true") !== "false";

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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`面板登录失败: ${data.error || res.status}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { token: data.token, cookie };
}

async function fetchChannels() {
  const auth = await hubLogin();
  const headers = { Accept: "application/json" };
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

async function runOne(channel, runner) {
  const { runAction } = await import("../src/adapters/index.js");
  const started = Date.now();
  try {
    let ch = channel;
    if (runner === "gha_browser") {
      ch = mergeWafCookies(channel);
      const hasWaf = /acw_tc|acw_sc__v2|cf_clearance|cdn_sec_tc/i.test(ch.auth?.cookie || "");
      if (!hasWaf) {
        return { name: channel.name, ok: false, runner, message: "无可用 WAF cookie（浏览器解挑战未产出）", ms: Date.now() - started };
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
      ok: !!r.ok,
      runner,
      message: r.message || (r.ok ? "ok" : "failed"),
      httpStatus: r.httpStatus ?? null,
      quotaInfo: qi,
      ms: Date.now() - started,
    };
  } catch (e) {
    return { name: channel.name, ok: false, runner, message: e.message || String(e), ms: Date.now() - started };
  }
}

async function report(results) {
  if (!HUB || !SECRET) {
    console.log("未配置 HUB_BASE_URL / HUB_SECRET，跳过回传（结果仅存 artifact）");
    return;
  }
  const res = await fetch(`${HUB}/api/gh/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SECRET, results }),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`回传结果: HTTP ${res.status} merged=${data.merged ?? "?"}`);
}

async function main() {
  if (!HUB) {
    console.error("缺少 HUB_BASE_URL");
    process.exit(1);
  }
  const runners = payloadRunners();
  console.log(`本次通道: ${runners.join(", ")}`);

  const channels = await fetchChannels();
  const targets = channels.filter((c) => runners.includes(c.options?.runner || "worker"));
  console.log(`匹配渠道 ${targets.length}/${channels.length} 个: ${targets.map((c) => c.name).join("、") || "(无)"}`);

  const results = [];
  for (const ch of targets) {
    const runner = ch.options?.runner || "worker";
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

  await report(results);
  fs.writeFileSync("gha-results.json", JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
