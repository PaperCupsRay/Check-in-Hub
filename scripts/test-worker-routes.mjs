import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { adapters } from "../src/adapters/index.js";
import { loadWorker, memoryKV } from "./test-helpers.mjs";

const {
  default: worker, runSelectedCheckin, runScheduled, batchCheckinCore,
  getTelegramChannelActionOptions, runTelegramChannelAction,
} = await loadWorker();
const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
const makeEnv = () => ({
  ACCESS_PASSWORD: "panel-password", CRON_SECRET: "runner-secret", GH_TOKEN: "gh-token", GH_REPO: "owner/repo",
  CHECKIN_KV: memoryKV({ proxies: [{ url: "http://alice:proxy-password@proxy.example.com:80", enabled: true, note: "test" }], channels: [] }),
});
function call(env, path, { method = "GET", body, login = false, secret, raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (login) headers["X-Access-Password"] = env.ACCESS_PASSWORD;
  if (secret) headers["X-Cron-Secret"] = secret;
  return worker.fetch(new Request("https://hub.example.com" + path, { method, headers, ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}) }), env);
}

test("所有管理/诊断/GitHub/TG 设置接口都在统一鉴权之后", async () => {
  const env = makeEnv();
  let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error("不应发起网络请求"); };
  const cases = [
    ["GET", "/api/proxies"], ["PUT", "/api/proxies"], ["POST", "/api/proxies/test"], ["GET", "/api/proxies/test"],
    ["POST", "/api/probe"], ["GET", "/api/gh/runs"], ["GET", "/api/gh/jobs/123"], ["GET", "/api/gh/joblog/123"],
    ["GET", "/api/gh/repo-secrets"], ["PUT", "/api/gh/repo-secrets"], ["POST", "/api/gh/dispatch"],
    ["POST", "/api/tg/test"], ["POST", "/api/tg/setup"], ["GET", "/api/tg/status"], ["GET", "/api/kv/channels"],
  ];
  for (const [method, path] of cases) assert.equal((await call(env, path, { method })).status, 401, method + " " + path);
  assert.equal(outbound, 0);
  assert.equal(env.CHECKIN_KV.writes.length, 0);
  assert.equal((await call(env, "/api/health")).status, 200);
  assert.equal((await call(env, "/")).status, 200);
});

test("登录发起检测 → secret 拉任务 → secret 回写 → 面板读取完整闭环", async () => {
  const env = makeEnv();
  const dispatched = [];
  globalThis.fetch = async (url, init) => { dispatched.push({ url, init }); return new Response(null, { status: 204 }); };
  const submitted = await call(env, "/api/proxies/test", { method: "POST", body: { all: true }, login: true });
  assert.equal(submitted.status, 202);
  const { job } = await submitted.json();
  assert.equal(job.status, "queued");
  assert.equal(dispatched.length, 1);
  assert.ok(!dispatched[0].init.body.includes("proxy-password"));
  const taskPath = `/api/proxies/test/task?id=${job.id}`;
  assert.equal((await call(env, taskPath)).status, 401);
  assert.equal((await call(env, taskPath, { login: true })).status, 401);
  assert.equal((await call(env, taskPath, { secret: "wrong" })).status, 401);
  const task = await call(env, taskPath, { secret: "runner-secret" });
  assert.equal(task.status, 200);
  assert.equal((await task.json()).job.proxies[0].url, "http://alice:proxy-password@proxy.example.com:80");
  const payload = { jobId: job.id, results: [{ id: "0", ok: true, ms: 100, ip: "203.0.113.1", tlsVerified: true, browserUsable: true, authUsed: "basic" }] };
  assert.equal((await call(env, "/api/proxies/test/result", { method: "POST", body: payload, login: true })).status, 401);
  const callback = await call(env, "/api/proxies/test/result", { method: "POST", body: payload, secret: "runner-secret" });
  assert.equal(callback.status, 200);
  assert.equal((await callback.json()).merged, 1);
  const current = await (await call(env, "/api/proxies", { login: true })).json();
  assert.equal(current.proxies[0].lastCheck.source, "github");
  assert.equal(current.proxies[0].url, "http://alice:***@proxy.example.com:80");
  const status = await (await call(env, "/api/proxies/test", { login: true })).json();
  assert.equal(status.job.status, "completed");
  assert.ok(!JSON.stringify(status).includes("proxy-password"));
});

