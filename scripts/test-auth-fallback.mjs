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
    // newapi 系（星见雅等）：状态查询与签到 POST 共用路径，靠 month= 区分。
    // 状态查询回「今天还没签」，签到 POST 回站点的 reCAPTCHA 拒绝 —— 2026-09-27 实测形态。
    if (u.includes("/api/user/checkin")) {
      if (u.includes("month=")) return scenario.checkinStatusNewapi();
      return scenario.checkinNewapi();
    }
    if (u.includes("/api/user/self")) {
      return json(200, { success: true, data: { id: 1829, username: "u", quota: 1000 } });
    }
    if (u.includes("/api/attendance")) return scenario.nodeseekAttend();
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

// 9) reCAPTCHA v2 站（星见雅）：纯 HTTP 通道产不出 token，必须直连浏览器通道。
//    与第 7 条的 Turnstile 形态一样是「HTTP 200 + success:false」，最容易踩的坑是
//    不标 needsBrowser → 被丢进 gha_api 再失败一次（纯 HTTP 换出口无解）。
const RC_CHANNEL = {
  id: "ch_rc",
  name: "星见雅",
  type: "newapi",
  baseUrl: "https://new.xinjianya.top",
  enabled: true,
  auth: { cookie: "session=fake", userId: "1829" },
  options: {},
};
await scenario(
  "reCAPTCHA v2 拒绝签到 → 标 needsBrowser 并降级浏览器通道",
  {
    channel: RC_CHANNEL,
    fetch: {
      checkinStatusNewapi: () =>
        json(200, { success: true, data: { enabled: true, stats: { checked_in_today: false } } }),
      checkinNewapi: () => json(200, { success: false, message: "recaptcha verification failed" }),
    },
  },
  ({ result, via, payloads }) => {
    check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
    check("结果标 needsBrowser", result.needsBrowser === true);
    check("文案点名 reCAPTCHA", /reCAPTCHA/.test(result.message || ""), result.message);
    check("dispatch 走浏览器通道", JSON.stringify(payloads[0]?.runners) === '["gha_browser"]');
  }
);

// 9a-2) 星见雅 2026-10-15 起：签到同时要 Turnstile + hCaptcha，服务端要求两个 token
//       都非空。缺任一的回话是「人机验证 token 为空」—— 这句**不含 turnstile 字样**，
//       turnstileRejected 匹配不到，会被当成普通业务失败丢给 gha_api 白跑一趟。
const XJY_MULTI_CHANNEL = {
  id: "ch_xjy_multi",
  name: "星见雅(多验证)",
  type: "newapi",
  baseUrl: "https://new.xinjianya.top",
  enabled: true,
  auth: { cookie: "session=fake", userId: "1829", token: "FAKE_TOKEN_FOR_TEST" },
  options: {},
};
await scenario(
  "人机验证 token 为空（星见雅两家同时）→ 标 needsBrowser 并降级浏览器通道",
  {
    channel: XJY_MULTI_CHANNEL,
    fetch: {
      checkinStatusNewapi: () =>
        json(200, { success: true, data: { enabled: true, stats: { checked_in_today: false } } }),
      checkinNewapi: () => json(200, { success: false, message: "人机验证 token 为空" }),
    },
  },
  ({ result, via, payloads }) => {
    check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
    check("结果标 needsBrowser", result.needsBrowser === true);
    check(
      "文案说明是多家同时的人机验证",
      /多家同时/.test(result.message || ""),
      result.message
    );
    check(
      "文案点名 Turnstile + hCaptcha",
      /Turnstile/.test(result.message || "") && /hCaptcha/.test(result.message || ""),
      result.message
    );
    check("dispatch 走浏览器通道", JSON.stringify(payloads[0]?.runners) === '["gha_browser"]');
  }
);

// 9a-3) 两家都带但被拒：回话点名 Turnstile 校验失败，同样直连浏览器通道
await scenario(
  "Turnstile 校验失败（两家都带）→ 标 needsBrowser",
  {
    channel: XJY_MULTI_CHANNEL,
    fetch: {
      checkinStatusNewapi: () =>
        json(200, { success: true, data: { enabled: true, stats: { checked_in_today: false } } }),
      checkinNewapi: () => json(200, { success: false, message: "Turnstile 校验失败，请刷新重试！" }),
    },
  },
  ({ result, via }) => {
    check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
    check("结果标 needsBrowser", result.needsBrowser === true);
  }
);


