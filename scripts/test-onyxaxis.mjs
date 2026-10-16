/**
 * Obsidian Arc（Axis AI / ai.onyxaxis.org）适配器的离线回归测试（mock fetch，不联网）。
 *
 * 跑法：node scripts/test-onyxaxis.mjs（由 npm test 串联）
 *
 * 用例来自两处**实证**，不是猜的：
 *   ① 用户 2026-10-16 的 HAR（GET/POST /api/checkin 的真实请求头与响应体）；
 *   ② 站点开源实现 github.com/OnyxAxisOwO/ObsidianArc 的
 *      internal/checkin/{http,actions}.go、internal/auth/{http,session}.go、
 *      internal/httpx/middleware.go（SameOrigin）、internal/config/config.go（Cookie 名）。
 *
 * 关键契约（退化就会静默出错，所以钉住）：
 *   1. POST /api/checkin 必须带 Origin（服务端 SameOrigin 中间件），body 就是 {}；
 *   2. 重复签到是 **409 already_checked_in**，算成功不算失败；
 *   3. 积分（reward.kind=bonus）是积分不是美元，只能进 rewardPoints；
 *   4. 会话 Cookie 名默认 obsidian_session，登录后要能写回渠道（tokens.cookie）；
 *   5. 二次验证 / 登录人机验证这两类失败要命中 PERMANENT_FAIL_RE（不降级白烧 GHA）；
 *      而 Cloudflare 拦截要**避开**它（换出口有可能过，必须还能降级）。
 */

import { onyxaxisAdapter } from "../src/adapters/onyxaxis.js";

let failures = 0;
let checks = 0;

function ok(cond, label, extra = "") {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function html(status, body, headers = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=UTF-8", ...headers } });
}

/** 装一个按 (method, path) 分派的假 fetch，并记录请求供断言 */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url, u, method, headers: init.headers || {}, body: init.body });
    const key = `${method} ${u.pathname}`;
    const handler = routes[key] || routes[`${u.pathname}`] || routes["*"];
    if (!handler) throw new Error(`未 mock 的路由: ${key}`);
    return typeof handler === "function" ? handler({ u, call: calls[calls.length - 1] }) : handler;
  };
  return calls;
}

const restoreFetch = globalThis.fetch;

const BASE = "https://ai.onyxaxis.org";
const ch = (auth = {}, options = {}) => ({
  id: "ch_onyx",
  name: "Axis AI",
  type: "onyxaxis",
  baseUrl: BASE,
  auth,
  options,
});

/** 站点错误信封：{ error: { code, message, code_detail? } } */
const err = (code, message, extra = {}) => ({ error: { code, message, ...extra } });

/** src/index.js 的 PERMANENT_FAIL_RE（命中 = 不降级，直接报失败） */
const PERMANENT_FAIL_RE = /缺少|需要|未配置|不存在|404|无可用|未知渠道|不支持/;

const SESSION_COOKIE = "obsidian_session=stored-session-token";

/** HAR 里的 GET /api/checkin 真实响应体 */
const STATUS_BODY = {
  enabled: true,
  today: "2026-10-16",
  checked_in_today: true,
  streak: 1,
  month_days: [16],
  month_count: 1,
  daily: { kind: "" },
  rules: [
    {
      id: "mmuo756571",
      title: "签到重置卡",
      basis: "streak",
      days: 5,
      reward: { kind: "card", valid_days: 3, name: "签到重置卡", windows: ["5h"], cards: 1 },
      progress: 1,
      claimable: false,
      claimed: false,
    },
  ],
};

/** HAR 里的 POST /api/checkin 真实响应体（201 Created） */
const CHECKIN_BODY = { day: "2026-10-16", streak: 1, reward: { kind: "" }, reward_failed: false };