test("代理路由严格处理坏 JSON/类型/runner，仍保留 Worker 单条诊断", async () => {
  const env = makeEnv();
  globalThis.fetch = async () => assert.fail("不应外发");
  for (const raw of ["{", "null", "[]", '"bad"']) assert.equal((await call(env, "/api/proxies/test", { method: "POST", login: true, raw })).status, 400);
  assert.equal((await call(env, "/api/proxies/test", { method: "POST", login: true, body: { runner: "invalid" } })).status, 400);
  assert.equal((await call(env, "/api/proxies/test/result", { method: "POST", secret: "runner-secret", raw: "{" })).status, 400);
  const diag = await call(env, "/api/proxies/test", { method: "POST", login: true, body: { url: "invalid" } });
  assert.equal(diag.status, 200);
  assert.equal((await diag.json()).result.ok, false);
});

test("开放面板也不会开放 runner 回调或 Telegram Webhook", async () => {
  const env = { ...makeEnv(), ACCESS_PASSWORD: "" };
  assert.equal((await call(env, "/api/proxies/test/task?id=bad")).status, 401);
  assert.equal((await call(env, "/api/proxies/test/result", { method: "POST", body: {} })).status, 401);
  assert.equal((await call(env, "/api/tg/webhook", { method: "POST", body: {} })).status, 503);
  Object.assign(env, { TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123", TG_WEBHOOK_SECRET: "secret_0123456789abcdef" });
  assert.equal((await call(env, "/api/tg/webhook", { method: "POST", body: {} })).status, 403);
});

test("Telegram 入口经 secret 鉴权触发代理任务，回写后推送且重投不重复分发", async () => {
  const env = { ...makeEnv(), TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123", TG_WEBHOOK_SECRET: "secret_0123456789abcdef" };
  const calls = [], waits = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).includes("api.github.com") ? new Response(null, { status: 204 }) : Response.json({ ok: true, result: {} });
  };
  const update = { update_id: 10, callback_query: { id: "cb-test", from: { id: 123 }, message: { chat: { id: 123 } }, data: "cmd:testproxies" } };
  const webhook = () => new Request("https://hub.example.com/api/tg/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.TG_WEBHOOK_SECRET }, body: JSON.stringify(update),
  });
  const response = await worker.fetch(webhook(), env, { waitUntil: (promise) => waits.push(promise) });
  assert.equal(response.status, 200);
  await Promise.all(waits);
  assert.ok(calls[0].url.endsWith("answerCallbackQuery"));
  const dispatch = calls.find((c) => c.body.event_type === "proxy-test");
  assert.ok(dispatch);
  const jobId = dispatch.body.client_payload.jobId;
  const callback = await call(env, "/api/proxies/test/result", {
    method: "POST", secret: "runner-secret", body: { jobId, results: [{ id: "0", ok: true, ms: 12, ip: "203.0.113.1", tlsVerified: true, browserUsable: true, authUsed: "basic" }] },
  });
  assert.equal(callback.status, 200);
  assert.equal((await callback.json()).merged, 1);
  assert.ok(calls.some((c) => c.body.text?.includes("代理检测完成")));
  const duplicate = await worker.fetch(webhook(), env);
  assert.equal(duplicate.status, 200);
  assert.equal(calls.filter((c) => c.body.event_type === "proxy-test").length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith("answerCallbackQuery")).length, 2);
  assert.ok(!JSON.stringify(calls.map((c) => c.body)).includes("proxy-password"));
});

test("面板登录后注册 Telegram Webhook 与命令，未配 KV 返回友好错误", async () => {
  const env = { ...makeEnv(), TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123", TG_WEBHOOK_SECRET: "secret_0123456789abcdef" };
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({ ok: true, result: true }); };
  const response = await call(env, "/api/tg/setup", { method: "POST", login: true });
  assert.equal(response.status, 200);
  assert.equal(calls[0].body.url, "https://hub.example.com/api/tg/webhook");
  assert.equal(calls[0].body.secret_token, env.TG_WEBHOOK_SECRET);
  assert.equal(calls[1].body.commands.length, 10);
  assert.ok(calls[1].body.commands.some((command) => command.command === "actions"));
  assert.ok(!(await response.text()).includes(env.TG_WEBHOOK_SECRET));
  const noKv = await call({ ...env, CHECKIN_KV: null }, "/api/tg/setup", { method: "POST", login: true });
  assert.equal(noKv.status, 400);
  assert.equal(calls.length, 2);
});

