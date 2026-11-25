import assert from 'node:assert/strict';
import { retryCount, runCheckinWithRetry, shouldRetryCheckin, isPermanentCheckinFailure } from '../src/checkin-retry.js';
import { adapters, listAdapters, runAction } from '../src/adapters/index.js';

const channel = { type: 'newapi', auth: { token: 'old', cookie: 'old-cookie' }, options: {} };
const instant = { sleep: async () => {} };
let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log('PASS '+name); };
await test('retry config: default 2, preserve zero, reject invalid values, clamp 5', async () => {
  for (const value of [undefined, null, '', ' ', true, false, [], {}, 'bad', NaN, Infinity, -1, 1.5]) {
    assert.equal(retryCount({ options: { retryCount: value } }), 2);
  }
  assert.equal(retryCount({ options: { retryCount: '0' } }), 0);
  assert.equal(retryCount({ options: { retryCount: 0 } }), 0);
  assert.equal(retryCount({ options: { retryCount: '4' } }), 4);
  assert.equal(retryCount({ options: { retryCount: 99 } }), 5);
});
await test('success does not query state or repeat POST', async () => {
  let posts = 0;
  const result = await runCheckinWithRetry({ checkin: async () => { posts++; return {ok:true}; },
    status: async () => { throw new Error('must not query'); } }, channel, {}, instant);
  assert.equal(posts,1); assert.equal(result.attempts,1); assert.equal(result.maxAttempts,3);
});
await test('default transient failure is bounded at 3 rounds with backoff', async () => {
  let posts=0, states=0; const delays=[];
  const result=await runCheckinWithRetry({ checkin: async()=>{posts++;return {ok:false,httpStatus:503,message:'temporary'};},
    status:async()=>{states++;return {ok:true,status:{checkedInToday:false}};} }, channel, {}, {sleep:async ms=>delays.push(ms)});
  assert.equal(posts,3);assert.equal(states,3);assert.deepEqual(delays,[2000,5000]);assert.equal(result.attempts,3);
});
await test('zero disables retries but still confirms uncertain effects', async () => {
  let posts=0, states=0;
  const r=await runCheckinWithRetry({checkin:async()=>{posts++;return {ok:false,httpStatus:500};},
    status:async()=>{states++;return {ok:true,status:{checkedInToday:false}};}}, {...channel,options:{retryCount:0}}, {}, instant);
  assert.equal(posts,1);assert.equal(states,1);assert.equal(r.maxAttempts,1);
});
await test('POST error + authoritative checked-in state prevents retries and browser fallback', async () => {
  let posts=0;
  const r=await runCheckinWithRetry({checkin:async()=>{posts++;return {ok:false,needsBrowser:true,message:'Turnstile token 为空',tokens:{accessToken:'fresh'}};},
    status:async c=>{assert.equal(c.auth.token,'fresh');return {ok:true,message:'今日已签到，奖励 $50',status:{checkedInToday:true,todayReward:25000000},tokens:{cookie:'rotated'}};}}, channel, {}, instant);
  assert.equal(posts,1);assert.equal(r.ok,true);assert.equal(r.needsBrowser,false);assert.equal(r.result.alreadyCheckedIn,true);
  assert.equal(r.tokens.accessToken,'fresh');assert.equal(r.tokens.cookie,'rotated');assert.match(r.message,/状态复查确认/);
});
await test('explicit already-checked responses are terminal success, including HTTP errors', async () => {
  for (const failure of [
    { ok: false, httpStatus: 400, message: "今天已经签到" },
    { ok: false, httpStatus: 404, raw: { message: "already checked in today" } },
    { ok: false, httpStatus: 409, raw: { code: "ALREADY_CHECKED_IN" } },
  ]) {
    let posts = 0;
    const r = await runCheckinWithRetry({
      checkin: async () => { posts++; return failure; },
      status: async () => assert.fail("already checked must stop before status/retry"),
    }, channel, {}, instant);
    assert.equal(posts, 1);
    assert.equal(r.ok, true);
    assert.equal(r.result.alreadyCheckedIn, true);
    assert.equal(r.attempts, 1);
  }
  const notChecked = await runCheckinWithRetry({
    checkin: async () => ({ ok: false, httpStatus: 400, message: "not already checked in" }),
  }, { ...channel, options: { retryCount: 0 } }, {}, instant);
  assert.equal(notChecked.ok, false);
});

