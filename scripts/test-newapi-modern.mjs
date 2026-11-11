/** Cookie-authenticated New API refresh regression; all fetches are mocked. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { newapiAdapter as adapter } from "../src/adapters/newapi.js";

const NOW = Math.floor(Date.now() / 1000);
const SID = "fixture-session-id";
const COOKIE = "new_api_refresh=fixture-secret; new_api_has_session=1";
const ROTATED_COOKIE = "new_api_refresh=rotated-secret; new_api_has_session=1";
const token = (exp) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({
  token_use: "access", aud: ["new-api-dashboard"], exp,
})).toString("base64url")}.fixture-signature`;
const OLD = token(NOW - 10);
const FRESH = token(NOW + 900);
const channel = (auth) => ({ type: "newapi", baseUrl: "https://freeapi.example.test", auth, options: {} });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
let calls = [];
let checkedIn = false;
const originalFetch = globalThis.fetch;
function mock({ rejectRefresh = false, rejectSelf = false } = {}) {
  calls = []; checkedIn = false;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, ...init });
    const h = new Headers(init.headers);
    if (path === "/api/user/auth/refresh") {
      // SID alone never authenticates: unlike the previous mock, require Cookie.
      if (rejectRefresh || h.get("Cookie") !== COOKIE) {
        return json({ success: false, code: "AUTH_UNAUTHORIZED", message: "Unauthorized" }, 401);
      }
      assert.equal(init.method, "POST");
      assert.equal(init.body, undefined);
      assert.equal(h.get("Authorization"), null);
      assert.equal(h.get("Referer"), "https://freeapi.example.test/profile");
      return json({ success: true, data: { access_token: FRESH, access_expires_at: NOW + 900,
        session: { sid: SID }, user: { id: 7, username: "fixture", quota: 1000 } } }, 200,
        { "Set-Cookie": "new_api_refresh=rotated-secret; Path=/; HttpOnly; Secure" });
    }
    if (path === "/api/user/self") {
      if (rejectSelf) return json({ success: false, message: "Unauthorized, invalid access token" }, 401);
      return json({ success: true, data: { id: 7, username: "fixture", quota: 1000 } });
    }
    if (path === "/api/user/checkin") {
      if (init.method === "POST") { checkedIn = true; return json({ success: true, message: "签到成功", data: { quota_awarded: 500000 } }); }
      return json({ success: true, data: { enabled: true, stats: { checked_in_today: false, checkin_count: 3, records: [] } } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
}
function headersFor(path) { return calls.filter(c => c.path === path).map(c => new Headers(c.headers)); }
function test(name, fn) { return Promise.resolve().then(fn).then(() => console.log(`PASS ${name}`)); }
try {
  for (const action of ["me", "status", "checkin", "login"]) {
    await test(`${action}: cookie refresh, new Bearer, rotated cookie and token write-back`, async () => {
      mock();
      const ch = channel({ token: OLD, accessToken: "stale-alias", cookie: COOKIE, authSession: SID });
      const before = JSON.stringify(ch);
      const result = await adapter[action](ch);
      assert.equal(result.ok, true);
      assert.equal(result.tokens.accessToken, FRESH);
      assert.equal(result.tokens.token, FRESH);
      assert.equal(result.tokens.cookie, ROTATED_COOKIE);
      assert.equal(result.tokens.authSession, SID);
      assert.equal(result.tokens.accessExpiresAt, NOW + 900);
      assert.equal(JSON.stringify(ch), before, "must not mutate input configuration");
      assert.equal(calls[0].path, "/api/user/auth/refresh");
      assert.equal(new Headers(calls[0].headers).get("X-Auth-Session"), SID);
      for (const c of calls.slice(1)) {
        assert.equal(new Headers(c.headers).get("Authorization"), `Bearer ${FRESH}`);
        assert.equal(new Headers(c.headers).get("Cookie"), ROTATED_COOKIE);
      }
      if (action === "checkin") assert.equal(checkedIn, true);
    });
  }
  await test("valid JWT + SID without explicit expiry: query directly, never force refresh", async () => {
    mock();
    const result = await adapter.me(channel({ token: FRESH, authSession: SID }));
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/api/user/self");
    assert.equal(headersFor("/api/user/self")[0].get("Authorization"), `Bearer ${FRESH}`);
  });
  await test("expired token + SID only: missing Cookie is actionable, no futile request", async () => {
    mock();
    const result = await adapter.me(channel({ token: OLD, authSession: SID }));
    assert.equal(result.ok, false);
    assert.match(result.message, /缺少完整登录 Cookie/);
    assert.match(result.message, /不是登录凭证/);
    assert.equal(calls.length, 0);
  });
  await test("server rejects unexpired JWT: do not treat exp as authentication", async () => {
    mock({ rejectSelf: true });
    const result = await adapter.me(channel({ token: FRESH, authSession: SID }));
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
    assert.match(result.message, /invalid access token/);
    assert.match(result.message, /完整登录 Cookie/);
    assert.equal(calls.length, 1);
  });
  await test("cookie-only modern channel can refresh without a SID", async () => {
    mock();
    const result = await adapter.me(channel({ cookie: COOKIE }));
    assert.equal(result.ok, true);
    assert.equal(new Headers(calls[0].headers).get("X-Auth-Session"), null);
    assert.equal(result.tokens.cookie, ROTATED_COOKIE);
  });
  await test("invalid Cookie returns refresh cause, never password-login advice", async () => {
    mock({ rejectRefresh: true });
    const result = await adapter.checkin(channel({ token: OLD, cookie: COOKIE, authSession: SID }));
    assert.equal(result.ok, false);
    assert.match(result.message, /刷新会话失败：Unauthorized/);
    assert.match(result.message, /完整登录 Cookie/);
    assert.equal(calls.length, 1);
    assert.equal(checkedIn, false);
  });
  await test("near-expiry token remains usable after failed refresh", async () => {
    mock({ rejectRefresh: true });
    const near = token(NOW + 45);
    const result = await adapter.me(channel({ token: near, cookie: COOKIE, authSession: SID }));
    assert.equal(result.ok, true);
    assert.equal(headersFor("/api/user/self")[0].get("Authorization"), `Bearer ${near}`);
  });
  await test("legacy Cookie channels keep their existing auth flow", async () => {
    mock();
    const result = await adapter.me(channel({ cookie: "session=legacy", userId: "7" }));
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const h = new Headers(calls[0].headers);
    assert.equal(h.get("Cookie"), "session=legacy");
    assert.equal(h.get("New-Api-User"), "7");
    assert.equal(h.get("Authorization"), null);
  });
  await test("UI write-back synchronizes token/accessToken without touching other adapters", () => {
    const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
    const start = html.indexOf("    function mergeTokens(");
    const end = html.indexOf("    async function maybeRefreshUser", start);
    const merge = vm.runInNewContext(`(${html.slice(start, end).trim()})`);
    const ch = channel({ token: OLD });
    const result = merge(ch, { accessToken: FRESH, cookie: ROTATED_COOKIE, authSession: SID });
    assert.equal(result.auth.token, FRESH);
    assert.equal(result.auth.accessToken, FRESH);
    assert.equal(ch.auth.token, OLD);
    assert.equal(merge({ type: "sub2api", auth: { token: "other" } }, { accessToken: FRESH }).auth.token, "other");
  });
  await test("clearing/replacing the token field cannot revive a hidden stale alias", () => {
    const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
    const start = html.indexOf("    function deleteByPath(");
    const end = html.indexOf("    function getByPath(", start);
    const edit = vm.runInNewContext(`${html.slice(start, end)}; mergeChannelEdit`);
    const prev = channel({ token: OLD, accessToken: OLD, accessExpiresAt: NOW - 10 });
    const cleared = edit(prev, { ...channel({ cookie: COOKIE }), _clearedKeys: ["auth.token"] });
    assert.equal(cleared.auth.token, undefined);
    assert.equal(cleared.auth.accessToken, undefined);
    assert.equal(cleared.auth.accessExpiresAt, undefined);
    const replaced = edit(prev, channel({ token: FRESH }));
    assert.equal(replaced.auth.accessToken, FRESH);
    assert.equal(replaced.auth.accessExpiresAt, undefined);
    assert.equal(prev.auth.token, OLD);
  });
  console.log("New API regression: all checks passed");
} finally {
  globalThis.fetch = originalFetch;
}