test("Telegram 失败重试与单渠道按钮只向 GitHub 分发目标启用渠道", async () => {
  const channels = [
    { id: "failed-id", name: "失败渠道", type: "sub2api", baseUrl: "https://failed.example", enabled: true, auth: { accessToken: "a" }, options: { runner: "gha_api" }, lastResult: { ok: false } },
    { id: "healthy-id", name: "正常渠道", type: "sub2api", baseUrl: "https://healthy.example", enabled: true, auth: { accessToken: "b" }, options: { runner: "gha_api" }, lastResult: { ok: true } },
    { id: "disabled-id", name: "停用失败渠道", type: "sub2api", baseUrl: "https://disabled.example", enabled: false, auth: { accessToken: "c" }, options: { runner: "gha_api" }, lastResult: { ok: false } },
  ];
  const env = { ...makeEnv(), TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123", TG_WEBHOOK_SECRET: "secret_0123456789abcdef" };
  env.CHECKIN_KV = memoryKV({ proxies: [], channels });
  const dispatched = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("api.github.com")) {
      const payload = JSON.parse(init.body).client_payload;
      dispatched.push(payload);
      return new Response(null, { status: 204 });
    }
    return Response.json({ ok: true, result: {} });
  };
  const webhook = (update) => new Request("https://hub.example.com/api/tg/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.TG_WEBHOOK_SECRET }, body: JSON.stringify(update),
  });
  const ctxRequest = async (update) => {
    const pending = [];
    const response = await worker.fetch(webhook(update), env, { waitUntil: (promise) => pending.push(promise) });
    assert.equal(response.status, 200);
    await Promise.all(pending);
  };

  await ctxRequest({ update_id: 21, message: { chat: { id: 123 }, from: { id: 123 }, text: "/retryfailed" } });
  assert.deepEqual(dispatched[0].names, ["失败渠道"]);
  assert.equal(env.CHECKIN_KV.read("channels").find((c) => c.id === "disabled-id")?.lastResult.ok, false);

  await ctxRequest({ update_id: 22, message: { chat: { id: 123 }, from: { id: 123 }, text: "/channels" } });
  const selectionEntry = [...env.CHECKIN_KV.data.entries()].find(([key]) => key.startsWith("tg_channel_action_"));
  assert.ok(selectionEntry);
  const [, token] = selectionEntry[0].split("tg_channel_action_");
  const selection = JSON.parse(selectionEntry[1]).selection;
  assert.equal(selection.name, "失败渠道");
  await ctxRequest({ update_id: 23, callback_query: { id: "single-channel", from: { id: 123 }, message: { chat: { id: 123 } }, data: `ch:${token}` } });
  assert.deepEqual(dispatched[1].names, ["失败渠道"]);
  assert.deepEqual(dispatched.map(x => x.runners), [["gha_api"], ["gha_api"]]);
});

test("定向签到报告只保留签到结论，不重复抽奖信息", async () => {
  const channel = {
    id: "lottery-id", name: "林夕", type: "sub2api", baseUrl: "https://lottery.example", enabled: true,
    auth: { accessToken: "test-token" }, options: { runner: "worker", autoLottery: true },
  };
  const env = { ...makeEnv(), TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123" };
  env.CHECKIN_KV = memoryKV({ proxies: [], channels: [channel] });
  const telegramBodies = [];
  const json = (body) => Response.json(body);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.telegram.org") {
      telegramBodies.push(JSON.parse(init.body ?? "{}"));
      return json({ ok: true, result: { message_id: 99 } });
    }
    if (u.pathname === "/api/v1/check-in") {
      return json({ code: 0, message: "success", data: { reward_amount: 2, balance_after: 3, current_streak: 4, total_check_in_days: 4, checked_in_today: false } });
    }
    if (u.pathname === "/api/v1/lottery/status") {
      return json({ code: 0, message: "success", data: {
        enabled: true, window_open: true, can_draw: true, title: "抽奖", description: "",
        activity_score: 0, activity_cap: 100, balance: 0, free_balance: 100,
        today_draws: 0, daily_draw_limit: 1, today_remaining: 1,
        costs: { activity: { enabled: false, amount: "0" }, free: { enabled: true, amount: "1" }, paid: { enabled: false, amount: "0" } },
      } });
    }
    if (u.pathname === "/api/v1/lottery") {
      return json({ code: 0, message: "success", data: {
        draw: { id: 1, user_id: 1, cost_type: "free", cost_paid: 0, cost_free: 1, cost_activity: 0, prize_type: "free", prize_amount: 10, prize_amount_actual: 10, status: "win" },
        activity_score: 0, balance: 0, free_balance: 99, today_draws: 1, today_remaining: 0,
      } });
    }
    throw new Error(`unexpected request ${u.pathname}`);
  };

  const result = await runSelectedCheckin(env, { selection: { id: "lottery-id", name: "林夕", type: "sub2api", baseUrl: "https://lottery.example" } });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].lottery?.ok, true);
  const report = telegramBodies.at(-1)?.text || "";
  assert.match(report, /📌 单渠道签到报告/);
  assert.match(report, /✅ <b>林夕<\/b>：签到成功/);
  assert.doesNotMatch(report, /抽奖|🎰/);
});

