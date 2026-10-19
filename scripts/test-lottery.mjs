/**
 * sub2api（林夕 k40 / 百倍 100xlabs 等同系）自动抽奖的离线回归测试（mock fetch，不联网）。
 *
 * 跑法：node scripts/test-lottery.mjs（由 npm test 串联）
 *
 * 用例来自两处**实证**，不是猜的：
 *   ① 用户 2026-10-19 抓的 HAR（POST /api/v1/lottery 的真实请求体与响应体）；
 *   ② 同一天用线上 token 只读探过 GET /api/v1/lottery/{status,summary,draws}：
 *      Bearer 鉴权与签到同一套、device_id 可省、status 的字段名与下面 fixture 一致。
 *
 * 关键契约（退化就会静默出错，所以钉住）：
 *   1. 抽奖是 POST /api/v1/lottery，body = { cost_type, idempotency_key, boost }；
 *      每次都必须换新的 idempotency_key —— 重复用同一个 key 会被服务端去重，等于白抽；
 *   2. 默认只花免费额度（cost_type=free）；活动分/余额是用户真实资产，只有
 *      options.lotteryCost=auto/all 才会动；
 *   3. 抽几次以服务端回的 today_remaining 为准，抽完即停；单次硬上限 30
 *      （Workers 免费版单次请求子请求上限 50，签到自身还要用掉几个）；
 *   4. 开关（options.autoLottery）默认关；关着时**一个抽奖请求都不该发**；
 *   5. 抽奖失败不推翻签到结论，只追加说明；中途失败要保留已抽到的结果；
 *   6. 抽奖结论要进 result.lottery，供 TG 报告单独占一行（不被签到文案的 90 字截断）。
 */
import fs from "node:fs";


import { sub2apiAdapter } from "../src/adapters/sub2api.js";
import { listAdapters, runAction } from "../src/adapters/index.js";
import { formatCheckinReport } from "../src/tg.js";

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

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 装一个按 (method, path) 分派的假 fetch，并记录请求供断言 */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    // 页内 JS 发的是相对路径（'/api/v1/...'），给个 base 才能解析
    const u = new URL(url, "https://hub.local");
    const method = (init.method || "GET").toUpperCase();
    const call = { url, u, method, headers: init.headers || {}, body: init.body };
    calls.push(call);
    const key = `${method} ${u.pathname}`;
    const handler = routes[key] || routes[u.pathname] || routes["*"];
    if (!handler) throw new Error(`未 mock 的路由: ${key}`);
    return typeof handler === "function" ? handler({ u, call, calls }) : handler;
  };
  return calls;
}

const BASE = "https://k40.shengqainbang.cn";
const TOKEN = "stored-access-token";

const ch = (auth = {}, options = {}) => ({
  id: "ch_k40",
  name: "林夕",
  type: "sub2api",
  baseUrl: BASE,
  auth: { accessToken: TOKEN, ...auth },
  options,
});

/** 线上实测的 GET /api/v1/lottery/status 响应体（2026-10-19） */
const STATUS_BODY = (over = {}) => ({
  code: 0,
  message: "success",
  data: {
    enabled: true,
    window_open: true,
    can_draw: true,
    title: "幸运抽奖-请拿出你的余额",
    description: "三选一消耗后抽奖。中奖付费额度不计充值。",
    activity_score: 29,
    activity_cap: 100,
    balance: 49.65136704,
    free_balance: 6314.76898048,
    bonus_draws: 3,
    today_draws: 1,
    daily_draw_limit: 12,
    daily_draw_limit_base: 10,
    quota_reset_hour: 12,
    today_remaining: 11,
    costs: {
      activity: { enabled: false, amount: "1" },
      free: { enabled: true, amount: "88" },
      paid: { enabled: false, amount: "0.10" },
    },
    prizes: [{ id: "p1", type: "free", amount: "30", probability_bp: 4000 }],
    batch_draw: { enabled: true, max_count: 3 },
    boost: { enabled: true, available: true, activity_cost: 1, today_boosts_remaining: 3 },
    ...over,
  },
});

