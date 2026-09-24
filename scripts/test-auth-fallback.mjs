/**
 * 鉴权回退 / 降级路由的离线回归测试（mock fetch，不联网）。
 *
 * 跑法：npm test
 *
 * 这些用例对应实际踩过的坑，别让它们退化：
 *   1. 成功结果绝不重试 —— 否则会重复 POST /api/v1/check-in，第二次的「今日已签到」
 *      会把真实奖励文案覆盖掉（历史事故）。
 *   2. token 过期要能自愈：refreshToken 换新 / 账密重新登录后继续签到。
 *   3. 两条回退都失败时原因要写进文案（旧版只透传站点原文，读起来像「根本没回退」）。
 *   4. 「登录要求人机验证（Turnstile）」这类失败要标 needsBrowser，直接降级浏览器通道，
 *      不要去 gha_api 再失败一次（2026-09-24 林夕/k40 就是这个形态）。
 *   5. 业务失败（「账号需连续登录 3 天」「Token 额度不足」）不得被误判成 token 失效，
 *      否则白跑一次 refresh + 账密登录 + 第二次签到。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const REPO = path.join(HERE, "..");

// src/index.js 里有 `import uiHtml from "./ui.html"`（wrangler 的 Text 规则），Node 加载不了。
// 这里把它替换成占位常量、并把相对导入改成绝对路径，落到 node_modules/.cache 下再动态导入
// （放那儿是为了让 tweetnacl / @noble/hashes 这些裸包名照常解析）。
function loadWorkerModule() {
  const cacheDir = path.join(REPO, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `checkin-hub-index-probe-${process.pid}.mjs`);

  let code = fs.readFileSync(path.join(SRC, "index.js"), "utf8");
  code = code.replace(/^import uiHtml from "\.\/ui\.html";$/m, 'const uiHtml = "<html></html>";');
  code = code.replace(/from "\.\/((?:adapters\/)?[\w.-]+\.js)"/g, (_m, p) => `from "${toUrl(path.join(SRC, p))}"`);
  fs.writeFileSync(target, code);
  return import(toUrl(target)).finally(() => {
    try {
      fs.unlinkSync(target);
    } catch {
      /* 清理失败不影响测试结论 */
    }
  });
}

const toUrl = (p) => `file:///${path.resolve(p).replace(/\\/g, "/")}`;

const { batchCheckinCore } = await loadWorkerModule();

const BASE = "https://k40.example.com";
const OLD_ACCESS = "OLD_ACCESS_TOKEN";
const NEW_ACCESS = "NEW_ACCESS_TOKEN";
const NEW_REFRESH = "NEW_REFRESH_TOKEN";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const checkinOk = () =>
  json(200, {
    code: 0,
    message: "success",
    data: { reward_amount: 3.44, balance_after: 16.74, current_streak: 72, total_check_in_days: 72 },
  });
// 2026-09-24 k40 实测的三个回话
const tokenExpired = () => json(401, { code: "TOKEN_EXPIRED", message: "Token has expired" });
const refreshInvalid = () =>
  json(401, { code: 401, message: "invalid refresh token", reason: "REFRESH_TOKEN_INVALID" });
const loginTurnstile = () =>
  json(400, { code: 400, message: "turnstile verification failed", reason: "TURNSTILE_VERIFICATION_FAILED" });
const refreshOk = () =>
  json(200, { code: 0, message: "ok", data: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 86400 } });
const loginOk = () =>
  json(200, {
    code: 0,
    message: "login ok",
    data: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, user: { id: 7, email: "user@example.com" } },
  });

function makeChannel(auth = {}) {
  return {
    id: "ch_test",
    name: "林夕",
    type: "sub2api",
    baseUrl: BASE,
    enabled: true,
    auth: { email: "user@example.com", password: "secret123", accessToken: OLD_ACCESS, refreshToken: "OLD_REFRESH", ...auth },
    options: {},
  };
}

const GH_ENV = { GH_TOKEN: "ghp_test", GH_REPO: "owner/repo" };

/** 装一次 fetch：记录请求并按 scenario 回话 */
function installFetch(scenario) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const headers = init.headers || {};
    calls.push({ url: u, method: init.method || "GET", auth: headers.Authorization || "", body: init.body });
    if (u.includes("api.github.com")) return new Response(null, { status: 204 }); // repository_dispatch
    if (u.includes("/api/v1/auth/refresh")) return scenario.refresh();
    if (u.includes("/api/v1/auth/login")) return scenario.login();
    if (u.includes("/api/v1/check-in")) {
      return (headers.Authorization || "") === `Bearer ${OLD_ACCESS}` ? scenario.checkinOld() : scenario.checkinNew();
    }
    return json(404, { message: `unexpected url ${u}` });
  };
  return calls;
}