test("GHA 回传报告去除签到行里的抽奖摘要，结构化和旧浏览器结果都保留独立详情", async () => {
  const env = { ...makeEnv(), TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123" };
  const base = "刷新 token 后签到：签到成功，奖励 $300.00，余额 $73.26，连续 120 天，累计 120 天";
  const lottery = "抽奖 12 次：中奖 12 次，获得 免费额度 100×5、免费额度 30×6、$2.00×1，消耗 免费额度 1056，今日 12/12";
  const results = [
    { name: "林夕", ok: true, message: base + " · " + lottery, lottery: { ok: true, message: lottery } },
    { name: "浏览器", ok: true, message: "登录+签到：签到成功，余额 $73.26 · " + lottery },
  ];
  env.CHECKIN_KV = memoryKV({ channels: results.map(r => ({ name: r.name, enabled: true })), proxies: [] });
  const messages = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.telegram.org/"));
    messages.push(JSON.parse(init.body).text);
    return Response.json({ ok: true, result: {} });
  };
  const response = await call(env, "/api/gh/result", { method: "POST", body: { secret: env.CRON_SECRET, results } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).merged, 2);
  assert.equal(messages.length, 1);
  const lines = messages[0].split("\n");
  assert.equal(lines.find(line => line.startsWith("✅ <b>林夕</b>")), `✅ <b>林夕</b>：${base}`);
  assert.equal(lines.find(line => line.startsWith("✅ <b>浏览器</b>")), "✅ <b>浏览器</b>：登录+签到：签到成功，余额 $73.26");
  assert.equal(lines.filter(line => line.startsWith("🎰")).length, 2);
  assert.ok(lines.filter(line => line.startsWith("🎰")).every(line => line.includes(lottery)));
  // 仅清理报告呈现，原始抽奖记录仍留在 KV，执行结果不被篡改。
  assert.deepEqual(env.CHECKIN_KV.read("last_run").results.map(r => r.message), results.map(r => r.message));
});

test("定时签到、批量签到和面板单渠道推送共用去重逻辑，抽奖仍然执行一次", async () => {
  const channel = {
    id: "daily-id", name: "林夕", type: "sub2api", baseUrl: "https://daily.example", enabled: true,
    auth: { accessToken: "test-token" }, options: { runner: "worker", autoLottery: true },
  };
  for (const source of ["cron", "batch", "single"]) {
    const env = { ...makeEnv(), TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123" };
    env.CHECKIN_KV = memoryKV({ channels: [channel], proxies: [] });
    const messages = [];
    let draws = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.hostname === "api.telegram.org") {
        messages.push(JSON.parse(init.body).text);
        return Response.json({ ok: true, result: {} });
      }
      if (u.pathname === "/api/v1/check-in") return Response.json({ code: 0, message: "success", data: { reward_amount: 300, balance_after: 73.26, current_streak: 120, total_check_in_days: 120 } });
      if (u.pathname === "/api/v1/lottery/status") return Response.json({ code: 0, data: {
        enabled: true, window_open: true, can_draw: true, free_balance: 100, today_draws: 0, daily_draw_limit: 1, today_remaining: 1,
        costs: { free: { enabled: true, amount: "1" } },
      } });
      if (u.pathname === "/api/v1/lottery") {
        draws++;
        return Response.json({ code: 0, data: {
          draw: { id: 1, cost_type: "free", cost_free: 1, prize_type: "free", prize_amount: 10, prize_amount_actual: 10, status: "win" },
          today_draws: 1, today_remaining: 0, free_balance: 109,
        } });
      }
      assert.fail(`unexpected request ${u.pathname}`);
    };
    if (source === "cron") assert.equal((await runScheduled(env)).ok, true);
    else {
      const response = await call(env, source === "batch" ? "/api/batch" : "/api/checkin", {
        method: "POST", login: true, body: source === "batch" ? { channels: [channel] } : { channel },
      });
      assert.equal(response.status, 200);
    }
    assert.equal(draws, 1, source);
    assert.equal(messages.length, 1, source);
    const checkinLine = messages[0].split("\n").find(line => line.startsWith("✅ <b>林夕</b>"));
    assert.match(checkinLine, /奖励 \$300\.00，余额 \$73\.26/);
    assert.doesNotMatch(checkinLine, /抽奖|中奖|免费额度|🎰/);
    assert.equal(messages[0].split("\n").filter(line => line.startsWith("🎰")).length, 1, source);
  }
});

test("Cron reports preflight failures and retries transient Telegram delivery", async () => {
  const env = { TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123" };
  const messages = [];
  let sends = 0;
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(String(url).includes("api.telegram.org"));
    sends++;
    messages.push(JSON.parse(init.body).text);
    if (sends === 1) return Response.json({ ok: false, description: "temporary unavailable" }, { status: 503 });
    return Response.json({ ok: true, result: {} });
  };
  let task;
  worker.scheduled({}, env, { waitUntil(promise) { task = promise; } });
  assert.ok(task instanceof Promise);
  const result = await task;
  assert.equal(result.ok, false);
  assert.equal(sends, 2);
  assert.match(messages[0], /定时签到任务异常/);
  assert.match(messages[1], /CHECKIN_KV not bound/);
});