/** HAR 里 POST /api/v1/lottery 的真实响应体（一抽一次，服务端回最新余额与剩余次数） */
const DRAW_BODY = (over = {}, draw = {}) => ({
  code: 0,
  message: "success",
  data: {
    draw: {
      id: 447069,
      user_id: 13116,
      cost_type: "free",
      cost_paid: 0,
      cost_free: 88,
      cost_activity: 0,
      prize_id: "p1787639170841",
      prize_type: "free",
      prize_amount: 30,
      prize_amount_actual: 30,
      status: "win",
      activity_before: 29,
      activity_after: 29,
      draw_date: "2026-10-19",
      created_at: "2026-10-19T14:07:41.575050388+08:00",
      ...draw,
    },
    activity_score: 29,
    balance: 49.65136704,
    free_balance: 6314.76898048,
    today_draws: 1,
    today_remaining: 11,
    ...over,
  },
});

/** 签到成功（简化自线上回话：奖励/余额/连续天数） */
const CHECKIN_BODY = {
  code: 0,
  message: "success",
  data: {
    reward_amount: 270,
    balance_after: 49.65,
    current_streak: 97,
    total_check_in_days: 97,
    checked_in_today: true,
  },
};

/** 一串抽奖响应：每次 today_remaining 递减，奖品按传进来的列表发 */
function drawSequence(prizes, { startRemaining = prizes.length, freeBalance = 6314.76898048 } = {}) {
  let i = 0;
  return () => {
    const prize = prizes[i] || { type: "free", amount: 30 };
    const remaining = Math.max(0, startRemaining - (i + 1));
    i += 1;
    return json(
      200,
      DRAW_BODY(
        {
          today_draws: 12 - remaining,
          today_remaining: remaining,
          free_balance: freeBalance,
        },
        { id: 447000 + i, prize_type: prize.type, prize_amount: prize.amount, prize_amount_actual: prize.amount }
      )
    );
  };
}

const restoreFetch = globalThis.fetch;

