import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const fragment = script.slice(script.indexOf("    /* ---------------- Telegram 交互 ---------------- */"), script.indexOf("    async function loadApp()"));
const esc = script.slice(script.indexOf("    function escapeHtml("), script.indexOf("    function setSessionToken("));
const queued = { id: "job-1", status: "queued", createdAt: 1000, message: "排队中", count: 1 };
const proxy = { rawUrl: "http://alice:private-password@proxy.example.com:80", url: "http://alice:***@proxy.example.com:80", enabled: true, scheme: "http" };

function harness(api = async () => ({ ok: true })) {
  const nodes = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], {
    value: match[1] === "proxyRunner" ? "github" : "", textContent: "", innerHTML: "", disabled: false, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
  });
  const timers = new Map(), calls = [], logs = [], toasts = [];
  let timerId = 0;
  const context = vm.createContext({
    $: (id) => { assert.ok(nodes.has(id), `HTML 缺少 ${id}`); return nodes.get(id); },
    apiRequest: async (...args) => { calls.push(args); return api(...args); },
    authState: { authRequired: true, authenticated: true },
    log: (...args) => logs.push(args), showToast: (...args) => toasts.push(args), confirm: () => true,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(esc + fragment + "\nglobalThis.ui = { get state() { return proxyState; }, renderProxies, loadProxies, showProxyJob, refreshProxyJob };", context);
  return { ui: context.ui, context, nodes, timers, calls, logs, toasts, click: (id) => nodes.get(id).listeners.click() };
}

test("完整内联脚本可编译，新增检测控件 ID 唯一", () => {
  assert.doesNotThrow(() => new vm.Script(script));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of ["proxyRunner", "btnTestProxies", "btnRefreshProxies", "proxyTestStatus"]) assert.ok(ids.includes(id));
});

test("代理列表显示打码地址/来源/IP，并对文本和 HTML 属性转义", async () => {
  const h = harness(async () => ({ proxies: [{ ...proxy, note: '<img src=x onerror="alert(1)">', lastCheck: { ok: false, source: "github", ip: "203.0.113.1", certUntrusted: true, error: '" onmouseover="alert(1)' } }] }));
  await h.ui.loadProxies();
  const output = h.nodes.get("proxyResults").innerHTML;
  assert.ok(!output.includes("private-password"));
  assert.ok(output.includes("alice:***"));
  assert.ok(output.includes("GitHub · HTTPS") && output.includes("203.0.113.1"));
  assert.ok(output.includes("&lt;img"));
  assert.ok(!output.includes('title="" onmouseover="'));
  assert.equal(h.ui.state.list[0].url, proxy.rawUrl);
});

test("空池或全部停用时不提交，提交失败后恢复控件", async () => {
  const h = harness(async () => { throw new Error("GH_TOKEN 未配置"); });
  await h.click("btnTestProxies");
  h.ui.state.list = [{ ...proxy, enabled: false }];
  await h.click("btnTestProxies");
  assert.equal(h.calls.length, 0);
  h.ui.state.list = [proxy];
  await h.click("btnTestProxies");
  assert.equal(h.calls.length, 1);
  assert.equal(h.nodes.get("btnTestProxies").disabled, false);
  assert.equal(h.nodes.get("proxyRunner").disabled, false);
  assert.match(h.nodes.get("proxyTestStatus").textContent, /GH_TOKEN/);
  assert.equal(h.timers.size, 0);
});

test("提交202后排队，完成时自动拉取结果并恢复控件", async () => {
  const h = harness(async (path, options) => {
    if (options?.method === "POST") {
      assert.deepEqual(JSON.parse(options.body), { all: true, runner: "github" });
      return { job: queued, message: queued.message };
    }
    if (path.startsWith("/api/proxies/test")) return { job: { ...queued, status: "completed", message: "验证通过 1/1", okCount: 1 } };
    return { proxies: [{ ...proxy, lastCheck: { source: "github", ok: true, browserUsable: true, ms: 20, ip: "203.0.113.1" } }] };
  });
  h.ui.state.list = [proxy];
  await h.click("btnTestProxies");
  assert.equal(h.nodes.get("btnTestProxies").disabled, true);
  assert.equal(h.ui.state.job.id, queued.id);
  assert.ok([...h.timers.values()].some((t) => t.ms === 5000));
  await h.ui.refreshProxyJob(queued.id);
  assert.equal(h.nodes.get("btnTestProxies").disabled, false);
  assert.ok(h.nodes.get("proxyResults").innerHTML.includes("HTTPS 可用（已验证）"));
  assert.match(h.nodes.get("proxyTestStatus").textContent, /验证通过/);
  assert.ok(![...h.timers.values()].some((t) => t.ms === 5000));
});

test("刷新页面恢复排队状态，KV 暂时旧值不让轮询停止", async () => {
  let response = { job: queued };
  const h = harness(async () => response);
  await h.ui.refreshProxyJob();
  assert.equal(h.ui.state.testing, true);
  response = { job: null };
  await h.ui.refreshProxyJob();
  assert.equal(h.ui.state.job.id, queued.id);
  assert.ok([...h.timers.values()].some((t) => t.ms === 5000));
});

