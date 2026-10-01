/**
 * 社区站适配器（nodeseek / linuxsb / nodeloc）的离线回归测试（mock fetch，不联网）。
 *
 * 跑法：npm run test:forum（或由 npm test 串联）
 *
 * 用例全部来自 2026-09-30 的实测与用户 HAR 里抓到的真实响应，别让它们退化：
 *
 * NodeSeek（HAR：POST /api/attendance?random=true，Accept 头是通配，无请求体）
 *   1. 成功体 {"success":true,"message":"今天的签到收益是6个鸡腿","gain":6,"current":599}；
 *   2. 「high risk action」是**通用风控回话**，不能当成「接口不存在」；
 *   3. 排行榜 /api/attendance/board 能当只读状态源（需填用户名）。
 *
 * linux.sb（HAR：签到无接口，打开页面自动签；抽称号是 HTML 表单）
 *   4. 签到 = GET / 读 window.__pageFlash：有「已帮您完成自动签到」= 刚签上，
 *      空串 = 今日已签过（HAR 里两次 GET / 都是空串）；
 *   5. 抽称号 = POST /gacha_pull（form，_csrf）→ 302 → 解析 gacha-result-card；
 *   6. 结果页解析要吃真实 HTML（下面 RESULT_HTML 就是 HAR 那页的片段）。
 *
 * NodeLoc（HAR：POST /checkin，**form-urlencoded** + X-Checkin-Nonce）
 *   7. body 必须是 nonce=…&timestamp=… 表单，不是 JSON；
 *   8. 头里的 nonce 必须与 body.nonce 一致；
 *   9. 成功体含 points / user_date / timezone，积分不是钱不能进 reward。
 */

import { nodeseekAdapter } from "../src/adapters/nodeseek.js";
import { linuxsbAdapter } from "../src/adapters/linuxsb.js";
import { nodelocAdapter } from "../src/adapters/nodeloc.js";

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

const nsChannel = (auth = {}) => ({
  id: "ch_ns",
  name: "NodeSeek",
  type: "nodeseek",
  baseUrl: "https://www.nodeseek.com",
  auth: { cookie: "session=abc123", ...auth },
  options: {},
});
const sbChannel = (options = {}, auth = {}) => ({
  id: "ch_sb",
  name: "linux.sb",
  type: "linuxsb",
  baseUrl: "https://linux.sb",
  auth: { cookie: "PHPSESSID=sb_cookie", ...auth },
  options,
});
const nlChannel = {
  id: "ch_nl",
  name: "NodeLoc",
  type: "nodeloc",
  baseUrl: "https://www.nodeloc.com",
  auth: { cookie: "_t=discourse_token" },
  options: {},
};

/** linux.sb 登录态首页的最小复刻（含 _csrf / user-card / __pageFlash） */
const CSRF = "876c28430fb0a6ca719a0fb7194d5e3f0d9f3a68b6aaa23c64e5715f4ee5d7b6";
/** linux.sb 登录态首页 HTML（extra 可注入额外区块，比如「每日签到」页的签到记录） */
function sbHtml(flash = "", extra = "") {
  return `<!doctype html><html><body>${extra}
      <a href="/daily_checkin"><span class="feature-link-text">每日签到</span></a>
      <form method="post" action="/promotions_click" hidden><input type="hidden" name="_csrf" value="${CSRF}"></form>
      <aside><div class="card sidebar-card user-card"><div class="user-wrap"><div class="user-header"><div class="user-header-info">
        <a class="user-avatar-big" href="/user/3596"><img alt="PaperCups"></a>
        <div><a class="user-name" href="/user/3596">PaperCups</a><div class="user-rank"> 积分 1158</div></div>
      </div></div></div></aside>
      <script>window.__pageFlash="${flash}";</script>
    </body></html>`;
}

function sbHome(flash = "", extra = "") {
  return html(200, sbHtml(flash, extra));
}

/** 抽卡结果页片段（照 HAR 里 /gacha_pull?result=… 的真实结构） */
const RESULT_HTML = `<!doctype html><html><body><div class="gacha-result">
  <div class="gacha-result-card gacha-result-r" style="--gacha-color:var(--brand)">
    <div class="gacha-result-rarity">R</div>
    <div class="gacha-result-icon">📨</div>
    <div class="gacha-result-name">回复达人</div>
    <div class="gacha-result-desc">秒回小能手</div>
    <div class="gacha-result-quantity">获得 × 1（已累计）</div>
  </div>
  <div class="gacha-result-actions"><a class="gacha-result-button is-primary" href="/gacha">再抽一次</a></div>
</div></body></html>`;