await test('unknown/failed state never implies success', async () => {
  for(const state of [{ok:true,status:{}},{ok:false,status:{checkedInToday:true}}]) {
    const r=await runCheckinWithRetry({checkin:async()=>({ok:false,needsBrowser:true}),status:async()=>state},channel,{},instant);
    assert.equal(r.ok,false);assert.equal(r.attempts,1);
  }
});
await test('needsBrowser is handed off without repeating HTTP; credential failures stop', async () => {
  for(const fail of [{ok:false,needsBrowser:true,message:'Turnstile token 为空'},
    {ok:false,httpStatus:401,message:'Unauthorized'}, {ok:false,httpStatus:404,message:'not found'},
    {ok:false,retryable:false,message:'permanent'}]) {
    let calls=0;
    const r=await runCheckinWithRetry({checkin:async()=>{calls++;return fail;}},channel,{},instant);
    assert.equal(calls,1);assert.equal(r.ok,false);
  }
  assert.equal(isPermanentCheckinFailure({ok:false,needsBrowser:true,message:'缺少验证码'}),false);
  assert.equal(isPermanentCheckinFailure({ok:false,message:'缺少完整登录 Cookie'}),true);
  assert.equal(shouldRetryCheckin({ok:false,httpStatus:429}),true);
  assert.equal(shouldRetryCheckin({ok:false,httpStatus:403,message:'Cloudflare challenge'}),false);
  assert.equal(shouldRetryCheckin({ok:false,message:'Too many subrequests by single Worker invocation'}),false);
  assert.equal(isPermanentCheckinFailure({ok:false,message:'Too many subrequests by single Worker invocation'}),true);
});
await test('retry carries credential bundle without mutating input; success is terminal', async () => {
  const before=JSON.stringify(channel);let posts=0;
  const r=await runCheckinWithRetry({checkin:async c=>{posts++;if(posts===1)return {ok:false,httpStatus:500,tokens:{accessToken:'fresh',cookie:'new'}};
    assert.equal(c.auth.token,'fresh');assert.equal(c.auth.cookie,'new');return {ok:true,message:'signed'};}},channel,{},instant);
  assert.equal(posts,2);assert.equal(r.tokens.accessToken,'fresh');assert.equal(r.tokens.cookie,'new');assert.equal(JSON.stringify(channel),before);
});
await test('thrown network errors retry and retain tokens from failed status checks', async () => {
  let posts=0;
  const r=await runCheckinWithRetry({checkin:async()=>{posts++;if(posts===1)throw new Error('network error');return {ok:true};},
    status:async()=>({ok:false,tokens:{cookie:'status-cookie'}})},channel,{},instant);
  assert.equal(posts,2);assert.equal(r.tokens.cookie,'status-cookie');
await test('fresh session clears a stale snake-case alias', async () => {
  let calls=0;
  const r=await runCheckinWithRetry({checkin:async c=>{calls++;if(calls===1)return {ok:false,httpStatus:500,tokens:{accessToken:'fresh',authSession:''}};
    assert.equal(c.auth.authSession,'');assert.equal(c.auth.auth_session,undefined);return {ok:true};}},
    {...channel,auth:{...channel.auth,auth_session:'stale'}},{},instant);
  assert.equal(r.ok,true);assert.equal(calls,2);
});
});
await test('all adapters expose number field; non-checkin actions never retry', async () => {
  for(const adapter of listAdapters()) {
    const f=adapter.fields.find(x=>x.key==='options.retryCount');assert.equal(f.type,'number');assert.equal(f.min,0);assert.equal(f.max,5);
    const apiOnly=adapter.fields.find(x=>x.key==='options.apiOnly');assert.equal(apiOnly.type,'checkbox');assert.match(apiOnly.label,/不自动转浏览器/);
  }
  let calls=0;
  adapters.fixture={fields:[],claim:async()=>{calls++;throw new Error('claim failed');},checkin:async()=>({ok:true})};
  try {
    await assert.rejects(runAction('fixture','claim',{auth:{},options:{}}),/claim failed/);
    assert.equal(calls,1);
    const r=await runAction('fixture','checkin',{auth:{},options:{}});
    assert.equal(r.attempts,1);
  } finally { delete adapters.fixture; }
});
console.log(`${checks} retry checks passed`);