test("Worker batch check-in uses no default retries and skips exhausted subrequest fallback", async () => {
  const previous = adapters.fixture;
  let checks = 0;
  let statuses = 0;
  adapters.fixture = {
    fields: [],
    checkin: async () => {
      checks++;
      return { ok: false, message: "Too many subrequests by single Worker invocation" };
    },
    status: async () => {
      statuses++;
      throw new Error("subrequest limit is exhausted");
    },
  };
  try {
    const [outcome] = await batchCheckinCore([{
      name: "fixture",
      type: "fixture",
      baseUrl: "https://fixture.example",
      auth: {},
      options: {},
    }], { GH_TOKEN: "must-not-dispatch", GH_REPO: "owner/repo" });
    assert.equal(checks, 1);
    assert.equal(statuses, 0);
    assert.equal(outcome.via, "worker");
    assert.equal(outcome.result.attempts, 1);
    assert.match(outcome.result.message, /Too many subrequests/);
  } finally {
    if (previous) adapters.fixture = previous;
    else delete adapters.fixture;
  }
});

test("Telegram actions use live channel configuration and expose every declared adapter action", async () => {
  const env = makeEnv();
  const channels = [
    { id: "sub-id", name: "Sub", type: "sub2api", baseUrl: "https://sub.example", enabled: true, auth: { accessToken: "private-access-token" } },
    { id: "linux-id", name: "Linux", type: "linuxsb", baseUrl: "https://linux.example", enabled: true, auth: { cookie: "session=private-cookie" } },
    { id: "onyx-id", name: "Onyx", type: "onyxaxis", baseUrl: "https://onyx.example", enabled: true, auth: { cookie: "session=private-cookie" } },
  ];
  channels[0].lastResult = {
    action: "me", ok: true, at: 12345, summary: "balance 10 private-access-token https://private.example/path",
    data: { tokens: { accessToken: "must-not-read-this" }, raw: { private: "raw-data" } },
  };
  env.CHECKIN_KV = memoryKV({ channels });
  for (const [target, action] of [["sub-id", "lottery"], ["linux-id", "gacha"], ["onyx-id", "claim"]]) {
    const options = await getTelegramChannelActionOptions(env, target);
    assert.equal(options.ok, true);
    assert.ok(options.actions.some((item) => item.action === action));
    assert.ok(options.actions.some((item) => item.action === "me"));
    assert.ok(options.actions.some((item) => item.action === "status"));
  }
  const options = await getTelegramChannelActionOptions(env, "sub-id");
  assert.match(options.lastResult.summary, /balance 10/);
  assert.doesNotMatch(JSON.stringify(options), /private-access-token|private\.example|must-not-read-this|raw-data/);
  assert.equal("data" in options.lastResult, false);
  assert.equal(env.CHECKIN_KV.writes.length, 0);

  const current = env.CHECKIN_KV.read("channels");
  current[0].enabled = false;
  await env.CHECKIN_KV.put("channels", JSON.stringify(current));
  assert.equal((await getTelegramChannelActionOptions(env, "sub-id")).ok, false);
  assert.equal((await runTelegramChannelAction(env, "sub-id", "me")).ok, false);
  assert.equal((await runTelegramChannelAction(env, "missing-id", "me")).ok, false);
});

