import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { normalizeProxy, parseProxyUrl, maskProxyUrl } from "../src/proxy.js";
import { startProxyTest, getProxyTestStatus, getProxyTestTask, completeProxyTest, proxyRunnerAuthenticated, PROXY_TEST_TIMEOUT_MS, PROXY_TEST_TARGET } from "../src/proxy-test.js";
import { curlProbe, curlErrorCode, testSavedProxy, testProxyBatch, runProxyJob } from "./gha-proxy-test.mjs";
import { memoryKV } from "./test-helpers.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const stored = [
  { url: "http://alice:private-password@proxy.example.com:8080", note: "保留备注", enabled: true },
  { url: "socks5://other.example.com:1080", enabled: true },
  { url: "https://disabled.example.com:443", enabled: false },
];
const makeEnv = (proxies = stored) => ({ CHECKIN_KV: memoryKV({ proxies }), GH_TOKEN: "github-token", GH_REPO: "owner/repo", CRON_SECRET: "runner-secret" });
const good = (id, extra = {}) => ({ id, ok: true, ms: 42, ip: "203.0.113.9", tlsVerified: true, browserUsable: true, authUsed: "none", ...extra });
function mockDispatch() {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); };
  return calls;
}
async function newJob(env) { mockDispatch(); return (await startProxyTest(env)).job; }

test("代理解析保留显式默认端口，拒绝坏转义与不合法输入", () => {
  assert.equal(parseProxyUrl("http://proxy.example.com:80").port, 80);
  assert.equal(parseProxyUrl("http://proxy.example.com").port, 8080);
  assert.equal(parseProxyUrl("https://proxy.example.com:443").port, 443);
  assert.equal(parseProxyUrl("socks5h://[2001:db8::1]:1080").scheme, "socks5");
  assert.ok(!maskProxyUrl("http://user:private-password%ZZ@proxy.example.com:80").includes("private-password"));
  for (const value of [null, 4, "http://a:%ZZ@proxy.example.com:80", "socks4://a:b@proxy.example.com:1080", "http://proxy.example.com/path", "https://proxy.example.com:0"]) {
    assert.equal(normalizeProxy(value), null, String(value));
  }
});

test("GitHub 分发只有任务编号，配置与密码不出现在状态里", async () => {
  const env = makeEnv();
  const calls = mockDispatch();
  const result = await startProxyTest(env);
  assert.equal(result.job.status, "queued");
  assert.equal(result.job.count, 2);
  assert.deepEqual(JSON.parse(calls[0].init.body), { event_type: "proxy-test", client_payload: { jobId: result.job.id } });
  assert.equal(calls[0].init.headers.Authorization, "Bearer github-token");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(result).includes("private-password"));
  const task = await getProxyTestTask(env, result.job.id);
  assert.equal(task.job.proxies[0].url, stored[0].url);
  assert.equal(task.job.targetUrl, PROXY_TEST_TARGET);
  assert.equal(task.job.proxies.length, 2);
  assert.equal((await getProxyTestStatus(env)).job.id, result.job.id);
  assert.ok(env.CHECKIN_KV.writes.every((r) => r.options?.expirationTtl === 86400));
});

test("缺配置、空池、停用/不存在的选择与数量上限均阻止分发", async () => {
  const calls = mockDispatch();
  for (const env of [{}, { ...makeEnv(), GH_TOKEN: "" }, { ...makeEnv(), CRON_SECRET: "" }, makeEnv([]), makeEnv([stored[2]])]) {
    await assert.rejects(startProxyTest(env));
  }
  await assert.rejects(startProxyTest(makeEnv(), { urls: [] }));
  await assert.rejects(startProxyTest(makeEnv(), { urls: [stored[2].url] }));
  await assert.rejects(startProxyTest(makeEnv(), { urls: ["http://unknown.example.com:80"] }));
  await assert.rejects(startProxyTest(makeEnv(Array.from({ length: 101 }, (_, i) => ({ url: `http://p${i}.example.com:80` })))));
  assert.equal(calls.length, 0);
});

