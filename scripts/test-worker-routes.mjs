import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { loadWorker, memoryKV } from "./test-helpers.mjs";

const { default: worker, runSelectedCheckin } = await loadWorker();
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
  assert.equal(calls[1].body.commands.length, 9);
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