test("Telegram declared actions preserve only rotated tokens and remove credentials and raw results", async () => {
  const previous = adapters.fixture;
  const oldAccess = "old-private-access";
  const rotatedAccess = "rotated-private-access";
  const cookie = "session=private-cookie";
  const longToken = "long-secret-".repeat(130);
  const shortPassword = "xy";
  const lastResult = { ok: false, action: "checkin", summary: "preserved", at: 2 };
  const env = makeEnv();
  env.CHECKIN_KV = memoryKV({ channels: [{
    id: "fixture-id", name: "Fixture", type: "fixture", baseUrl: "https://fixture.example", enabled: true,
    auth: { accessToken: oldAccess, cookie, refreshToken: longToken, password: shortPassword }, options: {}, lastResult,
  }] });
  const calls = [];
  adapters.fixture = {
    actions: [{ action: "bonus", label: "Bonus" }],
    me: async (channel) => {
      calls.push(["me", channel.auth.accessToken]);
      return {
        ok: true, message: `balance ${longToken} ${oldAccess} ${rotatedAccess} ${cookie} ${shortPassword} https://private.example`,
        user: {
          quota: 2000000, usedQuota: 100000, raw: { quota_per_unit: 250000, private: "raw-data" },
          nested: { accessToken: rotatedAccess },
          deeply: { first: { second: { third: { fourth: { fifth: { private: oldAccess } } } } } },
        },
        tokens: { accessToken: rotatedAccess }, raw: { private: "raw-data" },
      };
    },
    bonus: async () => {
      calls.push(["bonus"]);
      return { ok: true, message: "Bonus claimed", result: { reward: 10, raw: { private: "raw-data" } } };
    },
    login: async () => assert.fail("undeclared action must not execute"),
  };
  try {
    const balance = await runTelegramChannelAction(env, { id: "fixture-id" }, "me");
    assert.equal(balance.ok, true);
    assert.equal(balance.user.quota, 2000000);
    assert.equal(balance.user.quotaPerUnit, 250000);
    assert.doesNotMatch(JSON.stringify(balance), /old-private-access|rotated-private-access|private-cookie|private\.example|raw-data|accessToken|long-secret-|xy/);
    assert.equal("tokens" in balance, false);
    assert.equal("raw" in balance, false);
    assert.equal(env.CHECKIN_KV.read("channels")[0].auth.accessToken, rotatedAccess);
    assert.deepEqual(env.CHECKIN_KV.read("channels")[0].lastResult, lastResult);
    const writeCount = env.CHECKIN_KV.writes.length;
    const bonus = await runTelegramChannelAction(env, "fixture-id", "bonus");
    assert.equal(bonus.ok, true);
    assert.deepEqual(bonus.result, { reward: 10 });
    assert.equal(env.CHECKIN_KV.writes.length, writeCount);
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "login")).ok, false);
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "checkin")).ok, false);
    adapters.fixture.actions = [];
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "bonus")).ok, false);
    assert.deepEqual(calls, [["me", oldAccess], ["bonus"]]);
  } finally {
    if (previous) adapters.fixture = previous;
    else delete adapters.fixture;
  }
});

test("Telegram legacy selections must uniquely match a current enabled channel", async () => {
  const previous = adapters.fixture;
  let calls = 0;
  adapters.fixture = { actions: [], me: async () => { calls++; return { ok: true, user: { quota: 1 } }; } };
  const legacy = { name: "Legacy", type: "fixture", baseUrl: "https://legacy.example", enabled: true, auth: {} };
  const env = makeEnv();
  env.CHECKIN_KV = memoryKV({ channels: [legacy] });
  const target = { name: legacy.name, type: legacy.type, baseUrl: legacy.baseUrl };
  try {
    assert.equal((await runTelegramChannelAction(env, target, "me")).ok, true);
    assert.equal((await runTelegramChannelAction(env, { ...target, baseUrl: "https://wrong.example" }, "me")).ok, false);
    await env.CHECKIN_KV.put("channels", JSON.stringify([legacy, { ...legacy }]));
    assert.equal((await runTelegramChannelAction(env, target, "me")).ok, false);
    await env.CHECKIN_KV.put("channels", JSON.stringify([{ ...legacy, id: "now-has-id" }]));
    assert.equal((await runTelegramChannelAction(env, target, "me")).ok, false);
    assert.equal(calls, 1);
  } finally {
    if (previous) adapters.fixture = previous;
    else delete adapters.fixture;
  }
});

test("Telegram token rotation merges into latest KV without reverting concurrent config or credentials", async () => {
  const previous = adapters.fixture;
  const env = makeEnv();
  env.CHECKIN_KV = memoryKV({ channels: [{
    id: "fixture-id", name: "Original", type: "fixture", baseUrl: "https://fixture.example", enabled: true,
    auth: { accessToken: "old-access", cookie: "old-cookie" }, options: {}, lastResult: { summary: "keep" },
  }] });
  adapters.fixture = {
    actions: [],
    me: async () => {
      const current = env.CHECKIN_KV.read("channels");
      current[0].name = "Edited while running";
      current[0].options = { retryCount: 4 };
      current[0].auth.cookie = "manually-updated-cookie";
      await env.CHECKIN_KV.put("channels", JSON.stringify(current));
      return { ok: true, tokens: { accessToken: "rotated-access", cookie: "stale-returned-cookie" } };
    },
  };
  try {
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "me")).ok, true);
    const stored = env.CHECKIN_KV.read("channels")[0];
    assert.equal(stored.name, "Edited while running");
    assert.deepEqual(stored.options, { retryCount: 4 });
    assert.equal(stored.auth.accessToken, "rotated-access");
    assert.equal(stored.auth.cookie, "manually-updated-cookie");
    assert.deepEqual(stored.lastResult, { summary: "keep" });
  } finally {
    if (previous) adapters.fixture = previous;
    else delete adapters.fixture;
  }
});