test("GitHub 拒绝或网络错误留下失败状态，而不是永久排队", async () => {
  for (const networkError of [false, true]) {
    const env = makeEnv();
    globalThis.fetch = async () => { if (networkError) throw new Error("sensitive transport details"); return new Response("secret body", { status: 403 }); };
    await assert.rejects(startProxyTest(env), /GitHub/);
    const { job } = await getProxyTestStatus(env);
    assert.equal(job.status, "failed");
    assert.ok(!JSON.stringify(job).includes("secret body"));
    assert.ok(!JSON.stringify(job).includes("sensitive"));
  }
});

test("结果合并不复活删除项，不覆盖备注和启用状态；重复回调幂等", async () => {
  const env = makeEnv();
  const job = await newJob(env);
  await env.CHECKIN_KV.put("proxies", JSON.stringify([{ ...stored[0], note: "检测期间的新备注", enabled: false }, stored[2]]));
  const response = await completeProxyTest(env, { jobId: job.id, runId: "1234", results: [good("0"), good("1")] });
  assert.equal(response.merged, 1);
  const current = env.CHECKIN_KV.read("proxies");
  assert.equal(current.length, 2);
  assert.equal(current[0].note, "检测期间的新备注");
  assert.equal(current[0].enabled, false);
  assert.equal(current[0].lastCheck.source, "github");
  assert.equal(current[0].lastCheck.ip, "203.0.113.9");
  assert.equal(response.job.runUrl, "https://github.com/owner/repo/actions/runs/1234");
  assert.ok(!JSON.stringify(response).includes("private-password"));
  const writes = env.CHECKIN_KV.writes.length;
  assert.equal((await completeProxyTest(env, { jobId: job.id, results: [] })).duplicate, true);
  assert.equal(env.CHECKIN_KV.writes.length, writes);
  await assert.rejects(getProxyTestTask(env, job.id), /已结束/);
});

test("旧任务不覆盖新结果；已改密的代理不接收旧任务结果", async () => {
  const env = makeEnv();
  const job = await newJob(env);
  const current = [{ ...stored[0], lastCheck: { at: job.createdAt + 100, requestedAt: job.createdAt + 50, ok: false } }, { ...stored[1], url: "socks5://changed.example.com:1080" }];
  await env.CHECKIN_KV.put("proxies", JSON.stringify(current));
  assert.equal((await completeProxyTest(env, { jobId: job.id, results: [good("0"), good("1")] })).merged, 0);
  assert.deepEqual(env.CHECKIN_KV.read("proxies"), current);
});

test("未知/重复编号、缺结果和伪造成功不能回写", async () => {
  const env = makeEnv();
  const job = await newJob(env);
  for (const results of [[good("0")], [good("0"), good("0")], [good("0"), good("9")], [good("0"), good("1", { tlsVerified: false })], [good("0"), good("1", { ms: -1 })], ...["<script>", "aaa", "999.1.1.1", ":::1"].map((ip) => [good("0"), good("1", { ip })])]) {
    await assert.rejects(completeProxyTest(env, { jobId: job.id, results }));
    assert.deepEqual(env.CHECKIN_KV.read("proxies"), stored);
  }
  await assert.rejects(getProxyTestStatus(env, "../channels"));
});

test("错误只保存白名单说明，不存原始命令或密码", async () => {
  const env = makeEnv();
  const job = await newJob(env);
  const response = await completeProxyTest(env, { jobId: job.id, results: [
    { id: "0", ok: false, ms: 10, errorCode: "TLS_CERT", error: stored[0].url },
    { id: "1", ok: false, ms: 20, errorCode: "<script>private-password</script>" },
  ] });
  assert.equal(response.job.results[0].certUntrusted, true);
  assert.equal(response.job.results[1].errorCode, "UNKNOWN");
  assert.ok(!JSON.stringify(response).includes("private-password"));
});

