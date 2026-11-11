/**
 * New API 新版（v1.3.x）鉴权链的离线回归（mock fetch，不联网）。
 *
 * 跑法：npm test（或 node scripts/test-newapi-modern.mjs）
 *
 * 背景（freeapi.tingfengai.art 的 HAR 实测）：
 *   - 站点不再用长期 Cookie 鉴权，改成 15 分钟寿命的 access token：
 *       POST /api/user/auth/refresh（空 body）→ { data: { access_token,
 *       access_expires_at, session: { sid }, user } }
 *     之后 /api/user/self、/api/user/checkin 全部走 Authorization: Bearer。
 *   - 续期请求本身**不带** Authorization（浏览器那一版也不带）。
 *   - 直接导入 HAR 拿不到登录态：HAR 里这几个请求既没有 Cookie 也没有
 *     Authorization，令牌在 JS 内存里。所以渠道必须显式存令牌或会话 ID。
 *
 * 这些用例钉住三件事：
 *   1. 新版渠道会先续期，并用新令牌打后续接口（而不是拿表单里的旧令牌撞 401）；
 *   2. 旧版 Cookie + New-Api-User 渠道不会被新逻辑影响（不能多发一次续期请求）；
 *   3. 续期拿到的令牌/过期时间/会话 ID 会回传，供面板写回 KV。
 */

const { newapiAdapter } = await import(new URL("../src/adapters/newapi.js", import.meta.url));

const BASE = "https://freeapi.example.test";
const OLD_TOKEN = "OLD_EXPIRED_TOKEN";
const NEW_TOKEN = "NEW_ROTATED_TOKEN";
const NEW_EXPIRES = Math.floor(Date.now() / 1000) + 900;
const SID = "8072959d-c0bf-4a16-90c9-ce613326cf92";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** 装一次 fetch，记录每次请求的 url / method / 关心的头 */
function installFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const headers = init.headers || {};
    const entry = {
      url: u,
      path: new URL(u).pathname,
      method: init.method || "GET",
      authorization: headers.Authorization || "",
      cookie: headers.Cookie || "",
      newApiUser: headers["New-Api-User"] || "",
      authSession: headers["X-Auth-Session"] || "",
      body: init.body,
    };
    calls.push(entry);
    for (const [match, handler] of handlers) {
      if (entry.path.includes(match)) return handler(entry);
    }
    return json(404, { success: false, message: `unexpected url ${u}` });
  };
  return calls;
}