try {
  console.log("\n[1] 签到成功：HAR 真实响应体（201 + reward.kind 为空）");
  {
    const calls = mockFetch({ "POST /api/checkin": () => json(201, CHECKIN_BODY) });
    const r = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true", r.message);
    ok(calls.length === 1, "只发一次请求（Cookie 直接可用，不白登录）", `calls=${calls.length}`);
    const c = calls[0];
    ok(c.u.pathname === "/api/checkin", "打的是 /api/checkin", c.u.pathname);
    ok(c.method === "POST", "POST", c.method);
    ok(c.body === "{}", "body 就是 {}（HAR content-length: 2）", String(c.body));
    ok(c.headers["Content-Type"] === "application/json", "JSON 编码", c.headers["Content-Type"]);
    // SameOrigin 中间件：POST 必须带同源 Origin，否则回 403
    ok(c.headers.Origin === BASE, "带同源 Origin（服务端 SameOrigin 中间件要求）", c.headers.Origin);
    ok(c.headers.Referer === `${BASE}/`, "带 Referer", c.headers.Referer);
    ok(c.headers["Sec-Fetch-Site"] === "same-origin", "Sec-Fetch-Site: same-origin（照 HAR）", c.headers["Sec-Fetch-Site"]);
    ok(c.headers.Cookie === SESSION_COOKIE, "带上会话 Cookie", c.headers.Cookie);
    ok(r.result?.checkInDate === "2026-10-16", "签到日期透传", JSON.stringify(r.result));
    ok(r.result?.currentStreak === 1, "连续天数透传", JSON.stringify(r.result));
    ok(r.result?.alreadyCheckedIn === false, "不是 alreadyCheckedIn");
    ok(r.result?.reward === null, "reward 留空（kind 为空 = 当日无奖励）", JSON.stringify(r.result?.reward));
    ok(r.result?.rewardPoints === null, "无奖励时 rewardPoints 也是 null");
    ok(/2026-10-16/.test(r.message) && /连续 1 天/.test(r.message), "message 带日期与连续天数", r.message);
    ok(r.tokens?.cookie === SESSION_COOKIE, "回写 tokens.cookie 供持久化");
  }

  console.log("\n[2] 签到成功 + 积分奖励：积分进 rewardPoints，不进 reward");
  {
    mockFetch({
      "POST /api/checkin": () =>
        json(201, { day: "2026-10-16", streak: 3, reward: { kind: "bonus", bar_id: "b1", amount: 100, valid_days: 7 }, reward_failed: false }),
    });
    const r = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true", r.message);
    ok(r.result?.rewardPoints === 100, "积分透传 rewardPoints", JSON.stringify(r.result));
    // 面板会把 reward 按 quota_per_unit 当美元显示：积分塞进去会变成 $0.00
    ok(r.result?.reward === null, "reward 保持 null（否则面板按美元显示）");
    ok(/100 积分/.test(r.message) && /7 天内有效/.test(r.message), "message 说明奖励与有效期", r.message);
    ok(/连续 3 天/.test(r.message), "message 带连续天数", r.message);
  }

  console.log("\n[3] 重复签到是 409 already_checked_in：算成功不算失败");
  {
    const calls = mockFetch({
      "POST /api/checkin": () => json(409, err("already_checked_in", "You have already checked in today.")),
    });
    const r = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true（正常状态不能报成错误）", r.message);
    ok(r.result?.alreadyCheckedIn === true, "alreadyCheckedIn=true");
    ok(r.status?.checkedInToday === true, "status.checkedInToday=true");
    ok(!/失败|error/i.test(r.message), "文案不说成失败", r.message);
    ok(calls.length === 1, "不重试（重复签到重试没有意义）", `calls=${calls.length}`);
  }

  console.log("\n[4] 站点把签到关掉 / 邮箱未验证：如实转达，不谎报成功");
  {
    mockFetch({ "POST /api/checkin": () => json(403, err("checkin_disabled", "Check-in is not switched on.")) });
    const off = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }));
    ok(off.ok === false, "checkin_disabled → ok=false");
    ok(/签到关掉/.test(off.message), "点明是运营方关掉了签到", off.message);

    mockFetch({
      "POST /api/checkin": () => json(403, err("email_unverified", "Confirm your email address before checking in.")),
    });
    const unverified = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }));
    ok(unverified.ok === false, "email_unverified → ok=false");
    ok(/验证邮箱/.test(unverified.message), "点明要先验证邮箱", unverified.message);
  }

  console.log("\n[5] 无凭证：不发请求，且文案命中永久失败判据（不降级白烧 GHA）");
  {
    const calls = mockFetch({ "*": () => json(200, {}) });
    const r = await onyxaxisAdapter.checkin(ch());
    ok(r.ok === false, "ok=false");
    ok(calls.length === 0, "没发请求", `calls=${calls.length}`);
    ok(/obsidian_session/.test(r.message), "告诉用户该抄哪个 Cookie", r.message);
    ok(/用户名 \/ 邮箱 \+ 密码/.test(r.message), "告诉用户也可以填账密", r.message);
    ok(
      PERMANENT_FAIL_RE.test(r.message),
      "文案命中 PERMANENT_FAIL_RE（没有凭证时降级毫无意义）",
      r.message
    );
  }

  console.log("\n[6] 只有账密：先 POST /api/auth/login 换 Cookie，再签到，并把新 Cookie 写回");
  {
    const calls = mockFetch({
      "POST /api/auth/login": () =>
        json(200, { user: { id: "u1", username: "someone", nickname: "某人", email: "a@b.c", role: "user" } }, {
          "Set-Cookie": "obsidian_session=fresh-token; Path=/; HttpOnly; SameSite=Lax",
        }),
      "POST /api/checkin": () => json(201, CHECKIN_BODY),
    });
    const r = await onyxaxisAdapter.checkin(ch({ identifier: "a@b.c", password: "secret" }));
    ok(r.ok === true, "ok=true", r.message);
    ok(calls.length === 2, "两次请求：登录 + 签到", `calls=${calls.length}`);
    ok(calls[0].u.pathname === "/api/auth/login" && calls[0].method === "POST", "先登录", `${calls[0].method} ${calls[0].u.pathname}`);
    ok(
      calls[0].body === JSON.stringify({ identifier: "a@b.c", password: "secret" }),
      "登录体是 { identifier, password }（源码 loginRequest 的字段名）",
      calls[0].body
    );
    ok(calls[1].u.pathname === "/api/checkin", "再签到", calls[1].u.pathname);
    ok(calls[1].headers.Cookie === "obsidian_session=fresh-token", "签到用的是登录换来的新 Cookie", calls[1].headers.Cookie);
    ok(r.tokens?.cookie === "obsidian_session=fresh-token", "新 Cookie 回写 tokens（填一次账密就不用再手抄）", r.tokens?.cookie);
    ok(/登录后签到/.test(r.message), "日志写明是「登录后签到」", r.message);
  }

  console.log("\n[7] Cookie 失效但有账密：自动重登一次并重试签到");
  {
    let loginCount = 0;
    const calls = mockFetch({
      "POST /api/checkin": ({ call }) => {
        if (call.headers.Cookie === "obsidian_session=stale") {
          return json(401, err("session_required", "Sign in to continue."));
        }
        return json(201, CHECKIN_BODY);
      },
      "POST /api/auth/login": () => {
        loginCount += 1;
        return json(200, { user: { id: "u1", username: "someone" } }, {
          "Set-Cookie": "obsidian_session=renewed; Path=/; HttpOnly",
        });
      },
    });
    const r = await onyxaxisAdapter.checkin(ch({ cookie: "obsidian_session=stale", identifier: "a@b.c", password: "secret" }));
    ok(r.ok === true, "重登后签到成功", r.message);
    ok(loginCount === 1, "只重登一次", `loginCount=${loginCount}`);
    ok(calls.length === 3, "请求序列：签到(旧) → 登录 → 签到(新)", `calls=${calls.length}`);
    ok(calls[2].headers.Cookie === "obsidian_session=renewed", "重试用的是新 Cookie", calls[2].headers.Cookie);
    ok(r.tokens?.cookie === "obsidian_session=renewed", "新 Cookie 回写 tokens", r.tokens?.cookie);
    ok(/重新登录后签到/.test(r.message), "日志写明是「重新登录后签到」", r.message);
  }

  console.log("\n[8] Cookie 失效且没有账密：如实说明，不假装成功");
  {
    mockFetch({ "POST /api/checkin": () => json(401, err("session_required", "Sign in to continue.")) });
    const r = await onyxaxisAdapter.checkin(ch({ cookie: "obsidian_session=stale" }));
    ok(r.ok === false, "ok=false");
    ok(/Sign in to continue/.test(r.message), "透传站点原文", r.message);
    ok(!/重新登录/.test(r.message) || /失败/.test(r.message), "没有账密时不谎称会重登");
  }

  console.log("\n[9] 账号开了二次验证：文案命中永久失败判据（换出口也解不了）");
  {
    mockFetch({ "POST /api/auth/login": () => json(200, { two_factor: true }, { "Set-Cookie": "obsidian_session=pending; Path=/" }) });
    const r = await onyxaxisAdapter.checkin(ch({ identifier: "a@b.c", password: "secret" }));
    ok(r.ok === false, "ok=false");
    ok(/二次验证/.test(r.message), "点明是二次验证", r.message);
    ok(/obsidian_session/.test(r.message), "给出可行的出路（改用 Cookie）", r.message);
    ok(PERMANENT_FAIL_RE.test(r.message), "命中 PERMANENT_FAIL_RE（不降级）", r.message);
  }

  console.log("\n[10] 登录接口挂了人机验证：文案命中永久失败判据");
  {
    mockFetch({
      "POST /api/auth/login": () => json(403, err("challenge_failed", "The verification could not be completed. Try again.")),
    });
    const r = await onyxaxisAdapter.checkin(ch({ identifier: "a@b.c", password: "secret" }));
    ok(r.ok === false, "ok=false");
    ok(/人机验证/.test(r.message), "点明是人机验证", r.message);
    ok(PERMANENT_FAIL_RE.test(r.message), "命中 PERMANENT_FAIL_RE（静态 token 换出口也没用）", r.message);
  }

  console.log("\n[11] 登录被限流：透传原因 + 指出 Cookie 可以绕开登录");
  {
    mockFetch({ "POST /api/auth/login": () => json(429, err("too_many_attempts", "Too many attempts. Try again later.")) });
    const r = await onyxaxisAdapter.checkin(ch({ identifier: "a@b.c", password: "secret" }));
    ok(r.ok === false, "ok=false");
    ok(/Too many attempts/.test(r.message), "透传站点原文", r.message);
    ok(/限流/.test(r.message) && /Cookie/.test(r.message), "说明限流且 Cookie 可绕开", r.message);
  }

  console.log("\n[12] Cloudflare 挑战页：必须还能降级（文案避开永久失败判据）");
  {
    mockFetch({
      "POST /api/checkin": () => html(403, "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>"),
    });
    const r = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === false, "ok=false");
    ok(/Cloudflare/.test(r.message), "点名 Cloudflare", r.message);
    ok(/gha_api/.test(r.message), "建议改用 gha_api（Azure 出口 IP）", r.message);
    ok(
      !PERMANENT_FAIL_RE.test(r.message),
      "文案避开 PERMANENT_FAIL_RE（否则永远不会降级）",
      r.message
    );
    ok(r.needsBrowser !== true, "不标 needsBrowser（gha_browser 没有本适配器的浏览器流程）");
  }

  console.log("\n[13] status()：解析 HAR 真实状态体");
  {
    const calls = mockFetch({ "GET /api/checkin": () => json(200, STATUS_BODY) });
    const r = await onyxaxisAdapter.status(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true", r.message);
    ok(calls[0].method === "GET", "状态查询是只读 GET", calls[0].method);
    ok(calls[0].body == null, "GET 无请求体");
    ok(r.status?.checkedInToday === true, "checkedInToday=true");
    ok(r.status?.currentStreak === 1, "streak 透传", String(r.status?.currentStreak));
    ok(r.status?.checkinCount === 1, "month_count → checkinCount（面板渲染「本月签到 N 次」）", String(r.status?.checkinCount));
    ok(r.status?.today === "2026-10-16", "today 透传");
    ok(r.status?.dailyReward === null, "daily.kind 为空 → 不编造每日奖励");
    ok(r.status?.claimable?.length === 0, "无可领里程碑", JSON.stringify(r.status?.claimable));
    ok(r.status?.rules?.[0]?.reward === "签到重置卡 × 1，重置 5h，3 天内有效", "里程碑奖励转成人话", r.status?.rules?.[0]?.reward);
    ok(/今日已签到/.test(r.message) && /本月 1 天/.test(r.message), "message 汇总状态", r.message);
  }

  console.log("\n[14] status()：有可领里程碑时要点出来");
  {
    mockFetch({
      "GET /api/checkin": () =>
        json(200, {
          ...STATUS_BODY,
          streak: 5,
          rules: [{ ...STATUS_BODY.rules[0], progress: 5, claimable: true }],
        }),
    });
    const r = await onyxaxisAdapter.status(ch({ cookie: SESSION_COOKIE }));
    ok(r.status?.claimable?.length === 1, "claimable 列出里程碑", JSON.stringify(r.status?.claimable));
    ok(/可领里程碑：签到重置卡/.test(r.message), "message 提示可领", r.message);
  }

  console.log("\n[15] me()：GET /api/auth/me → { user }");
  {
    const calls = mockFetch({
      "GET /api/auth/me": () =>
        json(200, {
          user: { id: "u1", username: "someone", nickname: "某人", email: "a@b.c", role: "user", status: "active", email_verified: true, group_name: "默认组" },
          preferences: { theme: "dark" },
        }),
    });
    const r = await onyxaxisAdapter.me(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true", r.message);
    ok(calls[0].u.pathname === "/api/auth/me", "打的是 /api/auth/me", calls[0].u.pathname);
    ok(r.user?.username === "someone", "取到用户名");
    ok(r.user?.displayName === "某人", "nickname 优先作为显示名（源码 DisplayName）");
    ok(r.user?.group === "默认组", "取到分组");
    ok(r.user?.balance == null && r.user?.quota == null, "不编造余额（站点没有单一余额字段）");
    ok(/某人/.test(r.message), "message 带账号", r.message);
  }

  console.log("\n[16] me()：Cookie 过期 → 401 session_required");
  {
    mockFetch({ "GET /api/auth/me": () => json(401, err("session_required", "Sign in to continue.")) });
    const r = await onyxaxisAdapter.me(ch({ cookie: "obsidian_session=stale" }));
    ok(r.ok === false, "ok=false");
    ok(/Sign in to continue/.test(r.message), "透传站点原文", r.message);
  }

  console.log("\n[17] login()：有 Cookie 时只读验一次，不产生副作用");
  {
    const calls = mockFetch({ "GET /api/auth/me": () => json(200, { user: { id: "u1", username: "someone" } }) });
    const r = await onyxaxisAdapter.login(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true", r.message);
    ok(/Cookie 有效/.test(r.message), "说明 Cookie 有效", r.message);
    ok(calls.length === 1 && calls[0].method === "GET", "只有一次只读 GET", `${calls.length} 次`);
  }

  console.log("\n[18] 适配器已注册，且不谎报额外动作");
  {
    const { listAdapters, getAdapter } = await import("../src/adapters/index.js");
    const list = listAdapters();
    const found = list.find((a) => a.id === "onyxaxis");
    ok(!!found, "listAdapters() 里有 onyxaxis");
    ok(found?.name === "Obsidian Arc", "名称", found?.name);
    ok(found?.fields?.some((f) => f.key === "auth.cookie"), "表单有 Cookie 字段");
    ok(found?.fields?.some((f) => f.key === "auth.identifier"), "表单有用户名/邮箱字段");
    ok(
      found?.actions?.some((x) => x.action === "claim" && x.label === "领里程碑"),
      "上报「领里程碑」动作（面板据此渲染按钮）",
      JSON.stringify(found?.actions)
    );
    ok(found?.fields?.some((f) => f.key === "options.autoClaim"), "表单有 autoClaim 开关");
    ok(getAdapter("onyxaxis") === onyxaxisAdapter, "getAdapter('onyxaxis') 拿到同一个对象");
    for (const a of list) {
      ok(!!a.id && !!a.name && !!a.description, `适配器 ${a.id} 有 id/name/description`);
    }
  }

  console.log("\n[19] claim()：有可领里程碑 → POST /api/checkin/claims/{rule_id}");
  {
    const calls = mockFetch({
      "GET /api/checkin": () =>
        json(200, { ...STATUS_BODY, streak: 5, rules: [{ ...STATUS_BODY.rules[0], progress: 5, claimable: true }] }),
      "POST /api/checkin/claims/mmuo756571": () =>
        json(201, { reward: { kind: "card", valid_days: 3, name: "签到重置卡", windows: ["5h"], cards: 1 } }),
    });
    const r = await onyxaxisAdapter.claim(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true", r.message);
    ok(calls.length === 2, "先读状态拿 rule id，再领", `calls=${calls.length}`);
    ok(calls[0].method === "GET" && calls[0].u.pathname === "/api/checkin", "第一步是只读 GET", `${calls[0].method} ${calls[0].u.pathname}`);
    const c = calls[1];
    ok(c.method === "POST", "领取用 POST", c.method);
    ok(c.u.pathname === "/api/checkin/claims/mmuo756571", "路径带 rule id", c.u.pathname);
    ok(c.body === "{}", "body 就是 {}（照站点前端）", String(c.body));
    ok(c.headers.Origin === BASE, "带同源 Origin（SameOrigin 中间件要求）", c.headers.Origin);
    ok(c.headers.Cookie === SESSION_COOKIE, "带会话 Cookie", c.headers.Cookie);
    ok(r.result?.claimed?.length === 1, "claimed 列出已领", JSON.stringify(r.result?.claimed));
    ok(
      r.result?.claimed?.[0]?.reward === "签到重置卡 × 1，重置 5h，3 天内有效",
      "奖励转成人话",
      r.result?.claimed?.[0]?.reward
    );
    ok(/已领：签到重置卡/.test(r.message), "message 说明领到了什么", r.message);
    ok(r.tokens?.cookie === SESSION_COOKIE, "回写 tokens.cookie 供持久化");
  }

  console.log("\n[20] claim()：还没达成 → ok=true 并显示进度，不发领取请求");
  {
    // STATUS_BODY 就是线上现状：progress 1/5、claimable false
    const calls = mockFetch({ "GET /api/checkin": () => json(200, STATUS_BODY) });
    const r = await onyxaxisAdapter.claim(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true（没达成不是失败，别报红）", r.message);
    ok(calls.length === 1, "只读了一次状态，没发领取请求", `calls=${calls.length}`);
    ok(r.result?.claimed?.length === 0, "claimed 为空");
    ok(/暂无可领里程碑/.test(r.message), "说明暂无可领", r.message);
    ok(/签到重置卡 1\/5/.test(r.message), "把进度说清楚（用户才知道还差几天）", r.message);
    ok(r.result?.pending?.[0] === "签到重置卡 1/5", "pending 结构化带出进度", JSON.stringify(r.result?.pending));
  }

  console.log("\n[21] claim()：409 milestone_claimed（本期已领过）→ 算成功不算失败");
  {
    mockFetch({
      "GET /api/checkin": () =>
        json(200, { ...STATUS_BODY, streak: 5, rules: [{ ...STATUS_BODY.rules[0], progress: 5, claimable: true }] }),
      "POST /api/checkin/claims/mmuo756571": () =>
        json(409, err("milestone_claimed", "You have already claimed that milestone.")),
    });
    const r = await onyxaxisAdapter.claim(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === true, "ok=true（重复点击不该报错）", r.message);
    ok(r.result?.claimed?.[0]?.reward === "此前已领", "标明此前已领", JSON.stringify(r.result?.claimed));
    ok(!/失败/.test(r.message), "不说成失败", r.message);
  }

  console.log("\n[22] claim()：进度没到 / 奖励已失效 → 失败并说明原因");
  {
    const claimableStatus = {
      "GET /api/checkin": () =>
        json(200, { ...STATUS_BODY, streak: 5, rules: [{ ...STATUS_BODY.rules[0], progress: 5, claimable: true }] }),
    };
    mockFetch({
      ...claimableStatus,
      "POST /api/checkin/claims/mmuo756571": () =>
        json(409, err("milestone_not_reached", "You have not reached that milestone yet.")),
    });
    const notReached = await onyxaxisAdapter.claim(ch({ cookie: SESSION_COOKIE }));
    ok(notReached.ok === false, "milestone_not_reached → ok=false");
    ok(/进度还没到/.test(notReached.message), "点明进度没到", notReached.message);

    mockFetch({
      ...claimableStatus,
      "POST /api/checkin/claims/mmuo756571": () =>
        json(409, err("reward_unavailable", "This reward can no longer be paid.")),
    });
    const gone = await onyxaxisAdapter.claim(ch({ cookie: SESSION_COOKIE }));
    ok(gone.ok === false, "reward_unavailable → ok=false");
    ok(/已无法发放/.test(gone.message), "点明奖励已失效", gone.message);
  }

  console.log("\n[23] claim()：被 Cloudflare 拦 → 仍能降级（文案避开永久失败判据）");
  {
    mockFetch({
      "GET /api/checkin": () => html(403, "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>"),
    });
    const r = await onyxaxisAdapter.claim(ch({ cookie: SESSION_COOKIE }));
    ok(r.ok === false, "ok=false");
    ok(/Cloudflare/.test(r.message), "点名 Cloudflare", r.message);
    ok(!PERMANENT_FAIL_RE.test(r.message), "避开 PERMANENT_FAIL_RE（换出口还有救）", r.message);
  }

  console.log("\n[24] 签到后自动领里程碑（options.autoClaim）");
  {
    // 默认关：一次多余请求都不发
    const offCalls = mockFetch({ "POST /api/checkin": () => json(201, CHECKIN_BODY) });
    const off = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }));
    ok(off.ok === true, "默认不自动领：签到仍成功", off.message);
    ok(offCalls.length === 1, "默认只发签到那一次请求", `calls=${offCalls.length}`);
    ok(!/里程碑/.test(off.message), "message 不提里程碑", off.message);

    // 打开：签到后顺带领（连续天数刚涨上去，正是最容易忘的时刻）
    const onCalls = mockFetch({
      "POST /api/checkin": () => json(201, { ...CHECKIN_BODY, streak: 5 }),
      "GET /api/checkin": () =>
        json(200, { ...STATUS_BODY, streak: 5, rules: [{ ...STATUS_BODY.rules[0], progress: 5, claimable: true }] }),
      "POST /api/checkin/claims/mmuo756571": () =>
        json(201, { reward: { kind: "card", valid_days: 3, name: "签到重置卡", windows: ["5h"], cards: 1 } }),
    });
    const on = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }, { autoClaim: "true" }));
    ok(on.ok === true, "签到成功", on.message);
    ok(/已领：签到重置卡/.test(on.message), "message 附带领取结果", on.message);
    ok(onCalls.some((c) => c.u.pathname.startsWith("/api/checkin/claims/")), "确实发了领取请求");
    ok(on.result?.currentStreak === 5, "签到结论未被领取覆盖", JSON.stringify(on.result));
    ok(on.result?.checkInDate === "2026-10-16", "签到日期仍在", JSON.stringify(on.result));

    // 领取失败不推翻签到结论（照 linux.sb「签到后自动抽称号」的规矩）
    mockFetch({
      "POST /api/checkin": () => json(201, { ...CHECKIN_BODY, streak: 5 }),
      "GET /api/checkin": () =>
        json(200, { ...STATUS_BODY, streak: 5, rules: [{ ...STATUS_BODY.rules[0], progress: 5, claimable: true }] }),
      "POST /api/checkin/claims/mmuo756571": () =>
        json(409, err("reward_unavailable", "This reward can no longer be paid.")),
    });
    const partial = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }, { autoClaim: true }));
    ok(partial.ok === true, "领取失败不推翻签到（ok 仍为 true）", partial.message);
    ok(/领里程碑失败/.test(partial.message), "把领取失败写进 message", partial.message);
  }

  console.log("\n[25] Worker 动作白名单：claim 必须被放行（否则面板按钮直接 400）");
  {
    // src/index.js 有 `import uiHtml from "./ui.html"`（wrangler 的 Text 规则），
    // Node 加载不了 —— 照 test-auth-fallback.mjs 的做法替换掉再动态导入。
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const SRC = path.join(HERE, "..", "src");
    const cacheDir = path.join(HERE, "..", "node_modules", ".cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, `onyxaxis-claim-probe-${process.pid}.mjs`);
    const toUrl = (p) => `file:///${path.resolve(p).replace(/\\/g, "/")}`;
    let code = fs.readFileSync(path.join(SRC, "index.js"), "utf8");
    code = code.replace(/^import uiHtml from "\.\/ui\.html";$/m, 'const uiHtml = "<html></html>";');
    code = code.replace(/from "\.\/((?:adapters\/)?[\w.-]+\.js)"/g, (_m, p) => `from "${toUrl(path.join(SRC, p))}"`);
    fs.writeFileSync(target, code);
    let handleCheckin;
    try {
      ({ handleCheckin } = await import(toUrl(target)));
    } finally {
      try {
        fs.unlinkSync(target);
      } catch {
        /* 清理失败不影响结论 */
      }
    }
    const req = (action) =>
      new Request("https://hub.example.com/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, channel: { type: "onyxaxis", baseUrl: BASE, auth: {} } }),
      });
    mockFetch({ "*": () => json(200, {}) });
    const bad = await handleCheckin(req("definitely-not-an-action"), {});
    ok(bad.status === 400, "未知动作仍然 400（白名单没被放宽）", String(bad.status));
    const good = await handleCheckin(req("claim"), {});
    ok(good.status !== 400, "claim 被放行（不再 unsupported action）", String(good.status));
    const body = await good.json();
    ok(!/unsupported action/.test(String(body.error || "")), "没有 unsupported action 报错", String(body.error));
  }

  console.log("\n[26] autoClaim 在「今日已签到」路径上也要跑（cron 常拿到 409）");
  {
    // 只在「刚签上」那条路上领是不够的：定时任务常在用户已手动签过的日子拿到
    // 409 already_checked_in，那时里程碑同样该领 —— 否则会一直躺着没人领。
    const calls = mockFetch({
      "POST /api/checkin": () => json(409, err("already_checked_in", "You have already checked in today.")),
      "GET /api/checkin": () =>
        json(200, { ...STATUS_BODY, streak: 5, rules: [{ ...STATUS_BODY.rules[0], progress: 5, claimable: true }] }),
      "POST /api/checkin/claims/mmuo756571": () =>
        json(201, { reward: { kind: "card", valid_days: 3, name: "签到重置卡", windows: ["5h"], cards: 1 } }),
    });
    const r = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }, { autoClaim: true }));
    ok(r.ok === true, "已签到仍算成功", r.message);
    ok(r.result?.alreadyCheckedIn === true, "alreadyCheckedIn 仍为 true");
    ok(
      calls.some((c) => c.u.pathname.startsWith("/api/checkin/claims/")),
      "确实发了领取请求",
      JSON.stringify(calls.map((c) => c.u.pathname))
    );
    ok(/已领：签到重置卡/.test(r.message), "message 附带领取结果", r.message);

    // 关掉开关时，这条路径同样不发领取请求
    const offCalls = mockFetch({
      "POST /api/checkin": () => json(409, err("already_checked_in", "You have already checked in today.")),
    });
    const off = await onyxaxisAdapter.checkin(ch({ cookie: SESSION_COOKIE }));
    ok(off.ok === true, "默认不自动领：已签到仍成功", off.message);
    ok(offCalls.length === 1, "默认只发签到那一次请求", `calls=${offCalls.length}`);
    ok(!/里程碑/.test(off.message), "message 不提里程碑", off.message);
  }
} finally {
  globalThis.fetch = restoreFetch;
}

console.log(`\n${failures ? "❌" : "✅"} ${checks - failures}/${checks} 通过`);
process.exit(failures ? 1 : 0);
