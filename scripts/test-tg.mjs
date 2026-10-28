/**
 * Telegram 指令/按钮/Webhook 的离线回归测试（mock fetch + mock KV，不联网）。
 *
 * 跑法：node scripts/test-tg.mjs
 *
 * 覆盖：
 *   - fail closed：缺配置 503、错误 secret 403、错误 chat/群聊无白名单/错误用户 200 ignored
 *   - 合法命令（/start /help /status /checkin /proxies /testproxies、/cmd@botname）与 inline 按钮
 *   - callback 先 answerCallbackQuery；重复 update 只执行一次；KV 未绑定 503
 *   - HTML 转义与 maskProxyUrl（不泄露 token/password/rawUrl）
 *   - setup：https origin + secret_token + allowed_updates + setMyCommands
 *   - status：配置布尔值 + getWebhookInfo 概况（无 secret）
 *   - telegramApi：HTTP 错误 / data.ok=false / 超时，错误信息不含 token
 *   - 旧契约兼容：formatCheckinReport 报告格式、sendTelegram 基本形状
 *
 * 使用原生 Node + mock fetch/KV；不调用真实 Telegram、GitHub 或签到站点。
 */
import assert from "node:assert/strict";

import { handleTelegramWebhook, setupTelegramWebhook, getTelegramStatus } from "../src/tg-bot.js";
import { sendTelegram, formatCheckinReport, telegramApi } from "../src/tg.js";

let checks = 0;
let failures = 0;
const show = (cond, label, extra = "") => {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// ─────────── mock 基础设施 ───────────

/** 内存 KV（带 get/put/delete，忽略 TTL） */
function mockKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    _dump: () => m,
  };
}

/** 假 fetch：按 (method, pathname) 分派；记录每次调用供断言 */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const call = { url, u, method: (init.method || "GET").toUpperCase(), body, headers: init.headers || {} };
    calls.push(call);
    const key = `${call.method} ${u.pathname}`;
    const h = routes[key] || routes[u.pathname] || routes["*"];
    if (!h) throw new Error(`未 mock 的路由: ${key}`);
    return h(call);
  };
  impl.calls = calls;
  return impl;
}

const tgOk = (result = {}) => () => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const tgFail = (desc, status = 400) => () =>
  new Response(JSON.stringify({ ok: false, description: desc }), { status });

const BASE_ENV = {
  TG_BOT_TOKEN: "123456:ABC-DEF_secret-token-value",
  TG_CHAT_ID: "424242",
  TG_WEBHOOK_SECRET: "s3cret_webhook_secret_value_16ch",
  CHECKIN_KV: null, // 每个用例自建
};

function webhookRequest(update, secretHeader) {
  return new Request("https://hub.example.com/api/tg/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secretHeader ? { "X-Telegram-Bot-Api-Secret-Token": secretHeader } : {}),
    },
    body: JSON.stringify(update),
  });
}

let nextUpdateId = 10000;
function messageUpdate(overrides = {}) {
  const { update_id = nextUpdateId++, ...message } = overrides;
  return {
    update_id,
    message: {
      message_id: 7,
      chat: { id: 424242, type: "private" },
      from: { id: 999, is_bot: false, first_name: "Owner" },
      text: "/status",
      ...message,
    },
  };
}

function callbackUpdate(overrides = {}) {
  const { update_id = nextUpdateId++, ...callback } = overrides;
  return {
    update_id,
    callback_query: {
      id: "CB1",
      from: { id: 999, is_bot: false, first_name: "Owner" },
      message: { message_id: 7, chat: { id: 424242, type: "private" } },
      data: "cmd:checkin",
      ...callback,
    },
  };
}

function defaultRoutes() {
  return {
    "POST /bot123456:ABC-DEF_secret-token-value/sendMessage": tgOk({ message_id: 1 }),
    "POST /bot123456:ABC-DEF_secret-token-value/answerCallbackQuery": tgOk(),
    "POST /bot123456:ABC-DEF_secret-token-value/getWebhookInfo": tgOk({ url: "https://hub.example.com/api/tg/webhook", pending_update_count: 0 }),
    "POST /bot123456:ABC-DEF_secret-token-value/setWebhook": tgOk(),
    "POST /bot123456:ABC-DEF_secret-token-value/setMyCommands": tgOk(),
  };
}

const secretHeader = BASE_ENV.TG_WEBHOOK_SECRET;

// ─────────── 1. fail closed ───────────