test("Telegram lottery revalidates availability, mode, batch cap and fresh tokens before spending", async () => {
  const previous = adapters.fixture;
  const env = makeEnv();
  env.CHECKIN_KV = memoryKV({ channels: [{
    id: "fixture-id", name: "Lottery", type: "fixture", baseUrl: "https://fixture.example", enabled: true,
    auth: { accessToken: "old-private-access" }, options: { lotteryCost: "free" },
  }] });
  const draws = [];
  const requestIds = [];
  let infoCalls = 0;
  let available = 10;
  let canDraw = true;
  let mode = "free";
  adapters.fixture = {
    actions: [{ action: "lottery", label: "Lottery", count: {} }],
    lotteryInfo: async () => {
      infoCalls++;
      return {
        ok: true, message: "Lottery status",
        result: { canDraw, maxDraws: available, costMode: mode },
        tokens: { accessToken: "fresh-private-access" },
      };
    },
    lottery: async (channel, extra) => {
      assert.equal(channel.auth.accessToken, "fresh-private-access");
      draws.push(extra.count);
      requestIds.push(extra.requestId);
      return { ok: true, message: "Lottery completed", result: { count: extra.count } };
    },
  };
  try {
    const requestId = "a".repeat(32);
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "lottery", { count: 9, costMode: "free", requestId })).result.count, 5);
    assert.equal(requestIds[0], requestId);
    for (const invalid of ["bad", "a".repeat(33), 123, {}, "A".repeat(32)]) {
      assert.equal((await runTelegramChannelAction(env, "fixture-id", "lottery", { count: 1, costMode: "free", requestId: invalid })).ok, false);
    }
    available = 1;
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "lottery", { count: 3, costMode: "free" })).ok, false);
    canDraw = false;
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "lottery", { count: 1, costMode: "free" })).ok, false);
    canDraw = true;
    for (const count of [undefined, 0, -1, 1.5, NaN, "bad"]) {
      assert.equal((await runTelegramChannelAction(env, "fixture-id", "lottery", { count, costMode: "free" })).ok, false);
    }
    const current = env.CHECKIN_KV.read("channels");
    current[0].options.lotteryCost = "all";
    await env.CHECKIN_KV.put("channels", JSON.stringify(current));
    const priorInfoCalls = infoCalls;
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "lottery", { count: 1, costMode: "free" })).ok, false);
    assert.equal(infoCalls, priorInfoCalls);
    mode = "all";
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "lottery", { count: 1, costMode: "all" })).ok, true);
    adapters.fixture.actions = [];
    assert.equal((await runTelegramChannelAction(env, "fixture-id", "lotteryInfo")).ok, false);
    assert.equal(infoCalls, priorInfoCalls + 1);
    assert.deepEqual(draws, [5, 1]);
  } finally {
    if (previous) adapters.fixture = previous;
    else delete adapters.fixture;
  }
});