test("超时任务解锁，临时网络错误重试但不会无限锁住按钮", async () => {
  let response = { job: { ...queued, status: "timed_out", message: "请检查工作流" } };
  const h = harness(async () => { if (response instanceof Error) throw response; return response; });
  h.ui.showProxyJob(queued);
  await h.ui.refreshProxyJob(queued.id);
  assert.equal(h.ui.state.testing, false);
  assert.match(h.nodes.get("proxyTestStatus").textContent, /工作流/);
  h.ui.showProxyJob(queued);
  response = new Error("网络不可用");
  for (let i = 0; i < 6; i++) await h.ui.refreshProxyJob(queued.id);
  assert.equal(h.nodes.get("btnTestProxies").disabled, false);
  assert.equal(h.timers.size, 0);
  assert.match(h.nodes.get("proxyTestStatus").textContent, /刷新结果/);
});

test("Worker 诊断不进入 GitHub 轮询，保存失败清晰显示", async () => {
  const h = harness(async (path, options) => {
    if (!options) return { proxies: [proxy] };
    assert.equal(JSON.parse(options.body).runner, "worker");
    return { ok: true, persisted: false, okCount: 0, message: "Worker 握手连通 0/1（结果保存失败）" };
  });
  h.ui.state.list = [proxy];
  h.nodes.get("proxyRunner").value = "worker";
  await h.click("btnTestProxies");
  assert.equal(h.ui.state.testing, false);
  assert.equal(h.timers.size, 0);
  assert.match(h.nodes.get("proxyTestStatus").textContent, /保存失败/);
});

test("忽略旧任务迟到的轮询响应，不覆盖新任务", async () => {
  let resolve;
  const h = harness(() => new Promise((r) => { resolve = r; }));
  h.ui.showProxyJob(queued);
  const pending = h.ui.refreshProxyJob(queued.id);
  h.ui.showProxyJob({ ...queued, id: "job-2", createdAt: 2000 });
  resolve({ job: { ...queued, status: "completed" } });
  await pending;
  assert.equal(h.ui.state.job.id, "job-2");
  assert.equal(h.ui.state.testing, true);
});

test("Telegram 面板正确调用受保护状态/测试/注册接口，失败后按钮恢复", async () => {
  let fail = false;
  const h = harness(async (path, options) => {
    if (fail) throw new Error("TG_WEBHOOK_SECRET 未配置");
    if (path === "/api/tg/status") {
      assert.equal(options.method, "GET");
      return { ok: true, webhook: { url: "https://hub.example.com/api/tg/webhook", pending_update_count: 2 } };
    }
    assert.equal(options.method, "POST");
    return { ok: true, message: "操作成功" };
  });
  await h.click("btnTgStatus");
  assert.match(h.nodes.get("tgStatus").textContent, /已注册.*2/);
  await h.click("btnTgTest");
  await h.click("btnTgSetup");
  assert.deepEqual(h.calls.map(([path]) => path), ["/api/tg/status", "/api/tg/test", "/api/tg/setup"]);
  fail = true;
  await h.click("btnTgSetup");
  assert.match(h.nodes.get("tgStatus").textContent, /TG_WEBHOOK_SECRET/);
  assert.equal(h.nodes.get("btnTgSetup").disabled, false);
});

test("证书告警区分代理/目标/未知层级，不把未验证代理标为绿色可用", async () => {
  const cases = [
    { scheme: "https", source: "github", tlsFailureStage: "proxy", label: "代理证书告警 · 仍可尝试", color: "warn", hint: "不能标为已可用" },
    { scheme: "https", source: "github", tlsFailureStage: "target", label: "目标证书异常 · 影响 HTTPS", color: "err", hint: "本次安全 HTTPS 请求失败" },
    { scheme: "socks5", source: "github", tlsFailureStage: "target", label: "目标证书异常 · 影响 HTTPS", color: "err", hint: "不会自动关闭目标证书安全检查" },
    { scheme: "https", source: "github", label: "证书告警 · 可用性待确认", color: "warn", hint: "请重新进行 GitHub 检测" },
    { scheme: "https", source: "worker", label: "Worker TLS 受限 · 待确认", color: "warn", hint: "不代表 GitHub 浏览器通道一定不可用" },
    { scheme: "socks5", source: "github", tlsFailureStage: "proxy", label: "证书告警 · 可用性待确认", color: "warn", hint: "当前结果未区分" },
  ];
  for (const spec of cases) {
    const h = harness(async () => ({ proxies: [{ ...proxy, scheme: spec.scheme, lastCheck: {
      ok: false, browserUsable: false, certUntrusted: true, source: spec.source, tlsFailureStage: spec.tlsFailureStage,
    } }] }));
    await h.ui.loadProxies();
    const output = h.nodes.get("proxyResults").innerHTML;
    assert.ok(output.includes(`class="tag ${spec.color}">${spec.label}`), spec.label);
    assert.ok(output.includes(spec.hint));
    assert.ok(!output.includes('class="tag ok"'));
    assert.ok(!output.includes("HTTPS 可用（已验证）"));
  }
});

test("仅握手通过与 SOCKS 认证不兼容不冒充已验证 HTTPS 可用", async () => {
  for (const [source, browserUsable, label] of [["worker", true, "握手通过"], ["github", false, "连通，但需 SOCKS 认证"]]) {
    const h = harness(async () => ({ proxies: [{ ...proxy, scheme: "socks5", lastCheck: { ok: true, source, browserUsable, ms: 10 } }] }));
    await h.ui.loadProxies();
    const output = h.nodes.get("proxyResults").innerHTML;
    assert.ok(output.includes(label));
    assert.ok(!output.includes("HTTPS 可用（已验证）"));
  }
});