async function testFailClosed() {
  console.log("▶ fail closed 配置门");
  {
    const fetchMock = mockFetch(defaultRoutes());
    globalThis.fetch = fetchMock;
    const env = { ...BASE_ENV, TG_BOT_TOKEN: "" };
    const res = await handleTelegramWebhook(webhookRequest(messageUpdate(), secretHeader), env, null, {});
    show(res.status === 503, "缺 TG_BOT_TOKEN → 503", `got ${res.status}`);
    const body = await res.json();
    show(!JSON.stringify(body).includes("secret-token-value"), "503 响应不含 token");
  }
  {
    const env = { ...BASE_ENV, TG_CHAT_ID: "" };
    const res = await handleTelegramWebhook(webhookRequest(messageUpdate(), secretHeader), env, null, {});
    show(res.status === 503, "缺 TG_CHAT_ID → 503", `got ${res.status}`);
  }
  {
    const env = { ...BASE_ENV, TG_WEBHOOK_SECRET: "" };
    const res = await handleTelegramWebhook(webhookRequest(messageUpdate(), secretHeader), env, null, {});
    show(res.status === 503, "缺 TG_WEBHOOK_SECRET → 503", `got ${res.status}`);
  }
  {
    const env = { ...BASE_ENV, TG_WEBHOOK_SECRET: "short" };
    const res = await handleTelegramWebhook(webhookRequest(messageUpdate(), "short"), env, null, {});
    show(res.status === 503, "secret 格式非法（<16位）→ 503", `got ${res.status}`);
  }
  {
    const env = { ...BASE_ENV };
    globalThis.fetch = mockFetch(defaultRoutes());
    const res = await handleTelegramWebhook(webhookRequest(messageUpdate(), "wrong_secret_value_abc"), env, null, {});
    show(res.status === 403, "错误 secret header → 403", `got ${res.status}`);
  }
  {
    const env = { ...BASE_ENV };
    const res = await handleTelegramWebhook(webhookRequest(messageUpdate(), undefined), env, null, {});
    show(res.status === 403, "缺 secret header → 403", `got ${res.status}`);
  }
  {
    const env = { ...BASE_ENV };
    const res = await handleTelegramWebhook(
      webhookRequest({ update_id: "not-a-number", message: {} }, secretHeader),
      env, null, {}
    );
    show(res.status === 400, "update_id 非安全整数 → 400", `got ${res.status}`);
  }
  {
    const env = { ...BASE_ENV };
    const res = await handleTelegramWebhook(
      new Request("https://hub.example.com/api/tg/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secretHeader },
        body: "not json",
      }),
      env, null, {}
    );
    show(res.status === 400, "非 JSON body → 400", `got ${res.status}`);
  }
  {
    globalThis.fetch = mockFetch(defaultRoutes());
    const env = { ...BASE_ENV, CHECKIN_KV: mockKV(), TG_ALLOWED_USER_ID: "not-a-user-id" };
    const res = await handleTelegramWebhook(webhookRequest(messageUpdate(), secretHeader), env, null, {});
    show(res.status === 503, "非法用户白名单配置必须 fail closed", `got ${res.status}`);
  }
  {
    globalThis.fetch = mockFetch(defaultRoutes());
    const env = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    const res = await handleTelegramWebhook(webhookRequest(messageUpdate({ update_id: -1 }), secretHeader), env, null, {});
    show(res.status === 400, "负数 update_id 不应被接受", `got ${res.status}`);
  }
}

// ─────────── 2. chat / 用户白名单 ───────────