// 9b) 站点自建图片验证码（jianzhile.vip）：同样是「HTTP 200 + success:false」，
//     但解法既不是自挂 Turnstile 组件、也不是点 reCAPTCHA 勾选框 —— 只能取图 OCR
//     再带 captcha_id 提交。最容易踩的坑有两个：
//       ① 不标 needsBrowser → 被丢进 gha_api 再失败一次（纯 HTTP 换出口无解）；
//       ② 把「请打开网站后再签到」当成访问令牌过期 → 引导用户去重新生成令牌，
//          而真正缺的是 session cookie（该接口只认会话，不认令牌）。
const CAPTCHA_CHANNEL = {
  id: "ch_captcha",
  name: "简直了",
  type: "newapi",
  baseUrl: "https://jianzhile.vip",
  enabled: true,
  // 占位凭据：这里只需要"有值"以复现带令牌请求的形态，别把真令牌写进仓库
  auth: { userId: "25341", token: "FAKE_ACCESS_TOKEN_FOR_TEST" },
  options: {},
};
await scenario(
  "图片验证码站拒绝签到 → 标 needsBrowser 并降级浏览器通道",
  {
    channel: CAPTCHA_CHANNEL,
    fetch: {
      checkinStatusNewapi: () =>
        json(200, {
          success: true,
          data: {
            enabled: true,
            captcha_enabled: true,
            min_quota: 5000000,
            max_quota: 5000000,
            stats: { checked_in_today: false, checkin_count: 3, records: [] },
          },
        }),
      // 2026-10-15 实测：带访问令牌调签到接口就是这个回话
      checkinNewapi: () => json(200, { success: false, message: "请打开网站后再签到" }),
    },
  },
  ({ result, via, payloads }) => {
    check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
    check("结果标 needsBrowser", result.needsBrowser === true);
    check("文案点名图片验证码", /图片验证码/.test(result.message || ""), result.message);
    check(
      "文案说明需要 session cookie（别把人引去重配访问令牌）",
      /session/.test(result.message || ""),
      result.message
    );
    check("dispatch 走浏览器通道", JSON.stringify(payloads[0]?.runners) === '["gha_browser"]');
  }
);

// 9c) 答错验证码的回话同样是「HTTP 200 + success:false」，也必须走浏览器通道
await scenario(
  "验证码答错 → 同样标 needsBrowser",
  {
    channel: CAPTCHA_CHANNEL,
    fetch: {
      checkinStatusNewapi: () =>
        json(200, { success: true, data: { enabled: true, captcha_enabled: true, stats: { checked_in_today: false } } }),
      checkinNewapi: () => json(200, { success: false, message: "验证码错误，请重试" }),
    },
  },
  ({ result, via }) => {
    check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
    check("结果标 needsBrowser", result.needsBrowser === true);
  }
);

// 9d) 状态查询说今天已签 → 必须直接成功返回，不再 POST（该站签到 POST 会消耗验证码，
//     而且「今日已签到」在答对时也会出现，重复 POST 只会把预算烧在 OCR 上）
await scenario(
  "图片验证码站今日已签 → 状态查询即结论，不发起 POST",
  {
    channel: CAPTCHA_CHANNEL,
    fetch: {
      checkinStatusNewapi: () =>
        json(200, {
          success: true,
          data: {
            enabled: true,
            captcha_enabled: true,
            stats: {
              checked_in_today: true,
              checkin_count: 4,
              records: [{ checkin_date: "2026-10-15", quota_awarded: 5000000 }],
            },
          },
        }),
      checkinNewapi: () => {
        throw new Error("不该发起签到 POST");
      },
    },
  },
  ({ result, via, calls }) => {
    check("worker 直接成功", result.ok === true && via === "worker", `via=${via}`);
    check("未发起签到 POST", !calls.some((c) => c.url.includes("/api/user/checkin") && !c.url.includes("month=")));
    check("文案带上今日奖励", /\$10/.test(result.message || ""), result.message);
  }
);