test("超时任务显示说明并拒绝迟到结果，runner secret 不因开放面板而失效", async () => {
  const env = makeEnv();
  const job = await newJob(env);
  const raw = env.CHECKIN_KV.read("proxy_test:" + job.id);
  raw.createdAt = Date.now() - PROXY_TEST_TIMEOUT_MS - 10;
  await env.CHECKIN_KV.put("proxy_test:" + job.id, JSON.stringify(raw));
  assert.equal((await getProxyTestStatus(env)).job.status, "timed_out");
  await assert.rejects(completeProxyTest(env, { jobId: job.id, results: [good("0"), good("1")] }), /超时/);
  const request = (secret) => new Request("https://hub.example.com/api/proxies/test/task", { headers: { "X-Cron-Secret": secret } });
  assert.equal(proxyRunnerAuthenticated(request("runner-secret"), env), true);
  assert.equal(proxyRunnerAuthenticated(request("wrong"), env), false);
  assert.equal(proxyRunnerAuthenticated(request(""), {}), false);
});

test("curl 强制代理/远端 HTTPS、默认校验证书并限制时间和输出", async () => {
  const proxyUrl = "https://a:private-password@proxy.example.com:443";
  const result = await curlProbe(proxyUrl, { exec: async (command, args, options) => {
    assert.equal(command, "curl");
    assert.equal(args[0], "--disable");
    assert.equal(args[args.indexOf("--proxy") + 1], proxyUrl);
    assert.equal(args[args.indexOf("--noproxy") + 1], "");
    assert.ok(!args.includes("--insecure") && !args.includes("--proxy-insecure") && !args.includes("--location"));
    assert.equal(args[args.indexOf("--write-out") + 1], "\n__CHECKIN_TLS__:%{proxy_ssl_verify_result}:%{ssl_verify_result}");
    assert.equal(args.at(-1), PROXY_TEST_TARGET);
    assert.equal(options.timeout, 14000);
    return { stdout: '{"ip":"2001:db8::1"}\n__CHECKIN_TLS__:0:0' };
  } });
  assert.equal(result.ok, true);
  assert.equal(result.tlsVerified, true);
  assert.equal(result.ip, "2001:db8::1");
});

test("curl 坏响应和失败被分类而不泄露完整命令", async () => {
  assert.equal((await curlProbe(stored[0].url, { exec: async () => ({ stdout: '{"ip":"999.1.1.1"}' }) })).errorCode, "RESPONSE");
  const r = await curlProbe(stored[0].url, { exec: async () => { throw Object.assign(new Error(stored[0].url), { code: 60, stderr: stored[0].url }); } });
  assert.equal(r.errorCode, "TLS_CERT");
  assert.ok(!JSON.stringify(r).includes("private-password"));
  for (const [code, expected] of [[28, "TIMEOUT"], [7, "CONNECT"], [5, "DNS"], [97, "AUTH"], [22, "HTTP"], [35, "TLS"], ["ENOENT", "CURL"]]) assert.equal(curlErrorCode({ code }), expected);
});

test("SOCKS 先按浏览器免认证测试；强制认证单独标记", async () => {
  const entry = { id: "0", url: "socks5://alice:password@proxy.example.com:1080" };
  const urls = [];
  const result = await testSavedProxy(entry, { probe: async (url) => { urls.push(url); return url.includes("@") ? good("0") : { ok: false, ms: 1, errorCode: "AUTH" }; } });
  assert.deepEqual(urls, ["socks5h://proxy.example.com:1080", "socks5h://alice:password@proxy.example.com:1080"]);
  assert.equal(result.ok, true);
  assert.equal(result.browserUsable, false);
  assert.equal(result.authUsed, "userpass");
  const anonymous = await testSavedProxy(entry, { probe: async (url) => { assert.ok(!url.includes("@")); return good("0"); } });
  assert.equal(anonymous.browserUsable, true);
  assert.equal(anonymous.authUsed, "none");
  await testSavedProxy({ id: "4", url: "socks4://proxy.example.com:1080" }, { probe: async (url) => { assert.equal(url, "socks4a://proxy.example.com:1080"); return good("4"); } });
});