async function testChatAndUserFilter() {
  console.log("▶ chat / 用户过滤");
  {
    const fetchMock = mockFetch(defaultRoutes());
    globalThis.fetch = fetchMock;
    const env = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    const update = messageUpdate({ chat: { id: -100999, type: "group" } });
    const res = await handleTelegramWebhook(webhookRequest(update, secretHeader), env, null, {});
    const body = await res.json();
    show(res.status === 200 && String(body.result).includes("wrong chat"), "错误 chat → 200 ignored");
    show(fetchMock.calls.length === 0, "错误 chat 不产生任何 Telegram API 调用", `calls=${fetchMock.calls.length}`);
  }
  {
    const fetchMock = mockFetch(defaultRoutes());
    globalThis.fetch = fetchMock;
    const env = { ...BASE_ENV, TG_CHAT_ID: "-100999", CHECKIN_KV: mockKV() };
    const update = messageUpdate({ chat: { id: -100999, type: "supergroup" } });
    const res = await handleTelegramWebhook(webhookRequest(update, secretHeader), env, null, {});
    const body = await res.json();
    show(
      res.status === 200 && String(body.result).includes("group chat without TG_ALLOWED_USER_ID"),
      "群聊无白名单 → 200 ignored（拒绝执行）"
    );
    show(fetchMock.calls.length === 0, "群聊无白名单不产生 sendMessage");
  }
  {
    const fetchMock = mockFetch(defaultRoutes());
    globalThis.fetch = fetchMock;
    const env = { ...BASE_ENV, CHECKIN_KV: mockKV(), TG_ALLOWED_USER_ID: "8888" };
    const update = messageUpdate({ from: { id: 999 } });
    const res = await handleTelegramWebhook(webhookRequest(update, secretHeader), env, null, {});
    const body = await res.json();
    show(res.status === 200 && String(body.result).includes("user not allowed"), "错误用户 → 200 ignored");
    show(fetchMock.calls.length === 0, "错误用户不产生 API 调用");
  }
  {
    const fetchMock = mockFetch({
      ...defaultRoutes(),
      "POST /bot123456:ABC-DEF_secret-token-value/answerCallbackQuery": tgOk(),
    });
    globalThis.fetch = fetchMock;
    const env = { ...BASE_ENV, TG_CHAT_ID: "-100999", CHECKIN_KV: mockKV() };
    // 群聊（chat.id<0）的 callback，无白名单：应 answer 提示后忽略
    const update = callbackUpdate({ message: { chat: { id: -100999, type: "supergroup" } } });
    const res = await handleTelegramWebhook(webhookRequest(update, secretHeader), env, null, {});
    show(res.status === 200, "群聊 callback → 200");
    const answered = fetchMock.calls.filter((c) => c.u.pathname.endsWith("answerCallbackQuery"));
    show(answered.length === 1, "群聊拒绝时仍 answerCallbackQuery 消除转圈", `answered=${answered.length}`);
  }
}

// ─────────── 3. 合法命令 / 按钮 / 去重 ───────────