try {
  console.log("\n[1] 开关默认关：签到不会碰抽奖接口");
  {
    const calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY()),
      "POST /api/v1/lottery": () => json(200, DRAW_BODY()),
    });
    const r = await sub2apiAdapter.checkin(ch());
    ok(r.ok === true, "签到成功", r.message);
    ok(calls.length === 1, "只发了签到请求", calls.map((c) => `${c.method} ${c.u.pathname}`).join(","));
    ok(!calls.some((c) => c.u.pathname.startsWith("/api/v1/lottery")), "没有抽奖请求");
    ok(!/抽奖/.test(r.message), "文案里没有抽奖字样", r.message);
    ok(r.result.lottery === undefined, "result.lottery 不存在");
  }

  console.log("\n[2] 开关打开：签到成功后自动抽完今日剩余次数（HAR 真实请求体）");
  {
    const calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 3, today_draws: 9 })),
      "POST /api/v1/lottery": drawSequence(
        [
          { type: "free", amount: 300 },
          { type: "free", amount: 100 },
          { type: "none", amount: 0 },
        ],
        { startRemaining: 3 }
      ),
    });
    const r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true" }));
    const draws = calls.filter((c) => c.u.pathname === "/api/v1/lottery" && c.method === "POST");
    ok(r.ok === true, "签到仍算成功", r.message);
    ok(draws.length === 3, "抽了 3 次（= today_remaining）", `draws=${draws.length}`);
    ok(calls[1].u.pathname === "/api/v1/lottery/status", "先查状态再抽", calls[1].u.pathname);
    const body = JSON.parse(draws[0].body);
    ok(body.cost_type === "free", "默认只花免费额度", body.cost_type);
    ok(body.boost === false, "不带增益（与 HAR 一致）", String(body.boost));
    ok(typeof body.idempotency_key === "string" && body.idempotency_key.length >= 8, "带 idempotency_key");
    const keys = new Set(draws.map((c) => JSON.parse(c.body).idempotency_key));
    ok(keys.size === draws.length, "每次的 idempotency_key 都不同（否则被服务端去重）", `unique=${keys.size}`);
    ok(draws[0].headers.Authorization === `Bearer ${TOKEN}`, "Bearer 鉴权与签到同一套", draws[0].headers.Authorization);
    ok(/抽奖 3 次：中奖 2 次/.test(r.message), "文案带抽奖次数与中奖数", r.message);
    ok(/免费额度 300×1/.test(r.message), "文案带奖品明细", r.message);
    ok(/未中奖 1 次/.test(r.message), "文案带未中奖次数", r.message);
    ok(/消耗 免费额度 264/.test(r.message), "文案带消耗（88×3）", r.message);
    ok(/今日 12\/12/.test(r.message), "文案带今日进度", r.message);
    ok(r.result.lottery?.ok === true, "result.lottery 交给面板/TG", JSON.stringify(r.result.lottery?.message));
    ok(r.result.lottery.result.count === 3, "result.lottery.result.count=3", String(r.result.lottery.result.count));
    ok(r.result.lottery.result.prize.free === 400, "累计奖品额度 400", String(r.result.lottery.result.prize.free));
    ok(r.result.lottery.result.status.todayRemaining === 0, "剩余次数归零", String(r.result.lottery.result.status.todayRemaining));
  }

  console.log("\n[3] 今日已签到路径也要抽（定时任务常在这条路上）");
  {
    const calls = mockFetch({
      "POST /api/v1/check-in": () =>
        json(200, { code: 0, message: "今日已签到", data: { already_checked_in: true, balance: 49.65 } }),
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 1, today_draws: 11 })),
      "POST /api/v1/lottery": drawSequence([{ type: "free", amount: 30 }], { startRemaining: 1 }),
    });
    const r = await sub2apiAdapter.checkin(ch({}, { autoLottery: true }));
    ok(r.ok === true, "已签到仍算成功", r.message);
    ok(/今日已签到/.test(r.message), "保留「今日已签到」结论", r.message);
    ok(/抽奖 1 次/.test(r.message), "照样抽了 1 次", r.message);
    ok(calls.filter((c) => c.method === "POST" && c.u.pathname === "/api/v1/lottery").length === 1, "1 次抽奖请求");
  }

  console.log("\n[4] 跳过条件：活动关 / 窗口关 / 今日抽完 / 额度不足");
  {
    const cases = [
      { name: "活动未开启", status: STATUS_BODY({ enabled: false }), want: /站点未开启抽奖活动/ },
      { name: "窗口未开放", status: STATUS_BODY({ window_open: false }), want: /抽奖窗口未开放/ },
      { name: "can_draw=false", status: STATUS_BODY({ can_draw: false }), want: /不允许抽奖/ },
      { name: "今日次数用完", status: STATUS_BODY({ today_remaining: 0, today_draws: 12 }), want: /今日次数已用完（12\/12）/ },
    ];
    for (const c of cases) {
      const calls = mockFetch({
        "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
        "GET /api/v1/lottery/status": () => json(200, c.status),
        "POST /api/v1/lottery": () => json(200, DRAW_BODY()),
      });
      const r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true" }));
      ok(r.ok === true, `${c.name}：签到不受影响`, r.message);
      ok(c.want.test(r.message), `${c.name}：说明跳过原因`, r.message);
      ok(!calls.some((x) => x.method === "POST" && x.u.pathname === "/api/v1/lottery"), `${c.name}：没发抽奖请求`);
      ok(r.result.lottery?.skipped === true, `${c.name}：标了 skipped（TG 用 ⏭️）`);
    }
    // 免费额度不够：默认只花免费额度，于是不抽
    const calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ free_balance: 10 })),
      "POST /api/v1/lottery": () => json(200, DRAW_BODY()),
    });
    const r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true" }));
    ok(/免费额度不足（需 88，现有 10）/.test(r.message), "免费额度不够时不抽并说明", r.message);
    ok(!calls.some((x) => x.method === "POST" && x.u.pathname === "/api/v1/lottery"), "没发抽奖请求");
  }

  console.log("\n[5] 消耗方式：auto 退到活动分，all 才动余额");
  {
    const activityOnly = STATUS_BODY({
      free_balance: 0,
      activity_score: 5,
      today_remaining: 1,
      costs: {
        free: { enabled: true, amount: "88" },
        activity: { enabled: true, amount: "1" },
        paid: { enabled: true, amount: "0.10" },
      },
    });
    let calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, activityOnly),
      "POST /api/v1/lottery": () => json(200, DRAW_BODY({ free_balance: 0, activity_score: 4, today_remaining: 1 })),
    });
    let r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true" }));
    ok(/免费额度不足/.test(r.message), "默认模式：免费额度没了就不抽（不碰活动分）", r.message);
    ok(!calls.some((x) => x.method === "POST" && x.u.pathname === "/api/v1/lottery"), "没发抽奖请求");

    calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, activityOnly),
      // 服务端每抽一次都回最新余额与剩余次数（这里照做：活动分 5→4、剩余 1→0）。
      // 少了这一步，循环会以为还有次数，用例就测不出「抽完即停」。
      "POST /api/v1/lottery": () =>
        json(
          200,
          DRAW_BODY(
            { free_balance: 0, activity_score: 4, today_remaining: 0, today_draws: 12 },
            { cost_type: "activity", cost_free: 0, cost_activity: 1, prize_type: "activity", prize_amount: 1, prize_amount_actual: 1 }
          )
        ),
    });
    r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true", lotteryCost: "auto" }));
    const draws = calls.filter((c) => c.method === "POST" && c.u.pathname === "/api/v1/lottery");
    ok(draws.length === 1, "auto 模式：退到活动分抽 1 次", `draws=${draws.length}`);
    ok(JSON.parse(draws[0].body).cost_type === "activity", "cost_type=activity", JSON.parse(draws[0].body).cost_type);
    ok(/消耗 活动分 1/.test(r.message), "文案里的消耗是活动分", r.message);
    ok(/获得 活动分 1×1/.test(r.message), "活动分奖品按活动分展示", r.message);

    calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () =>
        json(
          200,
          STATUS_BODY({
            free_balance: 0,
            activity_score: 0,
            today_remaining: 1,
            costs: {
              free: { enabled: true, amount: "88" },
              activity: { enabled: true, amount: "1" },
              paid: { enabled: true, amount: "0.10" },
            },
          })
        ),
      "POST /api/v1/lottery": () =>
        json(
          200,
          DRAW_BODY(
            { free_balance: 0, activity_score: 0, balance: 49.55, today_remaining: 0 },
            { cost_type: "paid", cost_paid: 0.1, cost_free: 0, prize_type: "paid", prize_amount: 1, prize_amount_actual: 1 }
          )
        ),
    });
    r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true", lotteryCost: "all" }));
    const paidDraw = calls.find((c) => c.method === "POST" && c.u.pathname === "/api/v1/lottery");
    ok(JSON.parse(paidDraw.body).cost_type === "paid", "all 模式：免费/活动分都没了才动余额", JSON.parse(paidDraw.body).cost_type);
    ok(/获得 \$1\.00×1/.test(r.message), "付费额度按美元展示", r.message);
    ok(/消耗 \$0\.10/.test(r.message), "消耗按美元展示", r.message);
  }

  console.log("\n[6] 中途失败：保留已抽到的结果，失败原因写进文案");
  {
    let n = 0;
    const calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 4, today_draws: 8 })),
      "POST /api/v1/lottery": () => {
        n += 1;
        if (n === 3) return json(200, { code: 40001, message: "免费额度不足" });
        return json(
          200,
          DRAW_BODY({ today_remaining: 4 - n }, { id: 447000 + n, prize_type: "free", prize_amount: 100, prize_amount_actual: 100 })
        );
      },
    });
    const r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true" }));
    ok(r.ok === true, "签到结论不被抽奖失败推翻", r.message);
    ok(/抽奖 2 次：中奖 2 次/.test(r.message), "已抽到的 2 次保留", r.message);
    ok(/中途失败：免费额度不足/.test(r.message), "失败原因写进文案", r.message);
    ok(r.result.lottery.result.failure.message === "免费额度不足", "failure 结构化保留");
    ok(calls.filter((c) => c.method === "POST" && c.u.pathname === "/api/v1/lottery").length === 3, "失败即停，不再重试");
  }

  console.log("\n[7] 第一次就失败：整体报失败（但签到仍成功）");
  {
    mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 2 })),
      "POST /api/v1/lottery": () => json(500, { code: 50000, message: "internal error" }),
    });
    const r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true" }));
    ok(r.ok === true, "签到仍成功", r.message);
    ok(/抽奖失败：internal error/.test(r.message), "文案写明抽奖失败", r.message);
    ok(r.result.lottery.ok === false, "lottery.ok=false（TG 用 ⚠️）");
  }

  console.log("\n[8] 硬上限与 options.lotteryMaxDraws");
  {
    let calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 99, today_draws: 0 })),
      "POST /api/v1/lottery": drawSequence(Array.from({ length: 40 }, () => ({ type: "free", amount: 30 })), {
        startRemaining: 99,
      }),
    });
    let r = await sub2apiAdapter.lottery(ch());
    ok(calls.filter((c) => c.method === "POST").length === 30, "默认最多 30 次（Workers 子请求上限留余量）", `draws=${calls.filter((c) => c.method === "POST").length}`);
    ok(r.ok === true, "抽奖成功", r.message);

    calls = mockFetch({
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 99, today_draws: 0 })),
      "POST /api/v1/lottery": drawSequence(Array.from({ length: 40 }, () => ({ type: "free", amount: 30 })), {
        startRemaining: 99,
      }),
    });
    r = await sub2apiAdapter.lottery(ch({}, { lotteryMaxDraws: "2" }));
    ok(calls.filter((c) => c.method === "POST").length === 2, "lotteryMaxDraws=2 时只抽 2 次", `draws=${calls.filter((c) => c.method === "POST").length}`);
    ok(/抽奖 2 次/.test(r.message), "文案写 2 次", r.message);
  }

  console.log("\n[9] 手动抽奖动作 + 鉴权回退（与签到共用 withAuthRetry）");
  {
    // 抽奖按钮：runAction("sub2api", "lottery") 直接抽，不签到
    let calls = mockFetch({
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 1, today_draws: 11 })),
      "POST /api/v1/lottery": drawSequence([{ type: "free", amount: 300 }], { startRemaining: 1 }),
    });
    const r = await sub2apiAdapter.lottery(ch({}, { autoLottery: "true" }));
    ok(r.ok === true, "手动抽奖成功", r.message);
    ok(!calls.some((c) => c.u.pathname === "/api/v1/check-in"), "手动抽奖不碰签到接口");
    ok(/免费额度 300/.test(r.message), "文案带奖品", r.message);

    // token 失效 → refreshToken 换新 → 用新 token 重抽（抽奖也要能自愈）
    calls = mockFetch({
      "GET /api/v1/lottery/status": (() => {
        let n = 0;
        return () => {
          n += 1;
          if (n === 1) return json(401, { code: "TOKEN_EXPIRED", message: "token expired" });
          return json(200, STATUS_BODY({ today_remaining: 1, today_draws: 11 }));
        };
      })(),
      "POST /api/v1/auth/refresh": () => json(200, { code: 0, data: { access_token: "fresh-token", refresh_token: "r2" } }),
      "POST /api/v1/lottery": drawSequence([{ type: "free", amount: 100 }], { startRemaining: 1 }),
    });
    const r2 = await sub2apiAdapter.lottery(ch({ refreshToken: "r1" }));
    ok(r2.ok === true, "token 过期后刷新并重试成功", r2.message);
    ok(calls.some((c) => c.u.pathname === "/api/v1/auth/refresh"), "调了 refresh");
    const draw = calls.find((c) => c.method === "POST" && c.u.pathname === "/api/v1/lottery");
    ok(draw.headers.Authorization === "Bearer fresh-token", "用新 token 抽奖", draw.headers.Authorization);
    ok(r2.tokens?.accessToken === "fresh-token", "新 token 回传给调用方持久化");
  }

  console.log("\n[10] 面板/TG 契约：适配器自报动作与开关字段");
  {
    const a = listAdapters().find((x) => x.id === "sub2api");
    ok(a?.actions?.some((x) => x.action === "lottery"), "适配器自报 lottery 动作（卡片渲染「抽奖」按钮）");
    const autoField = a?.fields?.find((f) => f.key === "options.autoLottery");
    ok(!!autoField, "表单有 options.autoLottery 开关");
    ok(autoField?.type === "checkbox", "开关渲染成复选框（不是让人手填 true）", String(autoField?.type));
    ok(a?.fields?.some((f) => f.key === "options.lotteryCost"), "表单有 options.lotteryCost");
  }

  console.log("\n[11] TG 报告：抽奖单独占一行，不被签到文案的 90 字截断");
  {
    const text = formatCheckinReport("📋 定时签到报告", [
      {
        name: "林夕",
        ok: true,
        message: "刷新 token 后签到：签到成功，奖励 $270.00，余额 $49.65，连续 97 天，累计 97 天",
        lottery: { ok: true, skipped: false, message: "抽奖 11 次：中奖 10 次，获得 免费额度 300×8、100×2，消耗 免费额度 968，今日 12/12" },
      },
      {
        name: "百倍",
        ok: true,
        message: "签到成功，奖励 $300.00，余额 $22.56",
        lottery: { ok: true, skipped: true, message: "未抽奖：今日次数已用完（12/12）" },
      },
      { name: "百倍2", ok: true, message: "签到成功", lottery: { ok: false, message: "抽奖失败：internal error" } },
      { name: "NodeSeek", ok: true, message: "签到成功（无抽奖）" },
    ]);
    ok(/✅ <b>林夕<\/b>/.test(text), "签到行照旧");
    ok(/🎰 <b>林夕<\/b> 抽奖：抽奖 11 次/.test(text), "抽奖单独一行（🎰）", text);
    ok(/免费额度 300×8、100×2/.test(text), "奖品明细完整（没被 90 字截断）");
    ok(/⏭️ <b>百倍<\/b> 抽奖：未抽奖：今日次数已用完/.test(text), "跳过用 ⏭️");
    ok(/⚠️ <b>百倍2<\/b> 抽奖：抽奖失败/.test(text), "失败用 ⚠️");
    ok(!/NodeSeek<\/b> 抽奖/.test(text), "没有抽奖结果的渠道不渲染抽奖行");
    ok(/&amp;|&lt;/.test(formatCheckinReport("t", [{ name: "a<b>", ok: true, message: "x&y", lottery: { ok: true, message: "p<q" } }])) , "HTML 转义");
  }

  console.log("\n[12] 浏览器通道（scripts/browser-checkin.py）的页内抽奖：同一套口径");
  {
    // 浏览器通道不走适配器（它是 Playwright 里自己发页内 fetch），所以那段 JS 单独钉一遍：
    // 从 Python 源码里把 JSFUNC_SUB2API_LOTTERY 抠出来，在 Node 里用 mock fetch 跑。
    const py = fs.readFileSync(new URL("../scripts/browser-checkin.py", import.meta.url), "utf8");
    const m = /JSFUNC_SUB2API_LOTTERY = """\n([\s\S]*?)\n"""/.exec(py);
    ok(!!m, "能从 browser-checkin.py 里抠出页内抽奖 JS");
    const lotteryInPage = new Function(`return (${m[1]});`)();
    ok(typeof lotteryInPage === "function", "抠出来的是可调用的 async 函数");
    ok(/auto_lottery_note\(page, name, access, channel\)/.test(py), "签到成功后调用了 auto_lottery_note");
    ok(/opt\.get\("autoLottery"/.test(py), "读的是同一个渠道选项 options.autoLottery");
    ok(/opt\.get\("lotteryCost"/.test(py), "读的是同一个消耗方式选项 options.lotteryCost");

    const pageJson = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    // 页内 fetch 走 globalThis.fetch：mockFetch 已经把它换掉了
    let calls = mockFetch({
      "GET /api/v1/lottery/status": () => pageJson(200, STATUS_BODY({ today_remaining: 3, today_draws: 9 })),
      "POST /api/v1/lottery": drawSequence(
        [
          { type: "free", amount: 300 },
          { type: "free", amount: 100 },
          { type: "none", amount: 0 },
        ],
        { startRemaining: 3 }
      ),
    });
    const res = await lotteryInPage(["page-token", "free", 30]);
    const draws = calls.filter((c) => c.method === "POST" && c.u.pathname === "/api/v1/lottery");
    ok(res.ok === true && res.draws.length === 3, "页内抽了 3 次（= today_remaining）", JSON.stringify(res.draws.length));
    ok(draws.every((c) => JSON.parse(c.body).cost_type === "free"), "默认只花免费额度");
    ok(
      new Set(draws.map((c) => JSON.parse(c.body).idempotency_key)).size === 3,
      "每次换新的 idempotency_key"
    );
    ok(draws[0].headers.Authorization === "Bearer page-token", "带登录拿到的那份 Bearer", draws[0].headers.Authorization);
    ok(res.status.today_remaining === 0, "回传最新剩余次数", String(res.status.today_remaining));

    // 今日已抽完 / 活动关闭：直接跳过，不发抽奖请求
    calls = mockFetch({
      "GET /api/v1/lottery/status": () => pageJson(200, STATUS_BODY({ today_remaining: 0, today_draws: 12 })),
      "POST /api/v1/lottery": () => pageJson(200, DRAW_BODY()),
    });
    const skipped = await lotteryInPage(["page-token", "free", 30]);
    ok(skipped.skipped === true, "今日抽完 → skipped");
    ok(/今日次数已用完（12\/12）/.test(skipped.reason), "跳过原因与 Worker 侧同一句话", skipped.reason);
    ok(!calls.some((c) => c.method === "POST"), "没发抽奖请求");

    // 中途失败：保留已抽到的，把失败原因带回来
    let n = 0;
    calls = mockFetch({
      "GET /api/v1/lottery/status": () => pageJson(200, STATUS_BODY({ today_remaining: 4, today_draws: 8 })),
      "POST /api/v1/lottery": () => {
        n += 1;
        if (n === 3) return pageJson(200, { code: 40001, message: "免费额度不足" });
        return pageJson(
          200,
          DRAW_BODY({ today_remaining: 4 - n }, { id: 447000 + n, prize_type: "free", prize_amount: 100, prize_amount_actual: 100 })
        );
      },
    });
    const partial = await lotteryInPage(["page-token", "free", 30]);
    ok(partial.draws.length === 2, "失败前抽到的 2 次保留", String(partial.draws.length));
    ok(partial.failure === "免费额度不足", "失败原因带回 Python 侧", String(partial.failure));
    ok(partial.ok === true, "有抽到就算成功（Python 侧据此只追加说明）");

    // 消耗方式与硬上限：mode=auto 才退到活动分；cap 由 lotteryMaxDraws 决定
    calls = mockFetch({
      "GET /api/v1/lottery/status": () =>
        pageJson(
          200,
          STATUS_BODY({
            free_balance: 0,
            activity_score: 5,
            today_remaining: 9,
            costs: {
              free: { enabled: true, amount: "88" },
              activity: { enabled: true, amount: "1" },
              paid: { enabled: true, amount: "0.10" },
            },
          })
        ),
      "POST /api/v1/lottery": () =>
        pageJson(200, DRAW_BODY({ free_balance: 0, activity_score: 4, today_remaining: 0 }, { cost_type: "activity", cost_free: 0, cost_activity: 1 })),
    });
    const autoRes = await lotteryInPage(["page-token", "auto", 30]);
    const autoDraw = calls.find((c) => c.method === "POST");
    ok(JSON.parse(autoDraw.body).cost_type === "activity", "mode=auto：免费额度没了退到活动分", JSON.parse(autoDraw.body).cost_type);
    ok(autoRes.draws.length === 1, "服务端说没了就停", String(autoRes.draws.length));

    calls = mockFetch({
      "GET /api/v1/lottery/status": () => pageJson(200, STATUS_BODY({ today_remaining: 99, today_draws: 0 })),
      "POST /api/v1/lottery": drawSequence(Array.from({ length: 40 }, () => ({ type: "free", amount: 30 })), {
        startRemaining: 99,
      }),
    });
    await lotteryInPage(["page-token", "free", 2]);
    ok(calls.filter((c) => c.method === "POST").length === 2, "cap 生效（lotteryMaxDraws 透传）", String(calls.filter((c) => c.method === "POST").length));
  }

  console.log("\n[13] 抽几次可选（面板数字框 → runAction extra.count）");
  {
    const seqOf = (n, start = 11) =>
      drawSequence(Array.from({ length: n }, () => ({ type: "free", amount: 30 })), { startRemaining: start });
    const drawCalls = (calls) => calls.filter((c) => c.method === "POST" && c.u.pathname === "/api/v1/lottery");

    // 填 2 → 就抽 2 次（今日还剩 11 次也不多抽）
    let calls = mockFetch({
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 11, today_draws: 1 })),
      "POST /api/v1/lottery": seqOf(20),
    });
    let r = await sub2apiAdapter.lottery(ch(), { count: 2 });
    ok(drawCalls(calls).length === 2, "count=2 只抽 2 次", `draws=${drawCalls(calls).length}`);
    ok(r.ok === true, "成功", r.message);
    ok(/抽奖 2 次/.test(r.message), "文案写 2 次", r.message);
    ok(r.result.requested === 2, "result.requested=2", String(r.result.requested));
    ok(r.result.stopReason === null, "抽够了就不写「提前结束」", String(r.result.stopReason));

    // 填 5、今日只剩 3 → 抽 3 次并说明原因
    calls = mockFetch({
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 3, today_draws: 9 })),
      "POST /api/v1/lottery": seqOf(10, 3),
    });
    r = await sub2apiAdapter.lottery(ch(), { count: 5 });
    ok(drawCalls(calls).length === 3, "count=5 但只剩 3 次 → 抽 3 次", `draws=${drawCalls(calls).length}`);
    ok(/提前结束：今日只剩 3 次/.test(r.message), "说明是被今日剩余次数卡住", r.message);

    // 填 50 → 受硬上限 30 约束，并说明
    calls = mockFetch({
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 99, today_draws: 0 })),
      "POST /api/v1/lottery": seqOf(60, 99),
    });
    r = await sub2apiAdapter.lottery(ch(), { count: 50 });
    ok(drawCalls(calls).length === 30, "count=50 → 硬上限 30 次", `draws=${drawCalls(calls).length}`);
    ok(/提前结束：单次上限 30 次/.test(r.message), "说明是被硬上限卡住", r.message);

    // 留空 / 无效值 → 回到默认口径（抽完今日剩余）
    for (const [label, extra] of [
      ["不传 count", {}],
      ["count 为空串", { count: "" }],
      ["count=0", { count: 0 }],
      ["count 是垃圾值", { count: "abc" }],
      ["count 为负", { count: -3 }],
    ]) {
      calls = mockFetch({
        "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 4, today_draws: 8 })),
        "POST /api/v1/lottery": seqOf(10, 4),
      });
      r = await sub2apiAdapter.lottery(ch(), extra);
      ok(drawCalls(calls).length === 4, `${label} → 抽完今日剩余 4 次`, `draws=${drawCalls(calls).length}`);
      ok(r.result.requested === null, `${label} → requested=null`, String(r.result.requested));
    }

    // 手填的次数优先于 options.lotteryMaxDraws（后者是自动抽奖的上限，不是手动上限）
    calls = mockFetch({
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 11, today_draws: 1 })),
      "POST /api/v1/lottery": seqOf(20),
    });
    r = await sub2apiAdapter.lottery(ch({}, { lotteryMaxDraws: "2" }), { count: 5 });
    ok(drawCalls(calls).length === 5, "手填 5 次优先于 lotteryMaxDraws=2", `draws=${drawCalls(calls).length}`);

    // 自动抽奖不吃手填次数：走 lotteryMaxDraws
    calls = mockFetch({
      "POST /api/v1/check-in": () => json(200, CHECKIN_BODY),
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 11, today_draws: 1 })),
      "POST /api/v1/lottery": seqOf(20),
    });
    r = await sub2apiAdapter.checkin(ch({}, { autoLottery: "true", lotteryMaxDraws: "2" }));
    ok(drawCalls(calls).length === 2, "自动抽奖按 lotteryMaxDraws=2 抽", `draws=${drawCalls(calls).length}`);
    ok(/抽奖 2 次/.test(r.message), "签到文案里也是 2 次", r.message);

    // 整数化：填 2.9 只抽 2 次（别把小数发给站点）
    calls = mockFetch({
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 11, today_draws: 1 })),
      "POST /api/v1/lottery": seqOf(20),
    });
    r = await sub2apiAdapter.lottery(ch(), { count: 2.9 });
    ok(drawCalls(calls).length === 2, "count=2.9 → 2 次", `draws=${drawCalls(calls).length}`);

    // runAction 要把 extra 透传给适配器（面板走的就是这条路）
    calls = mockFetch({
      "GET /api/v1/lottery/status": () => json(200, STATUS_BODY({ today_remaining: 11, today_draws: 1 })),
      "POST /api/v1/lottery": seqOf(20),
    });
    r = await runAction("sub2api", "lottery", ch(), { count: 3 });
    ok(drawCalls(calls).length === 3, "runAction 透传 count", `draws=${drawCalls(calls).length}`);
    ok(r.ok === true, "runAction 返回适配器结果", r.message);

    // 适配器要自报 count，面板才知道要渲染数字框
    const act = listAdapters().find((x) => x.id === "sub2api")?.actions?.find((x) => x.action === "lottery");
    ok(!!act?.count, "lottery 动作自报 count（面板据此渲染数字框）", JSON.stringify(act));
    ok(!!act?.count?.placeholder, "count 带 placeholder（留空提示）", JSON.stringify(act?.count));
    // 其它动作不受影响：linux.sb 的抽称号没有 count，面板不会给它加数字框
    const gacha = listAdapters().find((x) => x.id === "linuxsb")?.actions?.find((x) => x.action === "gacha");
    ok(!gacha?.count, "linux.sb 的抽称号没有 count（不渲染数字框）", JSON.stringify(gacha));
  }
} finally {
  globalThis.fetch = restoreFetch;
}

console.log(`\n${failures ? "❌" : "✅"} 抽奖用例：${checks - failures}/${checks} 通过`);
if (failures) process.exit(1);