try {
  console.log("\n[1] NodeSeek 签到成功（HAR 真实响应体）");
  {
    const calls = mockFetch({
      "POST /api/attendance": () =>
        json(200, { success: true, message: "今天的签到收益是6个鸡腿", gain: 6, current: 599 }),
    });
    const r = await nodeseekAdapter.checkin(nsChannel());
    ok(r.ok === true, "ok=true", r.message);
    ok(calls.length === 1, "只发一次请求", `calls=${calls.length}`);
    const c = calls[0];
    ok(c.u.pathname === "/api/attendance", "打的是 /api/attendance（不是 /api/attend）", c.u.pathname);
    ok(c.u.searchParams.get("random") === "true", "带 ?random=true", c.u.search);
    ok(c.body == null, "无请求体（HAR 里 content-length: 0）", String(c.body));
    ok(c.headers.Accept === "*/*", "Accept: */*（照 HAR）", c.headers.Accept);
    ok(c.headers.Cookie === "session=abc123", "带上 Cookie");
    ok(r.result?.rewardPoints === 6, "鸡腿收益透传", JSON.stringify(r.result));
    ok(/599/.test(r.message), "余额写进 message", r.message);
    // 599 鸡腿若塞进 user.balance，面板会按美元显示成 $0.00
    ok(r.user == null, "不放 user.balance（避免被当美元）");
  }

  console.log("\n[2] NodeSeek 今日已签到（success:true + 收益 0）");
  {
    mockFetch({
      "POST /api/attendance": () =>
        json(200, { success: true, message: "今天的签到收益是0个鸡腿", gain: 0, current: 599 }),
    });
    const r = await nodeseekAdapter.checkin(nsChannel());
    ok(r.ok === true, "已签到算成功", r.message);
    ok(r.result?.alreadyCheckedIn === true, "alreadyCheckedIn=true（收益 0 判据）");
  }

  console.log("\n[3] NodeSeek 风控回话：不能当成「接口不存在」");
  {
    mockFetch({ "POST /api/attendance": () => json(403, { success: false, message: "high risk action" }) });
    const r = await nodeseekAdapter.checkin(nsChannel());
    ok(r.ok === false, "ok=false");
    ok(/风控/.test(r.message), "说明是风控", r.message);
    ok(!/不存在/.test(r.message), "不说成接口不存在", r.message);
    ok(/cf_clearance|gha_api/.test(r.message), "给出 cf_clearance / gha_api 建议", r.message);
  }

  console.log("\n[4] NodeSeek Cloudflare 挑战页");
  {
    mockFetch({
      "POST /api/attendance": () =>
        html(403, "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>"),
    });
    const r = await nodeseekAdapter.checkin(nsChannel());
    ok(r.ok === false, "ok=false");
    ok(/Cloudflare/.test(r.message), "点名 Cloudflare", r.message);
  }

  console.log("\n[5] NodeSeek 404（Base URL 填错）");
  {
    mockFetch({ "POST /api/attendance": () => json(404, { success: false, message: "not found" }) });
    const r = await nodeseekAdapter.checkin(nsChannel());
    ok(r.ok === false, "ok=false");
    ok(/不存在 \/api\/attendance/.test(r.message), "提示接口不存在（命中永久失败判据）", r.message);
  }

  console.log("\n[6] NodeSeek 状态：排行榜里有自己 = 今日已签");
  {
    const calls = mockFetch({
      "GET /api/attendance/board": () =>
        json(200, {
          list: [
            { member_name: "NoxBug", gain: 13, created_at: "2026-09-30T16:05:40.000Z" },
            { member_name: "papercups", gain: 6, created_at: "2026-09-30T16:20:00.000Z" },
          ],
        }),
    });
    const r = await nodeseekAdapter.status(nsChannel({ username: "PaperCups" }));
    ok(r.ok === true, "ok=true", r.message);
    ok(r.status?.checkedInToday === true, "识别出今日已签（用户名大小写不敏感）");
    ok(r.status?.rewardPoints === 6, "带出当日收益", JSON.stringify(r.status));
    ok(calls[0].method === "GET", "状态查询是只读 GET", calls[0].method);
  }

  console.log("\n[7] NodeSeek 状态：没填用户名时不编造结论");
  {
    const calls = mockFetch({ "GET /api/attendance/board": () => json(200, { list: [] }) });
    const r = await nodeseekAdapter.status(nsChannel());
    ok(r.ok === true, "ok=true");
    ok(r.status?.checkedInToday == null, "不编造 checkedInToday", JSON.stringify(r.status));
    ok(calls.length === 0, "没填用户名就不发请求", `calls=${calls.length}`);
  }

  console.log("\n[8] linux.sb 刚自动签到（__pageFlash 有提示）");
  {
    const calls = mockFetch({ "GET /": () => sbHome("您是今天第 42 位签到的用户，已帮您完成自动签到，获得 19 积分") });
    const r = await linuxsbAdapter.checkin(sbChannel());
    ok(r.ok === true, "ok=true", r.message);
    ok(calls.length === 1, "只请求一次首页", `calls=${calls.length}`);
    ok(r.result?.alreadyCheckedIn === false, "刚签上 = 不是 alreadyCheckedIn");
    ok(r.result?.rewardPoints === 19, "积分透传", JSON.stringify(r.result));
    ok(/19 积分/.test(r.message), "message 带出积分", r.message);
    ok(!/api\/attend/.test(calls[0].u.pathname), "不打 /api/attend（HAR 里没有这个调用）");
  }

  console.log("\n[9] linux.sb 今日已签（__pageFlash 为空）");
  {
    mockFetch({ "GET /": () => sbHome("") });
    const r = await linuxsbAdapter.checkin(sbChannel());
    ok(r.ok === true, "ok=true", r.message);
    ok(r.result?.alreadyCheckedIn === true, "alreadyCheckedIn=true");
    ok(/已签过|自动签到/.test(r.message), "说明是自动签到机制", r.message);
  }

  console.log("\n[10] linux.sb Cookie 失效：拿到的是未登录页");
  {
    mockFetch({ "GET /": () => html(200, "<!doctype html><html><body><a href='/login'>登录</a></body></html>") });
    const r = await linuxsbAdapter.checkin(sbChannel());
    ok(r.ok === false, "ok=false");
    ok(/Cookie 无效或已过期/.test(r.message), "归一化成 Cookie 失效", r.message);
  }

  console.log("\n[11] linux.sb 抽称号（HAR 真实流程与结果页）");
  {
    const calls = mockFetch({
      "GET /": () => sbHome(""),
      "POST /gacha_pull": () =>
        html(302, "", { Location: "/gacha_pull?result=cbbb153c56fc1bd9617812d26f4c8c31" }),
      "GET /gacha_pull": () => html(200, RESULT_HTML),
    });
    const r = await linuxsbAdapter.gacha(sbChannel());
    ok(r.ok === true, "ok=true", r.message);
    const post = calls.find((c) => c.method === "POST" && c.u.pathname === "/gacha_pull");
    ok(!!post, "提交了 POST /gacha_pull");
    ok(post.headers["Content-Type"] === "application/x-www-form-urlencoded", "表单编码（HAR 一致）");
    ok(post.body === `_csrf=${CSRF}`, "body 只有 _csrf（照 HAR）", post.body);
    ok(post.headers.Referer.endsWith("/gacha"), "Referer 指向 /gacha", post.headers.Referer);
    const t = r.result?.titles?.[0];
    ok(!!t, "解析出称号", JSON.stringify(r.result));
    ok(t?.name === "回复达人", "称号名", t?.name);
    ok(t?.rarity === "R" && t?.icon === "📨", "稀有度 + 图标", `${t?.rarity} ${t?.icon}`);
    ok(t?.desc === "秒回小能手", "称号描述", t?.desc);
    ok(/回复达人/.test(r.message), "message 含称号名", r.message);
  }

  console.log("\n[12] linux.sb 抽称号：拿不到 _csrf");
  {
    // 已登录页面，但站点模板里没有任何 _csrf 表单
    mockFetch({
      "GET /": () =>
        html(
          200,
          `<!doctype html><html><body><a href="/daily_checkin">每日签到</a>
           <a class="user-name" href="/user/3596">PaperCups</a></body></html>`
        ),
    });
    const r = await linuxsbAdapter.gacha(sbChannel());
    ok(r.ok === false, "ok=false");
    ok(/_csrf/.test(r.message), "提示缺少 _csrf", r.message);
  }

  console.log("\n[13] linux.sb 抽称号：非 302（今日免费抽已用完）");
  {
    mockFetch({
      "GET /": () => sbHome(""),
      "POST /gacha_pull": () => sbHome("今日免费抽已用完"),
    });
    const r = await linuxsbAdapter.gacha(sbChannel());
    ok(r.ok === false, "ok=false");
    ok(/已用完/.test(r.message), "透传站点提示", r.message);
  }

  console.log("\n[14] linux.sb 签到顺带抽称号（options.autoGacha）");
  {
    const calls = mockFetch({
      "GET /": () => sbHome("您是今天第 42 位签到的用户，已帮您完成自动签到，获得 19 积分"),
      "POST /gacha_pull": () => html(302, "", { Location: "/gacha_pull?result=abc" }),
      "GET /gacha_pull": () => html(200, RESULT_HTML),
    });
    const r = await linuxsbAdapter.checkin(sbChannel({ autoGacha: "true" }));
    ok(r.ok === true, "签到仍成功", r.message);
    ok(r.result?.titles?.length === 1, "顺带抽到称号", JSON.stringify(r.result?.titles));
    ok(/回复达人/.test(r.message), "message 附带抽称号结果", r.message);
    ok(calls.some((c) => c.method === "POST" && c.u.pathname === "/gacha_pull"), "确实发了抽称号请求");
  }

  console.log("\n[15] linux.sb 抽称号失败不推翻签到结论");
  {
    mockFetch({
      "GET /": () => sbHome("您是今天第 42 位签到的用户，已帮您完成自动签到"),
      "POST /gacha_pull": () => sbHome("今日免费抽已用完"),
    });
    const r = await linuxsbAdapter.checkin(sbChannel({ autoGacha: "true" }));
    ok(r.ok === true, "签到仍 ok=true", r.message);
    ok(/抽称号失败/.test(r.message), "把抽称号失败写进 message", r.message);
  }

  console.log("\n[16] linux.sb me()：只认 user-card 里的 id/用户名/积分");
  {
    mockFetch({ "GET /": () => sbHome("") });
    const r = await linuxsbAdapter.me(sbChannel());
    ok(r.ok === true, "ok=true", r.message);
    ok(r.user?.id === "3596", "取到自己的 id（不是页面上别人的 /user/1）", r.user?.id);
    ok(r.user?.displayName === "PaperCups", "取到用户名", r.user?.displayName);
    ok(r.user?.points === 1158, "取到积分", String(r.user?.points));
    ok(r.user?.balance == null, "积分不放 balance（面板会按美元显示）");
  }

  console.log("\n[17] 缺 Cookie：三站都不发请求");
  {
    for (const [name, adapter, ch] of [
      ["NodeSeek", nodeseekAdapter, nsChannel()],
      ["linux.sb", linuxsbAdapter, sbChannel()],
      ["NodeLoc", nodelocAdapter, nlChannel],
    ]) {
      const calls = mockFetch({ "*": () => json(200, { success: true }) });
      const bare = { ...ch, auth: {} };
      const r = await adapter.checkin(bare);
      ok(r.ok === false && /缺少 Cookie/.test(r.message), `${name} 提示缺少 Cookie`, r.message);
      ok(calls.length === 0, `${name} 没发请求`, `calls=${calls.length}`);
    }
  }

  console.log("\n[18] NodeLoc 签到成功（HAR：form-urlencoded + nonce 头）");
  {
    const calls = mockFetch({
      "GET /session/csrf.json": () => json(200, { csrf: "csrf-token-abc" }),
      "POST /checkin": () =>
        json(
          200,
          { success: true, points: 10, user_date: "2026-10-01", timezone: "Asia/Shanghai" },
          { "x-discourse-username": "PaperCups" }
        ),
    });
    const r = await nodelocAdapter.checkin(nlChannel);
    ok(r.ok === true, "ok=true", r.message);
    const c = calls.find((x) => x.u.pathname === "/checkin");
    ok(!!c, "调用了 POST /checkin");
    ok(
      c.headers["Content-Type"] === "application/x-www-form-urlencoded; charset=UTF-8",
      "表单编码（HAR 一致，JSON 会被站点拒）",
      c.headers["Content-Type"]
    );
    ok(/^nonce=[^&]+&timestamp=\d+$/.test(c.body), "body 形如 nonce=…&timestamp=…", c.body);
    ok(c.headers["X-CSRF-Token"] === "csrf-token-abc", "带会话 CSRF token");
    ok(c.headers["X-Discourse-Checkin"] === "true", "带 X-Discourse-Checkin");
    const nonce = /nonce=([^&]+)/.exec(c.body)?.[1];
    ok(nonce === c.headers["X-Checkin-Nonce"], "nonce 头与 body 一致（插件要求）", `${nonce} vs ${c.headers["X-Checkin-Nonce"]}`);
    ok(r.result?.rewardPoints === 10, "积分透传", JSON.stringify(r.result));
    ok(r.result?.reward === null, "积分不进 reward（面板会按美元显示）");
    ok(r.result?.checkInDate === "2026-10-01", "签到日期透传");
    ok(r.user?.username === "PaperCups", "从响应头取到用户名", r.user?.username);
  }

  console.log("\n[19] NodeLoc 今日已签到");
  {
    mockFetch({
      "GET /session/csrf.json": () => json(200, { csrf: "csrf-token-abc" }),
      "POST /checkin": () => json(200, { success: false, message: "今日已签到" }),
    });
    const r = await nodelocAdapter.checkin(nlChannel);
    ok(r.ok === true, "已签到算成功", r.message);
    ok(r.result?.alreadyCheckedIn === true, "alreadyCheckedIn=true");
  }

  console.log("\n[20] NodeLoc CSRF 取不到（Cookie 无效）");
  {
    mockFetch({ "GET /session/csrf.json": () => json(403, { errors: ["BAD CSRF"] }) });
    const r = await nodelocAdapter.checkin(nlChannel);
    ok(r.ok === false, "ok=false");
    ok(/CSRF/.test(r.message), "提示 CSRF 问题", r.message);
  }

  console.log("\n[21] NodeLoc me() 走 /session/current.json");
  {
    mockFetch({
      "GET /session/current.json": () =>
        json(200, { current_user: { id: 42, username: "someone", name: "某用户", trust_level: 2 } }),
    });
    const r = await nodelocAdapter.me(nlChannel);
    ok(r.ok === true, "ok=true", r.message);
    ok(r.user?.username === "someone", "取到用户名");
    ok(r.user?.group === "TL2", "信任等级映射成组别");
  }

  console.log("\n[23] linux.sb status()：读「每日签到」页面");
  {
    const signedHtml = sbHtml("", '<div class="daily_checkin"><span>今日已签到，获得 19 积分</span></div>');
    mockFetch({ "GET /daily_checkin": () => html(200, signedHtml) });
    const done = await linuxsbAdapter.status(sbChannel());
    ok(done.ok === true, "ok=true", done.message);
    ok(done.status?.checkedInToday === true, "识别出今日已签", JSON.stringify(done.status));

    mockFetch({ "GET /daily_checkin": () => sbHome("") });
    const fresh = await linuxsbAdapter.status(sbChannel());
    ok(fresh.status?.checkedInToday === false, "没有签到记录时不谎报已签", JSON.stringify(fresh.status));
    ok(/直接点「签到」/.test(fresh.message), "提示直接签到即可", fresh.message);
  }

  console.log("\n[22] 适配器自报动作：只有 linux.sb 有「抽称号」");
  {
    const { listAdapters } = await import("../src/adapters/index.js");
    const map = Object.fromEntries(listAdapters().map((a) => [a.id, a.actions]));
    ok(map.linuxsb?.some((x) => x.action === "gacha" && x.label === "抽称号"), "linux.sb 上报 gacha", JSON.stringify(map.linuxsb));
    for (const id of ["nodeseek", "nodeloc", "newapi", "sub2api"]) {
      ok(!map[id]?.length, `${id} 没有额外动作`, JSON.stringify(map[id]));
    }
  }
} finally {
  globalThis.fetch = restoreFetch;
}

console.log(`\n${failures ? "❌" : "✅"} ${checks - failures}/${checks} 通过`);
process.exit(failures ? 1 : 0);