async function testCommandsAndButtons() {
  console.log("▶ 合法命令与按钮");
  const kv = mockKV();
  const fetchMock = mockFetch(defaultRoutes());
  globalThis.fetch = fetchMock;
  const env = { ...BASE_ENV, CHECKIN_KV: kv };
  let checkinCalls = 0;
  let testProxiesCalls = 0;
  const actions = {
    checkin: async () => {
      checkinCalls++;
      return { ok: true };
    },
    testProxies: async () => {
      testProxiesCalls++;
      return { ok: true, job: { id: "job1", status: "running", count: 3 } };
    },
  };

  // /status：读取 KV 数据，转义输出
  kv._dump().set("last_run", JSON.stringify({
    at: "2026-01-01T00:00:00.000Z",
    runner: "worker",
    results: [{ name: "Chan<b>x", ok: true, message: "ok<svg onload=alert(1)>" }],
  }));
  kv._dump().set("channels", JSON.stringify([
    { name: "a", enabled: true }, { name: "b", enabled: false },
  ]));
  kv._dump().set("proxies", JSON.stringify([
    { url: "socks5://user:p@ssw0rd@1.2.3.4:1080", enabled: true, lastCheck: { ok: true, ms: 300, at: Date.now() } },
  ]));

  for (const text of ["/status", "/help", "/start", "/proxies", "/status@MyHubBot", "/checkin", "/testproxies"]) {
    const res = await handleTelegramWebhook(
      webhookRequest(messageUpdate({ text }), secretHeader),
      env, null, actions
    );
    show(res.status === 200, `${text} → 200`);
  }
  await new Promise((r) => setTimeout(r, 10));

  const sends = fetchMock.calls.filter((c) => c.u.pathname.endsWith("sendMessage"));
  const statusMsg = sends.find((c) => c.body.text?.includes("最近签到状态"));
  show(!!statusMsg, "/status 发送状态消息");
  show(
    !!statusMsg && statusMsg.body.text.includes("Chan&lt;b") && statusMsg.body.text.includes("alert(1)&gt;"),
    "状态文本 HTML 转义（不注入标签）"
  );
  const proxiesMsg = sends.find((c) => c.body.text?.includes("<b>🌐 代理池概况</b>"));
  show(
    !!proxiesMsg && proxiesMsg.body.text.includes("user:***@1.2.3.4:1080") && !proxiesMsg.body.text.includes("p@ssw0rd"),
    "代理地址经 maskProxyUrl，不泄露密码"
  );
  const helpMsg = sends.find((c) => c.body.text?.includes("Check-in Hub Telegram Bot"));
  show(
    !!helpMsg && JSON.stringify(helpMsg.body.reply_markup || {}).includes("cmd:status"),
    "/start|help 带 inline keyboard（callback_data 不含凭证）"
  );
  show(checkinCalls === 1 && testProxiesCalls === 1, "checkin/testProxies actions 各被调用一次",
    `checkin=${checkinCalls} testProxies=${testProxiesCalls}`);
  const checkinMsg = sends.find((c) => c.body.text?.includes("开始处理"));
  show(!!checkinMsg, "/checkin 先发「开始处理」");
  show(
    sends.filter((c) => c.body.text?.includes("签到报告")).length === 0,
    "/checkin 成功时 bot 不重复发报告"
  );
  const submittedMsg = sends.find((c) => c.body.text?.includes("已提交代理测试"));
  show(!!submittedMsg && submittedMsg.body.text.includes("3 条"), "testproxies 成功回复已提交+条数");

  // /checkin 失败路径：{ok:false,message}
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    const res = await handleTelegramWebhook(
      webhookRequest(messageUpdate({ text: "/checkin", update_id: 4101 }), secretHeader),
      env2, null, { checkin: async () => ({ ok: false, message: "全部渠道均未启用" }) }
    );
    show(res.status === 200, "/checkin {ok:false} → 200");
    await new Promise((r) => setTimeout(r, 5));
    const failMsg = fm2.calls.filter((c) => c.u.pathname.endsWith("sendMessage"))
      .find((c) => c.body.text?.includes("签到失败"));
    show(!!failMsg && failMsg.body.text.includes("全部渠道均未启用"), "{ok:false,message} 时提示失败");
  }
  // /checkin 抛错路径
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    await handleTelegramWebhook(
      webhookRequest(messageUpdate({ text: "/checkin", update_id: 4102 }), secretHeader),
      env2, null, { checkin: async () => { throw new Error("boom"); } }
    );
    await new Promise((r) => setTimeout(r, 5));
    const failMsg = fm2.calls.filter((c) => c.u.pathname.endsWith("sendMessage"))
      .find((c) => c.body.text?.includes("签到失败"));
    show(!!failMsg && failMsg.body.text.includes("boom"), "actions.checkin 抛错时提示失败");
  }

  // 普通文本不是命令 → ignored，不执行动作
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    let calls = 0;
    await handleTelegramWebhook(
      webhookRequest(messageUpdate({ text: "你好，帮我签到一下", update_id: 4201 }), secretHeader),
      env2, null, { checkin: async () => { calls++; } }
    );
    show(calls === 0 && fm2.calls.filter((c) => c.u.pathname.endsWith("sendMessage")).length === 0,
      "普通文本不当命令处理");
  }
  // 未支持命令
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    await handleTelegramWebhook(
      webhookRequest(messageUpdate({ text: "/rmrf", update_id: 4202 }), secretHeader),
      env2, null, {}
    );
    show(fm2.calls.filter((c) => c.u.pathname.endsWith("sendMessage")).length === 0, "未支持命令 → ignored");
  }
  {
    globalThis.fetch = mockFetch(defaultRoutes());
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    let calls = 0;
    await handleTelegramWebhook(webhookRequest(messageUpdate({ text: "/checkin123" }), secretHeader), env2, null, {
      checkin: async () => { calls++; return { ok: true }; },
    });
    show(calls === 0, "非完整命令 /checkin123 不得触发签到", `calls=${calls}`);
  }
  // edited_message / channel_post 不处理
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    await handleTelegramWebhook(
      webhookRequest({ update_id: 4203, edited_message: { chat: { id: 424242 }, text: "/checkin" } }, secretHeader),
      env2, null, { checkin: async () => { throw new Error("should not run"); } }
    );
    await handleTelegramWebhook(
      webhookRequest({ update_id: 4204, channel_post: { chat: { id: 424242 }, text: "/checkin" } }, secretHeader),
      env2, null, { checkin: async () => { throw new Error("should not run"); } }
    );
    show(fm2.calls.filter((c) => c.u.pathname.endsWith("sendMessage")).length === 0,
      "edited_message / channel_post 不处理");
  }

  // ── inline 按钮：callback 路径 ──
  console.log("▶ inline 按钮（callback_query）");
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    let checkinCalls2 = 0;
    const res = await handleTelegramWebhook(
      webhookRequest(callbackUpdate({ data: "cmd:checkin", update_id: 5001 }), secretHeader),
      env2, null, { checkin: async () => { checkinCalls2++; return { ok: true }; } }
    );
    show(res.status === 200, "callback cmd:checkin → 200");
    await new Promise((r) => setTimeout(r, 5));
    const answered = fm2.calls.filter((c) => c.u.pathname.endsWith("answerCallbackQuery"));
    show(answered.length === 1, "callback 执行前 answerCallbackQuery");
    show(answered[0]?.body.callback_query_id === "CB1", "answerCallbackQuery 带正确的 callback_query_id");
    show(checkinCalls2 === 1, "按钮触发 actions.checkin");
  }
  // 恶意 callback_data
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    await handleTelegramWebhook(
      webhookRequest(callbackUpdate({ data: "evil:rm_rf", update_id: 5002 }), secretHeader),
      env2, null, {}
    );
    await new Promise((r) => setTimeout(r, 5));
    show(fm2.calls.filter((c) => c.u.pathname.endsWith("sendMessage")).length === 0,
      "未知 callback_data 不触发动作（但仍 answer）");
  }

  // ── 重复 update 去重 ──
  console.log("▶ update_id 去重");
  {
    const kv2 = mockKV();
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: kv2 };
    let calls2 = 0;
    const actions2 = { checkin: async () => { calls2++; return { ok: true }; } };
    const upd = messageUpdate({ text: "/checkin", update_id: 6001 });
    await handleTelegramWebhook(webhookRequest(upd, secretHeader), env2, null, actions2);
    await handleTelegramWebhook(webhookRequest(upd, secretHeader), env2, null, actions2);
    await new Promise((r) => setTimeout(r, 5));
    show(calls2 === 1, "同一 update 重复投递只执行一次", `calls=${calls2}`);
    show(kv2._dump().has("tg_update_6001"), "去重键写入 KV");
  }
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const res = await handleTelegramWebhook(
      webhookRequest(messageUpdate({ update_id: 6002 }), secretHeader),
      { ...BASE_ENV }, null, {}
    );
    show(res.status === 503, "KV 未绑定 → 503（防重复动作）", `got ${res.status}`);
  }

  // ── ctx.waitUntil 异步路径 ──
  console.log("▶ ctx.waitUntil");
  {
    const fm2 = mockFetch(defaultRoutes());
    globalThis.fetch = fm2;
    const env2 = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    const res = await handleTelegramWebhook(
      webhookRequest(messageUpdate({ text: "/checkin", update_id: 7001 }), secretHeader),
      env2, ctx, { checkin: async () => ({ ok: true }) }
    );
    show(res.status === 200, "带 ctx 时快速返回 200");
    await Promise.all(waited);
    const sends2 = fm2.calls.filter((c) => c.u.pathname.endsWith("sendMessage"));
    show(sends2.some((c) => c.body.text?.includes("开始处理")), "waitUntil 中执行了命令");
  }
}