let failures = 0;
const check = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${extra ? ` — ${extra}` : ""}`);
};

const refreshOk = () =>
  json(200, {
    success: true,
    message: "",
    data: {
      access_token: NEW_TOKEN,
      token_type: "Bearer",
      access_expires_at: NEW_EXPIRES,
      session: { sid: SID, current: true, login_method: "oauth:nodeloc" },
      user: { id: 1857, username: "PaperCups", role: 1, quota: 49116, used_quota: 1001 },
    },
  });
const selfOk = () => json(200, { success: true, message: "", data: { id: 1857, username: "PaperCups", quota: 49116 } });
const statusOk = () =>
  json(200, {
    success: true,
    data: {
      enabled: true,
      min_quota: 500000,
      max_quota: 500000,
      stats: { checked_in_today: false, checkin_count: 3, total_checkins: 3, total_quota: 1500000, records: [] },
    },
  });

/* ------------------------------------------------------------------ */
console.log("\n=== 新版渠道：令牌过期 → 空 body 续期（带 X-Auth-Session）→ 用新令牌查用户 ===");
{
  const calls = installFetch([
    ["/api/user/auth/refresh", refreshOk],
    ["/api/user/self", selfOk],
    ["/api/user/checkin", statusOk],
  ]);
  const channel = {
    id: "ch_modern",
    name: "听风API",
    type: "newapi",
    baseUrl: BASE,
    enabled: true,
    auth: {
      accessToken: OLD_TOKEN,
      accessExpiresAt: Math.floor(Date.now() / 1000) - 10, // 已过期
      authSession: SID,
      userId: "1857",
    },
    options: {},
  };
  const res = await newapiAdapter.me(channel);
  const refresh = calls.find((c) => c.path === "/api/user/auth/refresh");
  const self = calls.find((c) => c.path === "/api/user/self");

  check("续期请求发出去了", !!refresh);
  check("续期用 POST", refresh?.method === "POST", refresh?.method);
  check("续期不带旧 Authorization", refresh?.authorization === "", refresh?.authorization);
  check("续期带 X-Auth-Session", refresh?.authSession === SID, refresh?.authSession);
  check("续期不带 JSON body", refresh?.body == null, String(refresh?.body));
  check("self 用新令牌", self?.authorization === `Bearer ${NEW_TOKEN}`, self?.authorization);
  check("me 成功", res.ok === true, res.message);
  check("回传新令牌供写回", res.tokens?.accessToken === NEW_TOKEN, JSON.stringify(res.tokens));
  check("回传过期时间", Number(res.tokens?.accessExpiresAt) === NEW_EXPIRES, String(res.tokens?.accessExpiresAt));
  check("回传会话 ID", res.tokens?.authSession === SID, res.tokens?.authSession);
  check("userId 仍是数字 ID", String(res.tokens?.userId) === "1857", String(res.tokens?.userId));
}

/* ------------------------------------------------------------------ */
console.log("\n=== 新版渠道：令牌尚有效 → 不续期，直接用 ===");
{
  const calls = installFetch([
    ["/api/user/auth/refresh", refreshOk],
    ["/api/user/self", selfOk],
    ["/api/user/checkin", statusOk],
  ]);
  const channel = {
    id: "ch_modern_fresh",
    name: "听风API",
    type: "newapi",
    baseUrl: BASE,
    enabled: true,
    auth: { accessToken: NEW_TOKEN, accessExpiresAt: NEW_EXPIRES, authSession: SID },
    options: {},
  };
  const res = await newapiAdapter.status(channel);
  const refresh = calls.find((c) => c.path === "/api/user/auth/refresh");
  const status = calls.find((c) => c.path === "/api/user/checkin");

  check("没发续期请求", !refresh, refresh ? "多发了一次" : "");
  check("状态查询带 Bearer", status?.authorization === `Bearer ${NEW_TOKEN}`, status?.authorization);
  check("状态查询成功", res.ok === true, res.message);
  check("解析出今日未签到", res.status?.checkedInToday === false);
  check("本月次数解析正确", res.status?.checkinCount === 3, String(res.status?.checkinCount));
}

/* ------------------------------------------------------------------ */
console.log("\n=== 旧版渠道（Cookie + New-Api-User）：不得触发续期，也不得带 Bearer ===");
{
  const calls = installFetch([
    ["/api/user/auth/refresh", refreshOk],
    ["/api/user/self", selfOk],
    ["/api/user/checkin", statusOk],
  ]);
  const channel = {
    id: "ch_legacy",
    name: "星见雅",
    type: "newapi",
    baseUrl: BASE,
    enabled: true,
    auth: { cookie: "session=abc123", userId: "1829" },
    options: {},
  };
  const res = await newapiAdapter.me(channel);
  const refresh = calls.find((c) => c.path === "/api/user/auth/refresh");
  const self = calls.find((c) => c.path === "/api/user/self");

  check("没发续期请求", !refresh, refresh ? "旧渠道被误判成新版" : "");
  check("带 Cookie", self?.cookie === "session=abc123", self?.cookie);
  check("带 New-Api-User", self?.newApiUser === "1829", self?.newApiUser);
  check("不带 Authorization", self?.authorization === "", self?.authorization);
  check("me 成功", res.ok === true, res.message);
}

/* ------------------------------------------------------------------ */
console.log("\n=== 新版渠道：续期被拒时把服务端原因带给面板（不要误报成「需要账密」）===");
{
  installFetch([
    [
      "/api/user/auth/refresh",
      () => json(401, { success: false, message: "未提供 access token" }),
    ],
  ]);
  const channel = {
    id: "ch_modern_dead",
    name: "听风API",
    type: "newapi",
    baseUrl: BASE,
    enabled: true,
    auth: { accessToken: OLD_TOKEN, accessExpiresAt: Math.floor(Date.now() / 1000) - 10 },
    options: {},
  };
  const res = await newapiAdapter.checkin(channel);
  check("失败", res.ok === false);
  check("带服务端原因", /access token|刷新会话/i.test(res.message || ""), res.message);
  check("没让用户去配账密", !/需要用户名\+密码/.test(res.message || ""), res.message);
}

console.log(`\n失败断言: ${failures}`);
process.exit(failures ? 1 : 0);