test("Telegram actions webhook exposes balances, extra adapter actions, lottery confirmation and safe logs", async () => {
  const env = {
    ...makeEnv(), TG_BOT_TOKEN: "123:fake-token", TG_CHAT_ID: "123", TG_WEBHOOK_SECRET: "secret_0123456789abcdef",
  };
  env.CHECKIN_KV = memoryKV({ channels: [
    {
      id: "sub-id", name: "Sub", type: "sub2api", baseUrl: "https://sub.example", enabled: true,
      auth: { accessToken: "private-sub-access" }, options: { lotteryCost: "free" },
      lastResult: { ok: true, action: "me", summary: "Balance summary private-sub-access", at: 12345, data: { raw: { secret: "private-raw-result" } } },
    },
    { id: "linux-id", name: "Linux", type: "linuxsb", baseUrl: "https://linux.example", enabled: true, auth: { cookie: "session=private-linux-cookie" } },
    { id: "onyx-id", name: "Onyx", type: "onyxaxis", baseUrl: "https://onyx.example", enabled: true, auth: { cookie: "obsidian_session=private-onyx-cookie" } },
    { id: "disabled-id", name: "Disabled", type: "sub2api", baseUrl: "https://disabled.example", enabled: false },
  ] });
  const telegram = [];
  const siteCalls = [];
  let remaining = 3;
  let draws = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.telegram.org") {
      telegram.push({ method: parsed.pathname.split("/").at(-1), body: JSON.parse(init.body || "{}") });
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    siteCalls.push({ host: parsed.hostname, path: parsed.pathname, init });
    if (parsed.hostname === "sub.example") {
      if (parsed.pathname === "/api/v1/auth/me") {
        assert.equal(init.headers.Authorization, "Bearer private-sub-access");
        return Response.json({ code: 0, data: { balance: 12.5, raw: "private-raw-result" } });
      }
      if (parsed.pathname === "/api/v1/lottery/status") return Response.json({ code: 0, data: {
        enabled: true, can_draw: true, window_open: true, daily_draw_limit: 3, today_draws: 3 - remaining,
        today_remaining: remaining, free_balance: 100, costs: { free: { enabled: true, amount: "1" } },
      } });
      if (parsed.pathname === "/api/v1/lottery") {
        draws++;
        remaining--;
        return Response.json({ code: 0, data: {
          draw: { id: draws, status: "win", prize_type: "free", prize_amount: 10, prize_amount_actual: 10, cost_type: "free", cost_free: 1 },
          today_draws: 3 - remaining, today_remaining: remaining, free_balance: 109,
        } });
      }
    }
    if (parsed.hostname === "linux.example") {
      if (parsed.pathname === "/") return new Response('<a href="/daily_checkin">Daily</a><div class="user-name">Tester</div><input name="_csrf" value="csrf-private">');
      if (parsed.pathname === "/gacha_pull" && init.method === "POST") return new Response(null, { status: 302, headers: { Location: "/gacha_pull?result=private-result" } });
      if (parsed.pathname === "/gacha_pull") return new Response('<div class="gacha-result-card"><div class="gacha-result-rarity">R</div><div class="gacha-result-name">Test title</div></div>');
    }
    if (parsed.hostname === "onyx.example" && parsed.pathname === "/api/checkin") return Response.json({
      enabled: true, streak: 1, month_count: 1, rules: [{ id: "rule-five", title: "Five day reward", progress: 1, days: 5, claimable: false }],
    });
    assert.fail(`unexpected fixture request ${parsed.pathname}`);
  };
  let updateId = 1000;
  const submit = async (payload) => {
    const pending = [];
    const response = await worker.fetch(new Request("https://hub.example.com/api/tg/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", ["X-" + "Telegram" + "-Bot-Api-Secret-Token"]: env.TG_WEBHOOK_SECRET },
      body: JSON.stringify({ update_id: updateId++, ...payload }),
    }), env, { waitUntil: (promise) => pending.push(promise) });
    assert.equal(response.status, 200);
    await Promise.all(pending);
  };
  const callback = (data) => submit({ callback_query: { id: `callback-${updateId}`, from: { id: 123 }, message: { message_id: 77, chat: { id: 123 } }, data } });
  const buttons = () => telegram.filter((call) => call.body.reply_markup).at(-1).body.reply_markup.inline_keyboard.flat();
  const open = async (name) => {
    await submit({ message: { chat: { id: 123 }, from: { id: 123 }, text: "/actions" } });
    assert.equal(buttons().some((button) => button.text === "Disabled"), false);
    const channel = buttons().find((button) => button.text === name);
    assert.ok(channel);
    assert.ok(channel.callback_data.startsWith("ac:"));
    await callback(channel.callback_data);
  };

  await open("Sub");
  const balance = buttons().find((button) => button.text === "余额");
  await callback(balance.callback_data);
  assert.match(telegram.at(-1).body.text, /\$12\.50/);
  await callback(balance.callback_data);
  assert.equal(siteCalls.filter((call) => call.path === "/api/v1/auth/me").length, 1);
  await open("Sub");
  await callback(buttons().find((button) => button.text.includes("最近日志")).callback_data);
  assert.match(telegram.at(-1).body.text, /Balance summary/);

  await open("Linux");
  await callback(buttons().find((button) => button.text === "抽称号").callback_data);
  assert.match(telegram.at(-1).body.text, /Test title/);
  assert.equal(siteCalls.filter((call) => call.path === "/gacha_pull" && call.init.method === "POST").length, 1);
  await open("Onyx");
  await callback(buttons().find((button) => button.text === "领里程碑").callback_data);
  assert.match(telegram.at(-1).body.text, /Five day reward 1\/5/);

  await open("Sub");
  await callback(buttons().find((button) => button.text === "抽奖").callback_data);
  assert.match(telegram.at(-1).body.text, /免费额度/);
  const three = buttons().find((button) => button.text === "3 次");
  assert.ok(three);
  remaining = 1;
  await callback(three.callback_data);
  assert.equal(draws, 0);
  assert.match(telegram.at(-1).body.text, /最多可抽 1/);
  await open("Sub");
  await callback(buttons().find((button) => button.text === "抽奖").callback_data);
  const one = buttons().find((button) => button.text === "1 次");
  assert.ok(one);
  await callback(one.callback_data);
  assert.equal(draws, 1);
  assert.match(telegram.at(-1).body.text, /抽奖 1 次/);
  await callback(one.callback_data);
  assert.equal(draws, 1);
  const output = JSON.stringify(telegram.map((call) => call.body));
  assert.doesNotMatch(output, /private-sub-access|private-linux-cookie|private-onyx-cookie|private-raw-result|csrf-private|sub\.example|linux\.example|onyx\.example/);
});