// ─────────── 4. setup / status ───────────

async function testSetupAndStatus() {
  console.log("▶ setup / status");
  {
    const fm = mockFetch(defaultRoutes());
    globalThis.fetch = fm;
    const env = { ...BASE_ENV, CHECKIN_KV: mockKV() };
    const r = await setupTelegramWebhook(new Request("https://hub.example.com/api/tg/setup", { method: "POST" }), env);
    show(r.ok === true, "setup 返回 ok:true", JSON.stringify(r));
    const setWebhook = fm.calls.find((c) => c.u.pathname.endsWith("setWebhook"));
    show(!!setWebhook && setWebhook.body.url === "https://hub.example.com/api/tg/webhook",
      "setWebhook 用 request.url origin + /api/tg/webhook");
    show(setWebhook?.body.secret_token === BASE_ENV.TG_WEBHOOK_SECRET, "setWebhook 带 secret_token");
    show(
      Array.isArray(setWebhook?.body.allowed_updates) &&
        setWebhook.body.allowed_updates.join(",") === "message,callback_query",
      "allowed_updates = [message, callback_query]"
    );
    show(setWebhook?.body.drop_pending_updates === undefined, "不 drop_pending_updates");
    const setCmd = fm.calls.find((c) => c.u.pathname.endsWith("setMyCommands"));
    show(!!setCmd && Array.isArray(setCmd.body.commands) && setCmd.body.commands.length === 6,
      "setMyCommands 注册命令菜单");
  }
  {
    const fm = mockFetch(defaultRoutes());
    globalThis.fetch = fm;
    const r = await setupTelegramWebhook(new Request("http://localhost:8787/api/tg/setup", { method: "POST" }), { ...BASE_ENV, CHECKIN_KV: mockKV() });
    show(r.ok === false && /https/.test(r.error), "非 https origin → setup 拒绝");
    show(!JSON.stringify(r).includes("secret-token-value"), "setup 错误信息不含 token");
  }
  {
    const r = await setupTelegramWebhook(
      new Request("https://hub.example.com/api/tg/setup", { method: "POST" }),
      { ...BASE_ENV, TG_BOT_TOKEN: "" }
    );
    show(r.ok === false && r.error.includes("TG_BOT_TOKEN"), "缺配置 → setup 返回缺失变量名");
  }
  {
    const fm = mockFetch(defaultRoutes());
    globalThis.fetch = fm;
    const r = await getTelegramStatus({ ...BASE_ENV });
    show(r.ok === true && r.config.tg_bot_token === true && r.config.tg_webhook_secret === true,
      "status 返回配置布尔值");
    show(r.webhook.url === "https://hub.example.com/api/tg/webhook", "status 返回 webhook 概况");
    show(!JSON.stringify(r).includes(BASE_ENV.TG_WEBHOOK_SECRET), "status 不回显 secret");
    show(!JSON.stringify(r).includes("secret-token-value"), "status 不回显 token");
  }
  {
    const r = await getTelegramStatus({ ...BASE_ENV, TG_BOT_TOKEN: "" });
    show(r.ok === false && r.config.missing.includes("TG_BOT_TOKEN"), "status 缺配置时返回缺失变量名");
  }
  {
    const fm = mockFetch({
      "POST /bot123456:ABC-DEF_secret-token-value/getWebhookInfo": tgFail("Bad token"),
    });
    globalThis.fetch = fm;
    const r = await getTelegramStatus({ ...BASE_ENV });
    show(r.ok === false && !JSON.stringify(r).includes("secret-token-value"), "status API 失败不泄漏 token");
  }
}

