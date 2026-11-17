import assert from 'node:assert/strict';
import { newapiAdapter as adapter } from '../src/adapters/newapi.js';

const originalFetch = globalThis.fetch;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const channel = { type: 'newapi', baseUrl: 'https://future.example.test',
  auth: { cookie: 'session=fixture', userId: '7', turnstileToken: 'existing-token' }, options: {} };
let posts;
function mock(replies, { already = false } = {}) {
  posts = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/api/status') return json({ success: true, data: { turnstile_check: true } });
    assert.equal(u.pathname, '/api/user/checkin');
    if (init.method === 'GET') return json({ success: true, data: { enabled: true,
      stats: { checked_in_today: already, records: [] } } });
    posts.push({ url: u, headers: new Headers(init.headers) });
    assert.ok(replies.length, 'no extra check-in POST');
    return replies.shift();
  };
}
try {
  mock([json({ success: true, data: { quota_awarded: 1 } })]);
  let result = await adapter.checkin(channel);
  assert.equal(result.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url.search, '');
  console.log('PASS global Turnstile setting / configured token does not prevent token-free success');

  mock([json({ success: false, message: 'Turnstile token 为空' }, 200, { 'Set-Cookie': 'session=rotated; Path=/' }),
    json({ success: true, data: { quota_awarded: 1 } })]);
  result = await adapter.checkin(channel);
  assert.equal(result.ok, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url.search, '');
  assert.equal(posts[1].url.searchParams.get('turnstile'), 'existing-token');
  assert.equal(posts[1].headers.get('Cookie'), 'session=rotated');
  assert.equal(result.tokens.cookie, 'session=rotated');
  console.log('PASS token-free refusal precedes bounded token retry and preserves rotated Cookie');

  mock([json({ success: false, message: 'Turnstile token 为空' })]);
  result = await adapter.checkin({ ...channel, auth: { cookie: 'session=fixture' } });
  assert.equal(result.ok, false);
  assert.equal(result.needsBrowser, true);
  assert.equal(posts.length, 1);
  console.log('PASS real Turnstile refusal without token requests browser fallback');

  for (const [status, message] of [[401, 'Unauthorized'], [429, 'Too many requests'], [500, 'Internal error'], [200, '余额不足']]) {
    mock([json({ success: false, message, data: { turnstile_check: true, turnstile_site_key: 'login-only' } }, status)]);
    result = await adapter.checkin(channel);
    assert.equal(result.ok, false);
    assert.equal(result.needsBrowser, undefined);
    assert.equal(posts.length, 1);
  }
  console.log('PASS authentication/rate-limit/server/business failures never use captcha token');

  mock([], { already: true });
  result = await adapter.checkin(channel);
  assert.equal(result.ok, true);
  assert.equal(posts.length, 0);
  mock([json({ success: false, message: '今天已签到', data: { turnstile_check: true } })]);
  result = await adapter.checkin(channel);
  assert.equal(result.ok, true);
  assert.equal(posts.length, 1);
  console.log('PASS already-checked-in responses stop without duplicate POST');
} finally { globalThis.fetch = originalFetch; }