test("HTTP/HTTPS 认证保留，批处理并发有界且一条异常不丢其它结果", async () => {
  const r = await testSavedProxy({ id: "0", url: stored[0].url }, { probe: async (url) => { assert.equal(url, stored[0].url); return good("0"); } });
  assert.equal(r.authUsed, "basic");
  assert.equal(r.browserUsable, true);
  let running = 0, max = 0;
  const entries = Array.from({ length: 9 }, (_, i) => ({ id: String(i) }));
  const out = await testProxyBatch(entries, { concurrency: 3, test: async (p) => {
    max = Math.max(max, ++running);
    await new Promise((resolve) => setImmediate(resolve));
    running--;
    if (p.id === "4") throw new Error("private-password");
    return good(p.id);
  } });
  assert.equal(max, 3);
  assert.deepEqual(out.map((r) => r.id), entries.map((p) => p.id));
  assert.equal(out[4].errorCode, "UNKNOWN");
});

test("runner 从受保护任务接口读取、处理 KV 延迟与回写重试，产物不带凭证", async () => {
  const id = crypto.randomUUID();
  const env = { PROXY_TEST_JOB_ID: id, HUB_BASE_URL: "https://hub.example.com/", HUB_SECRET: "runner-secret", GITHUB_RUN_ID: "1234" };
  const calls = [], waits = [], logs = [];
  let gets = 0, posts = 0, artifact;
  const r = await runProxyJob(env, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      assert.equal(new URL(url).origin, "https://hub.example.com");
      assert.equal(init.headers["X-Cron-Secret"], "runner-secret");
      assert.equal(init.redirect, "error");
      if (init.method === "GET") {
        if (++gets === 1) return Response.json({ ok: false }, { status: 404 });
        return Response.json({ ok: true, job: { id, proxies: [{ id: "0", url: stored[0].url }], targetUrl: PROXY_TEST_TARGET, timeoutMs: 12000 } });
      }
      if (++posts === 1) return Response.json({ ok: false }, { status: 503 });
      return Response.json({ ok: true, merged: 1 });
    },
    delay: async (ms) => { waits.push(ms); },
    testBatch: async (entries) => { assert.equal(entries[0].url, stored[0].url); return [good("0")]; },
    save: async (_, value) => { artifact = value; },
    log: (line) => logs.push(line),
  });
  assert.equal(r.merged, 1);
  assert.deepEqual(waits, [2000, 2000]);
  assert.equal(calls.length, 4);
  assert.ok(!artifact.includes("private-password"));
  assert.ok(!logs.join("\n").includes("private-password"));
  assert.equal(JSON.parse(artifact).runId, "1234");
});

test("runner 拒绝无效配置和跨协议地址，401 不重试且报失败", async () => {
  const env = { PROXY_TEST_JOB_ID: crypto.randomUUID(), HUB_BASE_URL: "https://hub.example.com", HUB_SECRET: "secret" };
  for (const overrides of [{ PROXY_TEST_JOB_ID: "bad" }, { HUB_SECRET: "" }, { HUB_BASE_URL: "http://hub.example.com" }, { HUB_BASE_URL: "https://a:password@hub.example.com" }]) {
    await assert.rejects(runProxyJob({ ...env, ...overrides }));
  }
  let calls = 0;
  await assert.rejects(runProxyJob(env, { fetchImpl: async () => { calls++; return Response.json({ ok: false }, { status: 401 }); }, delay: async () => assert.fail("401 不应重试") }), /HTTP 401/);
  assert.equal(calls, 1);
});

