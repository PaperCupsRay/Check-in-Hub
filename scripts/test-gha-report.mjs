/** Offline GHA handoff/callback regression: node scripts/test-gha-report.mjs.
 * All credentials are synthetic; fetch is blocked unless explicitly mocked.
 */
import assert from "node:assert/strict";
import { test, beforeEach, afterEach, after } from "node:test";
import { loadWorker, memoryKV } from "./test-helpers.mjs";
import { formatCheckinReport } from "../src/tg.js";
import { adapters } from "../src/adapters/index.js";

const nativeFetch = globalThis.fetch;
const blockedFetch = async () => assert.fail("Unexpected outbound request: test must mock fetch");
globalThis.fetch = blockedFetch;
const fakeHub = "https://mock.hub.invalid";
const fakeSecret = "mock-runner-secret";
const fakePassword = "mock-panel-password";
const envOverrides = { HUB_BASE_URL: fakeHub, HUB_SECRET: fakeSecret, HUB_ACCESS_PASSWORD: fakePassword };
const oldEnv = Object.fromEntries(Object.keys(envOverrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, envOverrides);
let gha;
try {
  // The ESM main guard must prevent import from fetching channels or writing artifacts.
  gha = await import("./gha-checkin.mjs");
} finally {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
const { runOne, report, dispatchBrowserFallback, reportWithBrowserFallback } = gha;
const { default: worker, batchCheckinCore, runScheduled, runSelectedCheckin } = await loadWorker();
const originalNewapi = adapters.newapi;
beforeEach(() => { globalThis.fetch = blockedFetch; });
afterEach(() => { globalThis.fetch = blockedFetch; adapters.newapi = originalNewapi; });
after(() => { globalThis.fetch = nativeFetch; });

const channel = (name = "Future API", type = "newapi", runner = "gha_api", auth = {}) => ({
  name, type, baseUrl: "https://checkin.invalid", auth, options: { runner },
});
const failure = (extra = {}) => ({
  name: "Future API", type: "newapi", runner: "gha_api", ok: false,
  needsBrowser: true, message: "Turnstile token为空", attempts: 1, maxAttempts: 3,
  newTokens: { userId: "42", authSession: "" }, ...extra,
});
const makeEnv = (channels = [channel()]) => ({
  ACCESS_PASSWORD: fakePassword, CRON_SECRET: fakeSecret,
  GH_TOKEN: "mock-github-token", GH_REPO: "mock-owner/mock-repo",
  TG_BOT_TOKEN: "123:mock-tg-token", TG_CHAT_ID: "456",
  CHECKIN_KV: memoryKV({ channels }),
});
const callback = (env, results, secret = fakeSecret) => worker.fetch(new Request(`${fakeHub}/api/gh/result`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret, results }),
}), env);
const apiCall = (env, path, body) => worker.fetch(new Request(`${fakeHub}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Access-Password": fakePassword },
  body: JSON.stringify(body),
}), env);
function mockWorkerOutbound(env, { githubStatus = 204, onDispatch = async () => {} } = {}) {
  const calls = [], messages = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path: u.pathname, body });
    if (u.origin === fakeHub && ["/api/gh/result", "/api/gh/dispatch"].includes(u.pathname)) {
      return worker.fetch(new Request(url, init), env);
    }
    if (u.hostname === "api.github.com" && u.pathname === "/repos/mock-owner/mock-repo/dispatches") {
      await onDispatch(body.client_payload);
      return githubStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ message: "mock unavailable" }, { status: githubStatus });
    }
    if (u.hostname === "api.telegram.org" && u.pathname.endsWith("/sendMessage")) {
      messages.push(body.text);
      return Response.json({ ok: true, result: {} });
    }
    return blockedFetch();
  };
  return { calls, messages };
}

test("runOne preserves refreshed tokens, retry metadata, quota and lottery without another HTTP retry", async () => {
  const tokens = { accessToken: "mock-access", userId: "42", authSession: "" };
  const lottery = { ok: true, message: "抽奖 1 次：mock reward" };
  for (const ok of [true, false]) {
    let actionCalls = 0;
    const input = channel();
    input.options.apiOnly = true;
    const r = await runOne(input, "gha_api", async (type, action, active) => {
      actionCalls++;
      assert.equal(type, "newapi");
      assert.equal(action, "checkin");
      assert.equal(active, input);
      return { ok, message: ok ? "签到成功" : "HTTP 503", tokens, attempts: 3, maxAttempts: 3,
        result: { reward: 50, lottery }, user: { quota: 25000000, username: "mock-user" } };
    });
    assert.equal(actionCalls, 1);
    assert.equal(r.ok, ok);
    assert.deepEqual(r.newTokens, tokens);
    assert.equal(r.attempts, 3);
    assert.equal(r.maxAttempts, 3);
    assert.equal(r.apiOnly, true);
    assert.equal(r.quotaInfo.lastReward, 50);
    assert.deepEqual(r.lottery, lottery);
  }
});

test("API-only persists pending before dispatch and cannot overwrite an immediate browser success", async () => {
  const env = makeEnv([channel(), channel("Regular browser", "sub2api", "gha_browser")]);
  const { calls, messages } = mockWorkerOutbound(env, { onDispatch: async (payload) => {
    assert.deepEqual(payload.runners, ["gha_browser"]);
    assert.deepEqual(payload.names, ["Future API", "Regular browser"]);
    const stored = env.CHECKIN_KV.read("channels")[0];
    assert.equal(stored.lastResult.pending, true);
    assert.equal(stored.lastResult.ok, false);
    assert.equal(stored.auth.userId, "42");
    assert.equal(stored.auth.authSession, "");
    await callback(env, [{ name: "Future API", ok: true, runner: "gha_browser", pending: false, message: "签到成功 $50" }]);
  } });
  let artifact;
  const input = failure();
  const result = await reportWithBrowserFallback([input], ["gha_api"], ["Regular browser"], {
    writeFallback: (names) => { artifact = names; },
  });
  assert.deepEqual(artifact, []);
  assert.equal(result[0].pending, true);
  assert.equal(result[0].ok, false);
  assert.match(result[0].message, /^HTTP通道未完成，正在自动转浏览器，等待最终结果/);
  assert.ok(result[0].message.includes(input.message));
  assert.equal(result[0].attempts, 1);
  assert.deepEqual(result[0].newTokens, input.newTokens);
  assert.equal(input.pending, undefined);
  const paths = calls.filter((c) => ["/api/gh/result", "/api/gh/dispatch"].includes(c.path)).map((c) => c.path);
  assert.deepEqual(paths, ["/api/gh/result", "/api/gh/dispatch"]);
  assert.match(messages[0], /成功 0\/1 · 待确认1/);
  assert.match(messages[0], /⏳ <b>Future API<\/b>/);
  assert.ok(!messages[0].includes("❌"));
  assert.match(messages[1], /成功 1\/1/);
  assert.ok(!messages[1].includes("待确认"));
  assert.equal(env.CHECKIN_KV.read("channels")[0].lastResult.pending, false);
  assert.equal(env.CHECKIN_KV.read("channels")[0].lastResult.ok, true);
});

test("apiOnly channels keep gha_api failures terminal instead of dispatching browsers", async () => {
  const env = makeEnv();
  const { calls, messages } = mockWorkerOutbound(env);
  const input = { ...failure({ needsBrowser: false, message: "HTTP 403" }), apiOnly: true };
  let fallbackList;
  const result = await reportWithBrowserFallback([input], ["gha_api"], [], {
    writeFallback: (names) => { fallbackList = names; },
  });
  assert.deepEqual(fallbackList, []);
  assert.equal(result[0].pending, undefined);
  assert.equal(result[0].message, "HTTP 403");
  assert.equal(calls.some((call) => call.path === "/api/gh/dispatch"), false);
  assert.ok(messages[0].includes("❌ <b>Future API</b>"));
});

test("failed independent dispatch reports only affected channels as terminal failures", async () => {
  const env = makeEnv([channel(), channel("Healthy")]);
  const { calls, messages } = mockWorkerOutbound(env, { githubStatus: 503 });
  const good = { name: "Healthy", type: "newapi", runner: "gha_api", ok: true, message: "今日已签" };
  const result = await reportWithBrowserFallback([failure(), good], ["gha_api"], [], { writeFallback: () => {} });
  assert.equal(result[0].pending, false);
  assert.equal(result[0].ok, false);
  assert.match(result[0].message, /浏览器任务启动失败/);
  assert.match(result[0].message, /Turnstile token为空/);
  assert.equal(result[1], good);
  const reports = calls.filter((c) => c.path === "/api/gh/result");
  assert.equal(reports.length, 2);
  assert.equal(reports[0].body.results[0].pending, true);
  assert.deepEqual(reports[1].body.results.map((r) => r.name), ["Future API"]);
  assert.equal(reports[1].body.results[0].pending, false);
  assert.match(messages[0], /待确认1/);
  assert.match(messages[1], /❌ <b>Future API<\/b>：HTTP通道未完成，浏览器任务启动失败/);
  assert.ok(!messages[1].includes("⏳"));
  assert.equal(env.CHECKIN_KV.read("channels")[0].lastResult.pending, false);
});

test("same-run browser uses artifact handoff only for supported, non-permanent API failures", async () => {
  const input = [failure(), failure({ name: "Transient", needsBrowser: false, message: "HTTP 503", attempts: 3 }),
    failure({ name: "Unsupported", type: "agentrouter" }),
    failure({ name: "Permanent", needsBrowser: false, message: "密码错误" }),
    failure({ name: "Browser failed", runner: "gha_browser" })];
  let artifact, reports = 0;
  const result = await reportWithBrowserFallback(input, ["gha_api", "gha_browser"], [], {
    writeFallback: (names) => { artifact = names; },
    reportResults: async (r) => { reports++; assert.equal(r[0].pending, true); return true; },
    dispatch: async () => assert.fail("same-run must not reverse-dispatch"),
  });
  assert.deepEqual(artifact, ["Future API", "Transient"]);
  assert.equal(reports, 1);
  assert.equal(result[1].pending, true);
  assert.ok(result.slice(2).every((r) => !r.pending));
});

test("permanent credential/status/code failures and unsupported types never become pending or dispatch", async () => {
  const rawResults = [
    { message: "密码错误" }, { message: "invalid access token" }, { message: "缺少凭证" },
    { message: "endpoint unavailable", httpStatus: 404 }, { message: "denied", httpStatus: 401 },
    { message: "denied", httpStatus: 403 }, { message: "revoked", raw: { code: "AUTH_SESSION_REVOKED" } },
    { message: "final failure", retryable: false },
  ];
  const results = [];
  for (const raw of rawResults) {
    results.push(await runOne(channel(), "gha_api", async () => ({ ok: false, attempts: 1, maxAttempts: 3, ...raw })));
  }
  results.push(failure({ type: "agentrouter" }));
  let reports = 0;
  const reported = await reportWithBrowserFallback(results, ["gha_api"], [], {
    writeFallback: (names) => assert.deepEqual(names, []),
    reportResults: async () => { reports++; return true; },
    dispatch: async () => assert.fail("permanent/unsupported failure must not dispatch"),
  });
  assert.equal(reports, 1);
  assert.ok(reported.every((r) => !r.pending && !r.ok));
});

test("dispatch returns a real boolean requiring HTTP and business success, including malformed/throwing responses", async () => {
  for (const [status, body, expected] of [[200, { ok: true }, true], [200, { ok: false }, false],
    [503, { ok: true }, false], [401, { ok: false }, false], [200, {}, false]]) {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), `${fakeHub}/api/gh/dispatch`);
      assert.deepEqual(JSON.parse(init.body), { runners: ["gha_browser"], names: ["Future API"] });
      return Response.json(body, { status });
    };
    const value = await dispatchBrowserFallback(["Future API"]);
    assert.equal(typeof value, "boolean");
    assert.equal(value, expected);
  }
  globalThis.fetch = async () => new Response("not json", { status: 200 });
  assert.equal(await dispatchBrowserFallback(["Future API"]), false);
  globalThis.fetch = async () => { throw new Error("mock connection refused"); };
  assert.equal(await dispatchBrowserFallback(["Future API"]), false);
});

test("report failures prevent a newer independent run from starting before persistence", async () => {
  for (const [status, body] of [[503, { ok: true }], [200, { ok: false }]]) {
    globalThis.fetch = async () => Response.json(body, { status });
    await assert.rejects(report([failure()]), /回传结果失败/);
  }
  await assert.rejects(reportWithBrowserFallback([failure()], ["gha_api"], [], {
    writeFallback: () => {}, reportResults: async () => { throw new Error("mock persist failure"); },
    dispatch: async () => assert.fail("dispatch cannot precede persistence"),
  }), /mock persist failure/);
  const reports = [];
  const result = await reportWithBrowserFallback([failure()], ["gha_api"], [], {
    writeFallback: () => {}, reportResults: async (r) => { reports.push(r); return false; },
    dispatch: async () => assert.fail("skipped persistence cannot dispatch"),
  });
  assert.equal(reports.length, 2);
  assert.equal(result[0].pending, false);
});

test("TG pending/degraded stats do not count unconfirmed placeholders as success and preserve escaping/lottery splitting", () => {
  const reportText = formatCheckinReport("Report <x>", [
    { name: "Good", ok: true, message: "签到成功" },
    { name: "Pending <&>", ok: false, pending: true, message: "等待 <result> · 抽奖 1 次：奖励<&>" },
    { name: "Old placeholder", ok: true, degraded: true, message: "已分发" },
    { name: "Bad", ok: false, message: "密码错误" },
  ], "extra <&>");
  assert.match(reportText, /成功 1\/4 · 待确认2 · extra &lt;&amp;&gt;/);
  assert.match(reportText, /⏳ <b>Pending &lt;&amp;&gt;<\/b>：等待 &lt;result&gt;/);
  assert.match(reportText, /⏳ <b>Old placeholder<\/b>/);
  assert.equal(reportText.split("❌").length - 1, 1);
  assert.equal(reportText.split("抽奖 1 次").length - 1, 1);
  assert.match(reportText, /🎰 <b>Pending &lt;&amp;&gt;<\/b> 抽奖：抽奖 1 次：奖励&lt;&amp;&gt;/);
  assert.equal(formatCheckinReport("Report", [{ name: "Good", ok: true, message: "ok" }]),
    "<b>Report</b>\n成功 1/1\n✅ <b>Good</b>：ok");
});

test("callback saves only allowed credentials, NewAPI aliases, cleared authSession and IP-independent cookies", async () => {
  const env = makeEnv([channel("Future API", "newapi", "gha_api", { password: "mock-old-password", authSession: "mock-old-session" }),
    channel("Alias", "newapi"), channel("Sub", "sub2api"), channel("Forum", "nodeseek", "gha_browser", { cookie: "session=mock-old" })]);
  const { messages } = mockWorkerOutbound(env);
  const results = [failure({ pending: true, newTokens: { accessToken: "mock-new-access", refreshToken: "mock-refresh",
    accessExpiresAt: 1234567890, userId: "42", authSession: "", cookie: "session=mock-session; cf_clearance=mock-clearance; acw_tc=mock-waf",
    password: "mock-injected", email: "injected@invalid", turnstileToken: "mock-injected", arbitrary: "mock-injected" } }),
    { name: "Alias", ok: true, message: "ok", newTokens: { token: "mock-alias-token", newApiUser: 43 } },
    { name: "Sub", ok: true, message: "ok", newTokens: { accessToken: "mock-sub-access", userId: 44, authSession: null } },
    { name: "Forum", ok: true, message: "ok", newTokens: { cookie: "cf_clearance=mock-only-waf" } }];
  assert.equal((await callback(env, results, "mock-wrong-secret")).status, 401);
  assert.equal(env.CHECKIN_KV.writes.length, 0);
  const response = await callback(env, results);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).merged, 4);
  const [future, alias, sub, forum] = env.CHECKIN_KV.read("channels");
  assert.equal(future.auth.accessToken, "mock-new-access");
  assert.equal(future.auth.token, "mock-new-access");
  assert.equal(future.auth.refreshToken, "mock-refresh");
  assert.equal(future.auth.accessExpiresAt, 1234567890);
  assert.equal(future.auth.userId, "42");
  assert.equal(future.auth.newApiUser, "42");
  assert.equal(future.auth.authSession, "");
  assert.equal(future.auth.password, "mock-old-password");
  assert.equal(future.auth.cookie, "session=mock-session; acw_tc=mock-waf");
  for (const key of ["email", "turnstileToken", "arbitrary"]) assert.equal(future.auth[key], undefined);
  assert.equal(alias.auth.token, "mock-alias-token");
  assert.equal(alias.auth.accessToken, "mock-alias-token");
  assert.equal(alias.auth.userId, 43);
  assert.equal(sub.auth.userId, 44);
  assert.equal(sub.auth.token, undefined);
  assert.equal(sub.auth.authSession, "");
  assert.equal(forum.auth.cookie, "session=mock-old");
  assert.equal(future.lastResult.pending, true);
  assert.equal(future.lastResult.attempts, 1);
  assert.equal(future.lastResult.maxAttempts, 3);
  const flat = env.CHECKIN_KV.read("last_run").results;
  assert.equal(flat[0].pending, true);
  assert.equal(flat[0].attempts, 1);
  assert.equal(flat[0].maxAttempts, 3);
  assert.ok(flat.every((r) => !r.newTokens && !r.tokens));
  assert.match(messages[0], /成功 3\/4 · 待确认1/);
  assert.ok(!messages[0].includes("mock-new-access"));
  await callback(env, [{ name: "Future API", ok: false, pending: false, message: "浏览器任务启动失败" }]);
  assert.equal(env.CHECKIN_KV.read("channels")[0].lastResult.pending, false);
  assert.match(messages[1], /❌/);
  await callback(env, [{ name: "Alias", ok: true, degraded: true, message: "已分发，等待结果" }]);
  assert.equal(env.CHECKIN_KV.read("channels")[1].lastResult.pending, true);
  assert.equal(env.CHECKIN_KV.read("last_run").results[0].pending, true);
  assert.match(messages[2], /成功 0\/1 · 待确认1/);
});

test("publicResult carries attempts and pending while configured/dispatched Worker placeholders remain unconfirmed", async () => {
  const env = makeEnv();
  const { messages } = mockWorkerOutbound(env);
  adapters.newapi = { me: async () => ({ ok: false, degraded: true, message: "awaiting", attempts: 2, maxAttempts: 3 }) };
  const publicResponse = await apiCall(env, "/api/checkin", { channel: channel(), action: "me" });
  assert.equal(publicResponse.status, 200);
  const publicBody = await publicResponse.json();
  assert.equal(publicBody.pending, true);
  assert.equal(publicBody.attempts, 2);
  assert.equal(publicBody.maxAttempts, 3);
  const batch = await (await apiCall(env, "/api/batch", { channels: [channel()] })).json();
  assert.equal(batch.results[0].pending, true);
  assert.equal(batch.results[0].ok, false);
  assert.match(messages.at(-1), /成功 0\/1 · 待确认1/);
  const scheduled = await runScheduled(env);
  assert.equal(scheduled.results[0].pending, true);
  assert.equal(env.CHECKIN_KV.read("channels")[0].lastResult.pending, true);
  assert.match(messages.at(-1), /⏳ <b>Future API<\/b>/);
  const selected = await runSelectedCheckin(env, { selection: channel() });
  assert.equal(selected.results[0].pending, true);
  assert.match(selected.message, /待确认1/);
  assert.ok(!selected.message.includes("成功完成"));
});

test("Worker degraded placeholders preserve pending/retry metadata; dispatch errors return a terminal failure", async () => {
  const env = makeEnv([channel("Future API", "newapi", "worker")]);
  const retryChannel = { ...channel("Future API", "newapi", "worker"), options: { runner: "worker", retryCount: 2 } };
  adapters.newapi = { checkin: async () => ({ ok: false, needsBrowser: true, message: "Turnstile token为空",
    tokens: { userId: "42" }, attempts: 1, maxAttempts: 3 }) };
  mockWorkerOutbound(env);
  const [pending] = await batchCheckinCore([retryChannel], env);
  assert.equal(pending.result.ok, false);
  assert.equal(pending.result.pending, true);
  assert.equal(pending.result.degraded, true);
  assert.equal(pending.result.attempts, 1);
  assert.equal(pending.result.maxAttempts, 3);
  assert.equal(pending.via, "gha_browser");
  mockWorkerOutbound(env, { githubStatus: 503 });
  const [failed] = await batchCheckinCore([retryChannel], env);
  assert.equal(failed.result.ok, false);
  assert.ok(!failed.result.pending && !failed.result.degraded);
  assert.match(failed.result.message, /GHA 分发失败/);
});