// 10) cookie 栏有值但不含 session（多租户面板的 server_name_session 之类）+ 配了账密
//     → ensureSession 必须用账密换一个，而不是直接信任那个无效 cookie。
//     线上踩过：星见雅的 cookie 看着有值，实则 /api/user/self 直接 401。
const RC_CRED_CH = {
  id: "ch_rc_cred",
  name: "星见雅(账密)",
  type: "newapi",
  baseUrl: "https://new.xinjianya.top",
  enabled: true,
  auth: {
    cookie: "server_name_session=58154d6bd6b2030bcec1e50cfe3a9a77",
    token: "faketoken",
    userId: "1829",
    username: "PaperCupsRay",
    password: "correct-horse",
  },
  options: { recaptchaSiteKey: "1" },
};
await scenario(
  "cookie 不含 session + 有账密 → 登录换 session",
  {
    channel: RC_CRED_CH,
    fetch: {
      login: () => json(200, { success: true, message: "", data: { id: 1829, username: "PaperCupsRay" } }),
      self: () => json(200, { success: true, data: { id: 1829, username: "PaperCupsRay", quota: 1000 } }),
      // 状态查询必须回「今天还没签」：若回已签，适配器在 POST 之前就判定成功、
      // 根本不会发起签到请求，也就不会出现 recaptcha 拒绝 —— 那样测的就不是
      // 「换了 session 之后仍然需要浏览器通道」这件事了。
      checkinStatusNewapi: () => json(200, { success: true, data: { enabled: true, stats: { checked_in_today: false, checkin_count: 26, records: [] } } }),
      checkinNewapi: () => json(200, { success: false, message: "recaptcha verification failed" }),
    },
  },
  ({ result, via, calls }) => {
    check("打过了 /api/user/login", calls.some((c) => c.url.includes("/api/user/login")), JSON.stringify(calls.map((c) => c.url)));
    check("仍标 needsBrowser 走浏览器通道", result.needsBrowser === true && via === "gha_browser", `via=${via}`);
  }
);

// 11) 社区站（NodeSeek / linux.sb）被 Cloudflare 挑战拦住：Worker 出口与 Azure 出口
//     实测都过不去（2026-10-13：前者 302/403，后者 403 Just a moment），而 cf_clearance
//     与出口 IP 绑定、拷过来就失效。所以这类失败必须标 needsBrowser 直连浏览器通道，
//     而不是丢进 gha_api 再失败一次。
const NS_CHANNEL = {
  id: "ch_ns",
  name: "NodeSeek",
  type: "nodeseek",
  baseUrl: "https://www.nodeseek.com",
  enabled: true,
  auth: { cookie: "session=abc123", username: "PaperCups" },
  options: {},
};
await scenario(
  "NodeSeek 被 Cloudflare 挑战拦住 → 标 needsBrowser 并降级浏览器通道",
  {
    channel: NS_CHANNEL,
    fetch: {
      nodeseekAttend: () =>
        new Response("<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>", {
          status: 403,
          headers: { "Content-Type": "text/html" },
        }),
    },
  },
  ({ result, via, payloads }) => {
    check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
    check("结果标 needsBrowser", result.needsBrowser === true);
    check("文案点名 Cloudflare", /Cloudflare/.test(result.message || ""), result.message);
    check("dispatch 走浏览器通道", JSON.stringify(payloads[0]?.runners) === '["gha_browser"]');
    check("dispatch 精确带渠道名", JSON.stringify(payloads[0]?.names) === '["NodeSeek"]');
  }
);

// 12) NodeSeek 填了账密、没有 Cookie：worker 这一枪注定过不去 CF，必须直接进浏览器通道
//     （那里会用账密登录换 Cookie）。文案若命中 PERMANENT_FAIL_RE 就永远不会降级 ——
//     这正是「填了账密也签不上」的坑，所以这里专门钉住路由结果。
const NS_CRED_CHANNEL = {
  id: "ch_ns_cred",
  name: "NodeSeek",
  type: "nodeseek",
  baseUrl: "https://www.nodeseek.com",
  enabled: true,
  auth: { username: "蓝色的雨", password: "secret" },
  options: {},
};
await scenario(
  "NodeSeek 只填账密（无 Cookie）→ 降级浏览器通道登录换 Cookie",
  { channel: NS_CRED_CHANNEL, fetch: {} },
  ({ result, via, calls, payloads }) => {
    check("降级到 gha_browser", via === "gha_browser", `via=${via}`);
    check("结果标 needsBrowser", result.needsBrowser === true);
    check("没向站点发请求（没有 Cookie 可带）", calls.every((c) => !c.url.includes("nodeseek")), JSON.stringify(calls.map((c) => c.url)));
    check("dispatch 走浏览器通道", JSON.stringify(payloads[0]?.runners) === '["gha_browser"]');
    check("dispatch 精确带渠道名", JSON.stringify(payloads[0]?.names) === '["NodeSeek"]');
  }
);

console.log(`\n失败断言: ${failures}`);
process.exit(failures ? 1 : 0);