test("curl 证书元数据区分代理 TLS 与目标 TLS，不跳过安全校验", async () => {
  for (const [scheme, stdout, expected] of [
    ["https", "\n__CHECKIN_TLS__:20:0", "proxy"],
    ["https", "\n__CHECKIN_TLS__:0:20", "target"],
    ["https", "\n__CHECKIN_TLS__:20:20", "proxy"],
    ["https", "", "unknown"],
    ["https", "\n__CHECKIN_TLS__:0:0", "unknown"],
    ["http", "", "target"],
    ["socks5", "\n__CHECKIN_TLS__:0:18", "target"],
  ]) {
    const r = await curlProbe(`${scheme}://proxy.example.com:443`, { exec: async (_command, args) => {
      assert.ok(!args.includes("--insecure") && !args.includes("--proxy-insecure"));
      throw Object.assign(new Error("private-password"), { code: 60, stdout, stderr: "private-password" });
    } });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "TLS_CERT");
    assert.equal(r.tlsFailureStage, expected, `${scheme}: ${stdout}`);
    assert.ok(!JSON.stringify(r).includes("private-password"));
  }
});

test("非证书错误不因残留 curl 元数据被归为证书告警", async () => {
  const r = await curlProbe("https://proxy.example.com:443", { exec: async () => {
    throw Object.assign(new Error("timeout"), { code: 28, stdout: "\n__CHECKIN_TLS__:20:0" });
  } });
  assert.equal(r.errorCode, "TIMEOUT");
  assert.equal(r.tlsFailureStage, null);
});

test("证书层级回写并给出对应说明，但不计入已经验证可用数量", async () => {
  const env = makeEnv([
    { url: "https://proxy.example.com:443", enabled: true },
    { url: "socks5://socks.example.com:1080", enabled: true },
    { url: "https://legacy.example.com:443", enabled: true },
  ]);
  const job = await newJob(env);
  const result = await completeProxyTest(env, { jobId: job.id, results: [
    { id: "0", ok: false, ms: 12, errorCode: "TLS_CERT", tlsFailureStage: "proxy", browserUsable: true },
    { id: "1", ok: false, ms: 13, errorCode: "TLS_CERT", tlsFailureStage: "target" },
    { id: "2", ok: false, ms: 14, errorCode: "TLS_CERT" },
  ] });
  assert.equal(result.merged, 3);
  assert.equal(result.job.okCount, 0);
  assert.equal(result.job.browserUsable, 0);
  assert.equal(result.job.certWarnings, 3);
  assert.match(result.job.message, /严格 HTTPS.*证书告警 3 个/);
  const current = env.CHECKIN_KV.read("proxies");
  assert.deepEqual(current.map(p => p.lastCheck.tlsFailureStage), ["proxy", "target", "unknown"]);
  assert.ok(current.every(p => !p.lastCheck.ok && !p.lastCheck.tlsVerified && !p.lastCheck.browserUsable));
  assert.match(current[0].lastCheck.error, /仍可尝试.*尚未验证/);
  assert.match(current[1].lastCheck.error, /目标网站 TLS/);
  assert.match(current[2].lastCheck.error, /可用性待确认/);
});

test("非 HTTPS 代理不能被标成代理自身证书问题，非法层级不入库", async () => {
  const env = makeEnv();
  const job = await newJob(env);
  const result = await completeProxyTest(env, { jobId: job.id, results: [
    { id: "0", ok: false, ms: 12, errorCode: "TLS_CERT", tlsFailureStage: "proxy" },
    { id: "1", ok: false, ms: 13, errorCode: "TLS_CERT", tlsFailureStage: "private-password<script>" },
  ] });
  assert.ok(result.job.results.every(r => r.tlsFailureStage === "unknown"));
  assert.ok(!JSON.stringify(result).includes("private-password<script>"));
});