// ─────────── 5. telegramApi / sendTelegram / 旧报告兼容 ───────────

async function testTelegramApi() {
  console.log("▶ telegramApi / sendTelegram / 旧契约");
  const env = { ...BASE_ENV };
  {
    const fm = mockFetch({ "POST /bot123456:ABC-DEF_secret-token-value/sendMessage": tgOk({ message_id: 9 }) });
    globalThis.fetch = fm;
    const r = await sendTelegram(env, "<b>hello</b>");
    show(r.ok === true && r.data.ok === true, "sendTelegram 基本成功（旧形状 {ok,status,data}）");
    show(fm.calls[0].body.chat_id === "424242" && fm.calls[0].body.parse_mode === "HTML",
      "sendTelegram 保留旧 payload 形状");
  }
  {
    const fm = mockFetch({ "POST /bot123456:ABC-DEF_secret-token-value/sendMessage": tgFail("Unauthorized", 401) });
    globalThis.fetch = fm;
    const r = await sendTelegram(env, "x");
    show(r.ok === false && typeof r.error === "string", "sendTelegram 失败返回对象不抛出");
    show(!String(r.error).includes("secret-token-value") && !String(r.error).includes("api.telegram.org"),
      "错误信息不含 token/URL");
  }
  {
    // fetch 抛错（含 URL/token 的错误消息必须被脱敏）
    globalThis.fetch = async () => { throw new Error("fetch to https://api.telegram.org/bot123456:ABC-DEF_secret-token-value/sendMessage failed"); };
    const r = await telegramApi(env, "getMe", {});
    show(r.ok === false && !String(r.error).includes("secret-token-value"), "fetch 抛错时 token 被脱敏", r.error);
  }
  {
    // 超时：AbortController 立即 abort
    globalThis.fetch = async (url, init = {}) => {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    };
    const r = await telegramApi({ ...env, TG_API_TIMEOUT_MS: 20 }, "getUpdates", {});
    show(r.ok === false && r.error.includes("超时"), "API 超时返回错误对象（不抛出）", r.error);
  }
  {
    // HTTP 500 + 非 JSON
    globalThis.fetch = async () => new Response("gateway error", { status: 500 });
    const r = await telegramApi(env, "sendMessage", {});
    show(r.ok === false && r.status === 500, "非 JSON 响应 → 失败对象");
  }
  {
    // 长消息拆分
    const fm = mockFetch({ "POST /bot123456:ABC-DEF_secret-token-value/sendMessage": tgOk() });
    globalThis.fetch = fm;
    const long = Array.from({ length: 300 }, (_, i) => `line-${i} ${"x".repeat(20)}`).join("\n");
    const r = await sendTelegram(env, long);
    show(r.ok === true && r.parts > 1, `长消息按行拆成 ${r.parts} 条（均不超 4096）`);
    show(fm.calls.every((c) => c.body.text.length <= 4096), "每条消息不超过 4096 字符");
  }
  {
    // 旧报告格式兼容
    const rep = formatCheckinReport("📋 定时签到报告", [
      { name: "Alpha", ok: true, message: "ok: +10" },
      { name: "Beta", ok: false, message: "timeout" },
      { name: "Gamma", ok: true, message: "ok", lottery: { ok: true, message: "抽到 5 积分" } },
      { name: "Delta", ok: true, message: "ok", lottery: { skipped: true, message: "今日已抽完" } },
    ]);
    const lines = rep.split("\n");
    show(lines[0] === "<b>📋 定时签到报告</b>", "报告标题行不变");
    show(lines[1] === "成功 3/4", "汇总行不变");
    show(rep.includes("✅ <b>Alpha</b>：ok: +10") && rep.includes("❌ <b>Beta</b>：timeout"), "结果行格式不变");
    show(rep.includes("🎰 <b>Gamma</b> 抽奖：抽到 5 积分"), "抽奖成功行格式不变");
    show(rep.includes("⏭️ <b>Delta</b> 抽奖：今日已抽完"), "抽奖跳过行格式不变");
  }
  {
    // sendTelegram 未配置时静默跳过（旧契约）
    const r = await sendTelegram({}, "x");
    show(r.ok === false && r.skipped === true, "未配置 token/chat → skipped（旧契约）");
  }
}