let failures = 0;
const check = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${extra ? ` — ${extra}` : ""}`);
};

async function scenario(name, spec, fn) {
  console.log(`\n=== ${name} ===`);
  const calls = installFetch(spec.fetch);
  const out = await batchCheckinCore([spec.channel ?? makeChannel()], spec.env ?? GH_ENV);
  const { result, via } = out[0];
  const checkins = calls.filter((c) => c.url.includes("/api/v1/check-in"));
  const authCalls = calls.filter((c) => c.url.includes("/api/v1/auth/"));
  const payloads = calls
    .filter((c) => c.url.includes("/dispatches"))
    .map((c) => JSON.parse(c.body).client_payload);
  fn({ result, via, calls, checkins, authCalls, payloads });
}

// 1) 成功即止：不能重复签到
await scenario("成功即止：不重复 POST /check-in", { fetch: { checkinOld: checkinOk, refresh: refreshOk, login: loginOk, checkinNew: checkinOk } }, ({ result, checkins, authCalls, payloads }) => {
  check("worker 成功", result.ok === true);
  check("只打 1 次 check-in", checkins.length === 1, `实际 ${checkins.length}`);
  check("没碰 refresh / login", authCalls.length === 0);
  check("未降级", payloads.length === 0);
});

// 2) token 过期 → 刷新后继续签到
await scenario("token 过期 + refresh 可用 → 刷新后继续签到", { fetch: { checkinOld: tokenExpired, refresh: refreshOk, login: loginOk, checkinNew: checkinOk } }, ({ result, via, checkins, authCalls }) => {
  check("worker 直接成功（不降级）", via === "worker" && result.ok === true);
  check("文案标明「刷新 token 后签到」", /^刷新 token 后签到：/.test(result.message || ""), result.message);
  check("共 2 次 check-in（首次 + 新 token 重试）", checkins.length === 2);
  check("未走账密登录", !authCalls.some((c) => c.url.includes("/api/v1/auth/login")));
  check("新 token 回传供持久化", result.tokens?.accessToken === NEW_ACCESS && result.tokens?.refreshToken === NEW_REFRESH);
});

// 3) token 过期 + refresh 失效 → 账密重新登录后继续签到
await scenario("token 过期 + refresh 失效 + 账密可用 → 重新登录后继续签到", { fetch: { checkinOld: tokenExpired, refresh: refreshInvalid, login: loginOk, checkinNew: checkinOk } }, ({ result, via, checkins }) => {
  check("worker 直接成功（不降级）", via === "worker" && result.ok === true);
  check("文案标明「重新登录后签到」", /^重新登录后签到：/.test(result.message || ""), result.message);
  check("共 2 次 check-in", checkins.length === 2);
});

// 4) 两条回退都被 Turnstile 拦住 → 写清原因 + 直连浏览器通道
await scenario("回退都被 Turnstile 拦住（林夕 2026-09-24 形态）→ 降级浏览器通道", { fetch: { checkinOld: tokenExpired, refresh: refreshInvalid, login: loginTurnstile, checkinNew: checkinOk } }, ({ result, via, checkins, payloads }) => {
  check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
  check("结果标 needsBrowser", result.needsBrowser === true);
  check("原因写清 accessToken 过期", /accessToken 已过期/.test(result.message || ""));
  check("原因写清刷新失败", /刷新失败：invalid refresh token/.test(result.message || ""));
  check("原因写清登录失败", /账密登录失败：turnstile verification failed/.test(result.message || ""));
  check("dispatch 只发浏览器通道", JSON.stringify(payloads[0]?.runners) === '["gha_browser"]');
  check("dispatch 精确带渠道名", JSON.stringify(payloads[0]?.names) === '["林夕"]');
  check("没有重复签到", checkins.length === 1);
});

// 5) 只配账密（无 accessToken）+ 登录被 Turnstile 拦 → 同样要直连浏览器通道
await scenario("只配账密 + 登录要 Turnstile → 降级浏览器通道", { channel: makeChannel({ accessToken: "", refreshToken: "" }), fetch: { checkinOld: checkinOk, refresh: refreshInvalid, login: loginTurnstile, checkinNew: checkinOk } }, ({ result, via, payloads }) => {
  check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
  check("结果标 needsBrowser", result.needsBrowser === true);
  check("文案说明没有 accessToken", /没有 accessToken/.test(result.message || ""));
  check("dispatch 走浏览器通道", JSON.stringify(payloads[0]?.runners) === '["gha_browser"]');
});

// 6) 业务失败不得被误判成鉴权失效
for (const msg of ["账号需连续登录 3 天才能签到", "Token 额度不足，请充值；活动已失效"]) {
  await scenario(`业务失败不许误判为 token 失效：「${msg}」`, {
    fetch: { checkinOld: () => json(200, { code: 400, message: msg }), refresh: refreshOk, login: loginOk, checkinNew: checkinOk },
    env: {},
  }, ({ result, checkins, authCalls }) => {
    check("原样返回业务失败", result.ok === false && result.message.includes(msg) && !result.authFallback, result.message);
    check("只打 1 次 check-in", checkins.length === 1);
    check("没碰 refresh / login", authCalls.length === 0);
  });
}

// 7) 签到接口自己要求 Turnstile（业务层拒绝）→ 标 needsBrowser
await scenario("签到接口要求 Turnstile → 标 needsBrowser 并降级浏览器通道", { fetch: { checkinOld: () => json(200, { code: 400, message: "Turnstile token 为空" }), refresh: refreshInvalid, login: loginTurnstile, checkinNew: checkinOk } }, ({ result, via, checkins, payloads }) => {
  check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
  check("结果标 needsBrowser", result.needsBrowser === true);
  check("未被当成鉴权失效（不重复签到）", checkins.length === 1);
  check("dispatch 走浏览器通道", JSON.stringify(payloads[0]?.runners) === '["gha_browser"]');
});

// 8) 普通失败仍走 gha_api（不要一律跳浏览器）
await scenario("普通 500 仍走 gha_api", { fetch: { checkinOld: () => json(500, { message: "internal error" }), refresh: refreshInvalid, login: loginTurnstile, checkinNew: checkinOk } }, ({ via, payloads }) => {
  check("降级到 gha_api", via === "gha_api", `via=${via}`);
  check("dispatch 走纯 HTTP 通道", JSON.stringify(payloads[0]?.runners) === '["gha_api"]');
});

console.log(`\n失败断言: ${failures}`);
process.exit(failures ? 1 : 0);