async function testSafetyBoundaries() {
  console.log("▶ 安全边界与回执顺序回归");
  for (const [key, values] of [
    ["TG_CHAT_ID", ["abc", "0", " ", "1.5", "1e3", "0x100", "9007199254740992"]],
    ["TG_ALLOWED_USER_ID", ["abc", "0", " ", "-1", "1.5", "1e3", "9007199254740992"]],
  ]) {
    for (const value of values) {
      const fm = mockFetch(defaultRoutes());
      globalThis.fetch = fm;
      const kv = mockKV();
      const res = await handleTelegramWebhook(webhookRequest(messageUpdate({ text: "/checkin" }), secretHeader),
        { ...BASE_ENV, CHECKIN_KV: kv, [key]: value }, null, { checkin: () => assert.fail("非法配置不能执行") });
      show(res.status === 503 && fm.calls.length === 0 && kv._dump().size === 0, `${key}=${JSON.stringify(value)}：拒绝且无副作用`);
    }
  }
  {
    const fm = mockFetch(defaultRoutes());
    globalThis.fetch = fm;
    const kv = mockKV();
    const env = { ...BASE_ENV, CHECKIN_KV: kv };
    for (const text of ["/checkin123", "/checkin_extra", "/checkin!", "/checkin@bot/extra", "/checkin@", "prefix /checkin"]) {
      await handleTelegramWebhook(webhookRequest(messageUpdate({ text }), secretHeader), env, null, { checkin: () => assert.fail(text) });
    }
    show(fm.calls.length === 0 && kv._dump().size === 0, "未知命令不执行、不写去重键");
    await handleTelegramWebhook(webhookRequest(messageUpdate({ from: {}, text: "/checkin" }), secretHeader), env, null, { checkin: () => assert.fail("缺 sender") });
    show(fm.calls.length === 0, "缺 sender 的消息不执行");
  }
  for (const withContext of [false, true]) {
    const sequence = [], waits = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("answerCallbackQuery")) {
        sequence.push("answer:start");
        if (withContext) await gate;
        sequence.push("answer:done");
      } else sequence.push("message");
      return Response.json({ ok: true });
    };
    const env = { ...BASE_ENV, TG_CHAT_ID: "-100999", TG_ALLOWED_USER_ID: "999", CHECKIN_KV: mockKV() };
    const update = callbackUpdate({ message: { chat: { id: -100999 } } });
    const ctx = withContext ? { waitUntil: (p) => waits.push(p) } : null;
    const actions = { checkin: async () => { sequence.push("action"); return { ok: true }; } };
    const response = await handleTelegramWebhook(webhookRequest(update, secretHeader), env, ctx, actions);
    if (withContext) {
      show(response.status === 200 && !sequence.includes("action"), "ctx 模式先返回200，动作等待按钮回执");
      release();
      await Promise.all(waits);
    }
    show(sequence.indexOf("answer:done") < sequence.indexOf("action") && sequence.includes("action"), `有效群聊用户先回执再执行（ctx=${withContext}）`);
    await handleTelegramWebhook(webhookRequest(update, secretHeader), env, null, actions);
    show(sequence.filter((s) => s === "action").length === 1 && sequence.filter((s) => s === "answer:done").length === 2, "重复按钮仍回执但不重复动作");
    const fm = mockFetch(defaultRoutes());
    globalThis.fetch = fm;
    for (const data of ["checkin", "cmd:checkin-extra", "evil:checkin"]) {
      await handleTelegramWebhook(webhookRequest(callbackUpdate({ data }), secretHeader), { ...BASE_ENV, CHECKIN_KV: mockKV() }, null, actions);
    }
    show(fm.calls.length === 3 && fm.calls.every((c) => c.u.pathname.endsWith("answerCallbackQuery")), "未知按钮仅回执，不执行");
  }
  for (const operation of ["get", "put"]) {
    globalThis.fetch = mockFetch(defaultRoutes());
    const kv = mockKV();
    kv[operation] = async () => { throw new Error(BASE_ENV.TG_BOT_TOKEN); };
    const response = await handleTelegramWebhook(webhookRequest(messageUpdate({ text: "/checkin" }), secretHeader),
      { ...BASE_ENV, CHECKIN_KV: kv }, null, { checkin: () => assert.fail("KV失败不能执行") });
    show(response.status === 503 && !(await response.text()).includes(BASE_ENV.TG_BOT_TOKEN), `KV ${operation} 失败返回503且不泄密`);
  }
  {
    const fm = mockFetch(defaultRoutes());
    globalThis.fetch = fm;
    const req = new Request("https://hub.example.com/api/tg/setup", { method: "POST" });
    const noKv = await setupTelegramWebhook(req, BASE_ENV);
    const noUser = await setupTelegramWebhook(req, { ...BASE_ENV, CHECKIN_KV: mockKV(), TG_CHAT_ID: "-100999" });
    show(!noKv.ok && !noUser.ok && fm.calls.length === 0, "注册前检查 KV 和群聊白名单");
    globalThis.fetch = mockFetch({ ...defaultRoutes(), "POST /bot123456:ABC-DEF_secret-token-value/setMyCommands": tgFail("menu error") });
    const partial = await setupTelegramWebhook(req, { ...BASE_ENV, CHECKIN_KV: mockKV() });
    show(!partial.ok && partial.error.includes("Webhook 已注册"), "部分注册失败明确告知 Webhook 已更新");
  }
  {
    globalThis.fetch = mockFetch({ "*": tgOk({
      url: `https://user:old-password@hub.example.com/${BASE_ENV.TG_BOT_TOKEN}?secret=${secretHeader}#old-secret`,
      last_error_message: `callback failed ${secretHeader} https://hub.example.com/${BASE_ENV.TG_BOT_TOKEN}`,
    }) });
    const r = await getTelegramStatus(BASE_ENV);
    const output = JSON.stringify(r);
    show(r.ok && ![BASE_ENV.TG_BOT_TOKEN, secretHeader, "old-password", "old-secret"].some((secret) => output.includes(secret)), "旧 Webhook 地址和错误内容不泄露凭证");
    globalThis.fetch = mockFetch({ "*": tgFail(`failed ${secretHeader} ${BASE_ENV.TG_BOT_TOKEN}`) });
    const error = await telegramApi(BASE_ENV, "setWebhook", {});
    show(![secretHeader, BASE_ENV.TG_BOT_TOKEN].some((secret) => JSON.stringify(error).includes(secret)), "Telegram 错误对象整体脱敏（包括 data）");
  }
  {
    const kv = mockKV();
    kv._dump().set("channels", JSON.stringify([{ name: "旧配置" }, { name: "启用", enabled: true }, { name: "停用", enabled: false }]));
    const fm = mockFetch(defaultRoutes());
    globalThis.fetch = fm;
    await handleTelegramWebhook(webhookRequest(messageUpdate(), secretHeader), { ...BASE_ENV, CHECKIN_KV: kv }, null, {});
    show(fm.calls[0].body.text.includes("启用渠道：2 个"), "未显式 enabled 的旧渠道按启用统计");
  }
  {
    const fm = mockFetch(defaultRoutes());
    globalThis.fetch = fm;
    const value = "🙂<&>".repeat(1500);
    const html = `<b>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</b>`;
    const markup = { inline_keyboard: [[{ text: "状态", callback_data: "cmd:status" }]] };
    await sendTelegram(BASE_ENV, html, { reply_markup: markup });
    show(fm.calls.every((c) => !c.body.parse_mode && c.body.text.length <= 4096 && c.body.text.isWellFormed()), "超长 HTML 转纯文本，不切坏标签或 emoji");
    show(fm.calls.map((c) => c.body.text).join("") === value, "长消息转换后内容完整保留");
    show(fm.calls[0].body.reply_markup && fm.calls.slice(1).every((c) => !c.body.reply_markup), "长消息按钮只附在第一条");
    fm.calls.length = 0;
    await sendTelegram(BASE_ENV, "🙂".repeat(30000));
    show(fm.calls.length === 10 && fm.calls.at(-1).body.text.includes("已截断") && fm.calls.at(-1).body.text.isWellFormed(), "极长消息最多10条并明确截断");
  }
}

// ─────────── 运行 ───────────

const suites = [testFailClosed, testChatAndUserFilter, testCommandsAndButtons, testSetupAndStatus, testTelegramApi, testSafetyBoundaries];
let aborted = false;
for (const s of suites) {
  if (aborted) break;
  try {
    await s();
  } catch (e) {
    failures++;
    aborted = true;
    console.log(`\n  ✗ 套件中断：${e?.message || e}`);
    if (e instanceof SyntaxError || /does not provide an export|SyntaxError|Unexpected/.test(String(e))) {
      console.log("    提示：若报 timingSafeEqual 未导出，属预期——父代理将接线 auth.js 后重跑。");
    }
  }
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
