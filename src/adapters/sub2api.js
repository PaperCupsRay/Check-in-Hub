/**
 * Sub2API-style check-in adapter
 * Observed from:
 *  - https://k40.shengqainbang.cn
 *  - https://sub.100xlabs.space
 *
 * Auth: Bearer JWT (localStorage auth_token on official web UI)
 * Login: POST /api/v1/auth/login { email, password, turnstile_token? }
 * Refresh: POST /api/v1/auth/refresh { refresh_token }
 * Status: GET /api/v1/check-in/status?timezone=Asia/Shanghai
 * Check-in: POST /api/v1/check-in { timezone, turnstile_token? }
 */

const DEFAULT_TZ = "Asia/Shanghai";

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function jsonHeaders(extra = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}

async function readJson(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

function pickAuth(channel) {
  const auth = channel.auth || {};
  return {
    email: auth.email || auth.username || "",
    password: auth.password || "",
    accessToken: auth.accessToken || auth.token || "",
    refreshToken: auth.refreshToken || "",
    turnstileToken: auth.turnstileToken || channel.options?.turnstileToken || "",
  };
}

function timezoneOf(channel) {
  return channel.options?.timezone || DEFAULT_TZ;
}

/** sub2api 的 balance/reward 本身就是美元金额，不需要按 quota_per_unit 换算 */
function money(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;
}

function normalizeUser(data) {
  const u = data?.data || data || {};
  return {
    id: u.id,
    email: u.email,
    username: u.username || u.email || "",
    balance: u.balance,
    role: u.role,
    status: u.status,
    raw: u,
  };
}

function normalizeStatus(payload) {
  const d = payload?.data || payload || {};
  return {
    enabled: d.enabled !== false,
    checkedInToday: !!d.checked_in_today,
    currentStreak: d.current_streak ?? null,
    streakBroken: !!d.streak_broken,
    todayReward: d.today_reward ?? null,
    rewards: d.rewards || [],
    totalCheckInDays: d.total_check_in_days ?? null,
    totalReward: d.total_reward ?? null,
    checkInDate: d.check_in_date || null,
    turnstileRequired: !!d.turnstile_required,
    balance: d.balance ?? null,
    raw: d,
  };
}

/**
 * 拼装可读的签到结论。
 *
 * 服务端成功时只回 message:"success"，直接透传会让日志变成「百倍1：success」，
 * 无法区分「真发了奖励」「今日已签到」还是「只登录没签到」。这里始终用结构化
 * 字段自行拼装：奖励 / 余额 / 连续天数 / 累计天数，原始 message 仅在服务端给出
 * 了非套话内容时作为前缀保留。
 */
function checkinSummary({ alreadyCheckedIn, reward, balance, serverMsg, d }) {
  const parts = [];
  const rewardStr = money(reward);
  if (alreadyCheckedIn) {
    parts.push("今日已签到（未重复发放）");
  } else if (rewardStr && Number(reward) !== 0) {
    parts.push(`签到成功，奖励 ${rewardStr}`);
  } else if (reward != null) {
    // 明确返回 0 与「没有该字段」是两回事，后者说明接口没给奖励信息
    parts.push("签到成功，本次奖励 $0");
  } else {
    parts.push("签到成功（接口未返回奖励字段）");
  }
  const balStr = money(balance);
  if (balStr) parts.push(`余额 ${balStr}`);
  const streak = d.current_streak ?? null;
  if (streak != null) parts.push(`连续 ${streak} 天`);
  const total = d.total_check_in_days ?? null;
  if (total != null) parts.push(`累计 ${total} 天`);
  let out = parts.join("，");
  // 服务端返回了真实说明（非 ok/success 套话）时保留，便于排查
  const msg = String(serverMsg || "").trim();
  if (msg && !/^(ok|success|成功)$/i.test(msg) && !out.includes(msg)) {
    out = `${out}（服务端：${msg}）`;
  }
  return out;
}

function normalizeCheckin(payload) {
  const d = payload?.data || payload || {};
  const reward = d.reward_amount ?? d.reward ?? d.today_reward ?? d.quota_awarded ?? null;
  const alreadyCheckedIn =
    !!d.already_checked_in || /already|已签到/i.test(String(payload?.message || ""));
  const balance = d.balance_after ?? d.balance ?? null;
  const message = checkinSummary({
    alreadyCheckedIn,
    reward,
    balance,
    serverMsg: payload?.message,
    d,
  });
  return {
    success:
      payload?.code === 0 ||
      payload?.success === true ||
      d.checked_in_today === true ||
      !!d.reward_amount ||
      alreadyCheckedIn,
    message,
    reward,
    currentStreak: d.current_streak ?? null,
    totalCheckInDays: d.total_check_in_days ?? null,
    totalReward: d.total_reward ?? null,
    checkInDate: d.check_in_date || null,
    alreadyCheckedIn,
    balance,
    raw: payload,
  };
}

/** 鉴权路径前缀：让日志分得清「直接签到」和「登录后签到」 */
const AUTH_VIA_LABEL = {
  token: "",
  login: "登录后签到：",
  refresh: "刷新 token 后签到：",
  relogin: "重新登录后签到：",
};

/**
 * 鉴权是否失效（token 过期 / 未授权）。
 *
 * 判据：HTTP 401、业务码命中 401/TOKEN_EXPIRED/INVALID_TOKEN/UNAUTHORIZED，或回话是
 * 明确的「token/会话失效」措辞。
 *
 * 文案兜底**刻意收窄**：裸的 token / 登录 / 失效 会把「账号需连续登录 3 天才能签到」
 * 「Token 额度不足」「活动已失效」这类业务失败也算成鉴权失效 —— 于是白跑一次 refresh +
 * 账密登录 + 第二次 POST /api/v1/check-in，而第二次通常回「今日已签到」，反而把真实奖励
 * 文案覆盖掉（历史事故，见下面「成功不重试」那段注释）。k40 实测的
 * HTTP 200 + code:"TOKEN_EXPIRED" 由 code 判据覆盖，不依赖文案。
 */
const AUTH_FAIL_RE =
  /unauthoriz|invalid[_\s-]?token|token[_\s-]*(?:has[_\s-]*)?expired|token\s*(?:已)?(?:过期|失效|无效)|jwt|session\s*(?:expired|invalid|失效|过期)|未授权|未登录|请先登录|重新登录|登录已?(?:过期|失效)/i;

function authExpired(result) {
  if (!result || result.ok) return false;
  const code = String(result?.raw?.code ?? "");
  if (
    result?.httpStatus === 401 ||
    code === "401" ||
    /TOKEN_EXPIRED|INVALID_TOKEN|UNAUTHORIZED/i.test(code)
  ) {
    return true;
  }
  return AUTH_FAIL_RE.test(String(result?.message || ""));
}

/**
 * 「只有真实浏览器能解」的信号：接口自己要求人机验证，或站点回的是 CF / 阿里云 WAF 挑战页。
 *
 * inspectRaw=true 时连原始响应体一起看 —— WAF 挑战页是 HTML，readJson 会把它塞进 raw.raw，
 * 此时 message 只剩「登录失败 HTTP 403」这种无信息文案，光看文案会漏判。
 * 默认只看文案：普通 CF 拦截（比如签到 POST 被挡）仍应先去 gha_api 换出口试，
 * 不该一律跳去更重的浏览器通道。
 */
const BROWSER_ONLY_RE =
  /turnstile|人机|challenge|just a moment|attention required|cdn-cgi|acw_sc__v2|acw_tc|enable javascript and cookies/i;

function browserOnlySignal(result, { inspectRaw = false } = {}) {
  if (!result || result.ok) return false;
  if (BROWSER_ONLY_RE.test(String(result.message || ""))) return true;
  if (!inspectRaw) return false;
  try {
    return BROWSER_ONLY_RE.test(JSON.stringify(result.raw || ""));
  } catch {
    return false;
  }
}

/** 失败结果若带「只有浏览器能解」的信号，补 needsBrowser，供 src/index.js 的降级路由 */
function withBrowserHint(result) {
  if (!result || result.ok || result.needsBrowser) return result;
  return browserOnlySignal(result) ? { ...result, needsBrowser: true } : result;
}

/**
 * 刷新与重新登录都拿不到新 token 时，把「试了什么、为什么不行」拼进 message。
 *
 * 旧实现直接返回原始失败（例如只有一句 "Token has expired"），看不出回退链其实跑过，
 * 面板上读起来像「根本没尝试重新登录」。同时按失败原因标 needsBrowser —— 登录要求
 * 人机验证这类失败纯 HTTP 换多少出口都过不去，只能转浏览器通道（见 src/index.js 的
 * 降级路由）。k40（林夕）2026-09-24 实测就是这一形态：accessToken 过期、
 * refreshToken 失效（REFRESH_TOKEN_INVALID）、登录回 TURNSTILE_VERIFICATION_FAILED。
 */
function annotateAuthFailure(result, { auth, refreshMsg, loginMsg, browserOnly = false }) {
  const details = [auth.accessToken ? "accessToken 已过期或失效" : "没有 accessToken"];
  if (auth.refreshToken) details.push(`刷新失败：${refreshMsg || "未知原因"}`);
  else details.push("没有 refreshToken，无法刷新");
  if (auth.email && auth.password) details.push(`账密登录失败：${loginMsg || "未知原因"}`);
  else details.push("没有账密，无法重新登录");
  const base = String(result?.message || "鉴权失败").trim();
  const annotated = {
    ...result,
    message: `${base}（${details.join("；")}）`.slice(0, 400),
    authFallback: { refreshFailed: refreshMsg || null, reloginFailed: loginMsg || null },
  };
  return browserOnly ? { ...annotated, needsBrowser: true } : withBrowserHint(annotated);
}

/** 失败文案带上业务码里的 reason：变体常只给 reason 不给 message（REFRESH_TOKEN_INVALID 等） */
function failureMessage(data, fallback) {
  const msg = String(data?.message || data?.detail || "").trim();
  const reason = String(data?.reason || "").trim();
  if (msg && reason && !msg.includes(reason)) return `${msg}（${reason}）`;
  return msg || reason || fallback;
}

/* ------------------------------------------------------------------ *
 * 抽奖（林夕 k40 / 百倍 100xlabs 等同系站点）
 *
 * 接口（2026-10-19 线上实测 + 用户 HAR，Bearer 鉴权与签到同一套 token）：
 *   GET  /api/v1/lottery/status?timezone=Asia/Shanghai
 *        → enabled / window_open / can_draw / today_draws / daily_draw_limit /
 *          today_remaining / activity_score / balance / free_balance /
 *          costs{free,activity,paid}{enabled,amount} / prizes[]
 *        device_id 是站点前端自己塞的统计参数，实测可省（带与不带回同一份数据）。
 *   POST /api/v1/lottery  { cost_type, idempotency_key, boost }
 *        → data.draw{...} + activity_score / balance / free_balance /
 *          today_draws / today_remaining
 *   GET  /api/v1/lottery/draws?page=&page_size=     → 历史记录
 *   GET  /api/v1/lottery/summary?timezone=          → 累计统计
 *
 * 站点是「免费额度 / 活动分 / 余额」三选一消耗后抽奖，所以自动抽奖必须自己决定
 * 花哪一种：默认只花免费额度（签到发的额度，花掉不影响别的资产）。活动分
 * （activity_score，上限 100，站点另有「增益」用途）与余额是用户真实资产，
 * 只有显式把 options.lotteryCost 设成 auto / all 才会动 —— 自动任务不该悄悄
 * 花用户的钱。
 * ------------------------------------------------------------------ */

const LOTTERY_PATH = "/api/v1/lottery";
/**
 * 单次抽奖的硬上限：Workers 免费版单次请求子请求上限 50，签到自身还要用掉几个。
 * 面板上手填的次数也受它约束 —— 填 100 只会抽 30。
 */
const LOTTERY_HARD_CAP = 30;
const LOTTERY_COST_LABEL = { free: "免费额度", activity: "活动分", paid: "余额" };
const LOTTERY_COST_MODES = new Set(["free", "auto", "all"]);

/** 自动抽奖开关（照 linux.sb 的 autoGacha / onyxaxis 的 autoClaim 惯例，默认关） */
function autoLotteryOn(channel) {
  const v = channel.options?.autoLottery ?? channel.auth?.autoLottery;
  return v === true || v === "true" || v === 1 || v === "1";
}

/** 消耗方式：free=只花免费额度（默认）；auto=免费额度→活动分；all=再退到余额 */
function lotteryCostMode(channel) {
  const v = String(channel.options?.lotteryCost ?? "").trim().toLowerCase();
  return LOTTERY_COST_MODES.has(v) ? v : "free";
}

/**
 * 本次要抽几次。
 *
 * requested 是面板上「抽奖」按钮旁边那个数字框填的值：
 *   · 填了 → 就按它来（用户明确要几次就抽几次），但仍受 LOTTERY_HARD_CAP 与
 *     今日剩余次数约束；
 *   · 留空 / 自动抽奖 → 用渠道选项 options.lotteryMaxDraws，缺省即硬上限
 *     （= 把今日剩余次数一次抽完）。
 */
function lotteryBudget(channel, remaining, requested) {
  const cap = Number(channel.options?.lotteryMaxDraws);
  const autoCap = Number.isFinite(cap) && cap > 0 ? Math.min(Math.floor(cap), LOTTERY_HARD_CAP) : LOTTERY_HARD_CAP;
  const want = Number(requested);
  const ask = Number.isFinite(want) && want > 0 ? Math.floor(want) : autoCap;
  return Math.max(0, Math.min(remaining, ask, LOTTERY_HARD_CAP));
}

/** 面板手填的次数（无效值一律当成「没填」，交给 lotteryBudget 用默认口径） */
function lotteryRequestedCount(requested) {
  const n = Number(requested);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeLotteryStatus(payload) {
  const d = payload?.data || payload || {};
  const costs = d.costs || {};
  const cost = (key) => ({
    enabled: !!costs[key]?.enabled,
    amount: numOrNull(costs[key]?.amount),
  });
  return {
    enabled: d.enabled !== false,
    windowOpen: d.window_open !== false,
    canDraw: !!d.can_draw,
    title: d.title || "",
    activityScore: numOrNull(d.activity_score),
    activityCap: numOrNull(d.activity_cap),
    balance: numOrNull(d.balance),
    freeBalance: numOrNull(d.free_balance),
    bonusDraws: numOrNull(d.bonus_draws) ?? 0,
    todayDraws: numOrNull(d.today_draws) ?? 0,
    dailyDrawLimit: numOrNull(d.daily_draw_limit),
    todayRemaining: numOrNull(d.today_remaining) ?? 0,
    quotaResetHour: numOrNull(d.quota_reset_hour),
    costs: { free: cost("free"), activity: cost("activity"), paid: cost("paid") },
    prizes: Array.isArray(d.prizes) ? d.prizes : [],
    batchDraw: d.batch_draw || null,
    boost: d.boost || null,
    raw: d,
  };
}

/** 抽奖额度文案：free 是站点额度、paid 是美元、activity 是活动分 */
function lotteryAmountText(type, amount) {
  const n = numOrNull(amount) ?? 0;
  if (type === "paid") return `$${n.toFixed(Math.abs(n) < 0.01 && n !== 0 ? 4 : 2)}`;
  if (type === "activity") return `活动分 ${n}`;
  if (type === "free") return `免费额度 ${n}`;
  return String(n);
}

/**
 * 挑本次抽奖的消耗方式。按 mode 给出的顺序取第一个「已开放 + 余额够」的：
 * 免费额度看 free_balance，活动分看 activity_score，余额看 balance。
 * 一个都不可用时把每个候选的原因拼出来，面板上要能看出「为什么不抽」。
 */
function pickLotteryCost(status, mode) {
  const order = mode === "all" ? ["free", "activity", "paid"] : mode === "auto" ? ["free", "activity"] : ["free"];
  const balanceOf = { free: status.freeBalance, activity: status.activityScore, paid: status.balance };
  const why = [];
  for (const key of order) {
    const label = LOTTERY_COST_LABEL[key];
    const c = status.costs[key];
    const bal = balanceOf[key];
    if (!c.enabled) {
      why.push(`${label}未开放`);
      continue;
    }
    if (c.amount == null || c.amount <= 0) {
      why.push(`${label}消耗额未配置`);
      continue;
    }
    if (bal == null || bal < c.amount) {
      why.push(`${label}不足（需 ${c.amount}，现有 ${bal == null ? "?" : bal}）`);
      continue;
    }
    return { type: key, amount: c.amount, reason: "" };
  }
  return { type: null, amount: null, reason: why.join("；") || "没有可用的消耗方式" };
}

/** 用一次抽奖的响应更新状态（服务端是权威：余额与剩余次数都以它为准） */
function statusAfterDraw(status, data) {
  const d = data?.data || data || {};
  return {
    ...status,
    activityScore: numOrNull(d.activity_score) ?? status.activityScore,
    balance: numOrNull(d.balance) ?? status.balance,
    freeBalance: numOrNull(d.free_balance) ?? status.freeBalance,
    todayDraws: numOrNull(d.today_draws) ?? status.todayDraws,
    todayRemaining: numOrNull(d.today_remaining) ?? status.todayRemaining,
  };
}

/** 汇总本轮所有抽奖记录：中奖/未中奖、按奖品聚合、各类消耗 */
function summarizeDraws(draws) {
  const rows = new Map();
  const cost = { free: 0, activity: 0, paid: 0 };
  const prize = { free: 0, activity: 0, paid: 0 };
  let wins = 0;
  let misses = 0;
  for (const d of draws) {
    const type = String(d?.prize_type || "none");
    const amount = numOrNull(d?.prize_amount_actual ?? d?.prize_amount) ?? 0;
    const key = `${type}:${amount}`;
    const row = rows.get(key) || { type, amount, wins: 0, total: 0 };
    row.wins += 1;
    row.total += amount;
    rows.set(key, row);
    if (type === "none" || amount <= 0) misses += 1;
    else wins += 1;
    cost.free += numOrNull(d?.cost_free) ?? 0;
    cost.activity += numOrNull(d?.cost_activity) ?? 0;
    cost.paid += numOrNull(d?.cost_paid) ?? 0;
    if (prize[type] != null) prize[type] += amount;
  }
  const byPrize = [...rows.values()].sort((a, b) => b.amount - a.amount || b.wins - a.wins);
  return { count: draws.length, wins, misses, cost, prize, byPrize };
}

/** 消耗文案：只列真正花掉的那几类 */
function lotteryCostText(cost) {
  const parts = [];
  for (const key of ["free", "activity", "paid"]) {
    const v = cost?.[key] || 0;
    if (v > 0) parts.push(lotteryAmountText(key, v));
  }
  return parts.join("、");
}

/** 本轮抽奖的一句话结论（面板日志 / TG 推送共用） */
function lotterySummaryText(summary, status, stopReason = "") {
  const parts = [`抽奖 ${summary.count} 次：中奖 ${summary.wins} 次`];
  const won = summary.byPrize.filter((r) => r.type !== "none" && r.amount > 0);
  if (won.length) {
    parts.push(`获得 ${won.map((r) => `${lotteryAmountText(r.type, r.amount)}×${r.wins}`).join("、")}`);
  }
  if (summary.misses) parts.push(`未中奖 ${summary.misses} 次`);
  const costText = lotteryCostText(summary.cost);
  if (costText) parts.push(`消耗 ${costText}`);
  if (status?.dailyDrawLimit != null) parts.push(`今日 ${status.todayDraws}/${status.dailyDrawLimit}`);
  else if (status?.todayDraws != null) parts.push(`今日已抽 ${status.todayDraws} 次`);
  if (stopReason) parts.push(`提前结束：${stopReason}`);
  return parts.join("，");
}

/** 抽奖前的跳过原因（活动关着 / 窗口没开 / 今日抽完），没有则返回空串 */
function lotterySkipReason(status) {
  if (!status.enabled) return "站点未开启抽奖活动";
  if (!status.windowOpen) return "抽奖窗口未开放";
  if (!status.canDraw) return "站点当前不允许抽奖（can_draw=false）";
  if (status.todayRemaining <= 0) {
    return `今日次数已用完（${status.todayDraws}/${status.dailyDrawLimit ?? "?"}）`;
  }
  return "";
}

export const sub2apiAdapter = {
  id: "sub2api",
  name: "Sub2API",
  description: "JWT Bearer 鉴权（k40 / 100xlabs 等同系）；支持自动抽奖",
  // 面板按这个数组在渠道卡片上多渲染一个按钮（见 src/ui.html 的 extraButtons）。
  // 卡片上的「自动抽奖」开关读的也是这里 —— 有 lottery 动作才显示（见 ui.html）。
  // count 表示这个动作在卡片上点开的是一个「抽几次」弹窗（见 src/ui.html 的
  // 抽奖弹窗）：面板据此决定要不要渲染次数选择与日志区。
  actions: [
    {
      action: "lottery",
      label: "抽奖",
      title: "打开抽奖弹窗：选抽几次、看每一次的结果（默认只花免费额度）",
      count: { placeholder: "全部", title: "要抽几次（留空 = 抽完今日剩余次数）" },
    },
  ],
  fields: [
    { key: "baseUrl", label: "站点地址", placeholder: "https://k40.example.com", required: true },
    { key: "auth.email", label: "邮箱", placeholder: "user@example.com" },
    { key: "auth.password", label: "密码", type: "password" },
    { key: "auth.accessToken", label: "Access Token（可选，优先于账密）", type: "password" },
    { key: "auth.refreshToken", label: "Refresh Token（可选）", type: "password" },
    { key: "options.timezone", label: "时区", placeholder: "Asia/Shanghai" },
    {
      key: "options.autoLottery",
      label: "签到后自动抽奖（今日剩余次数一次抽完，结果随签到一起推送）",
      type: "checkbox",
    },
    {
      key: "options.lotteryCost",
      label: "抽奖消耗方式（free=只花免费额度，默认；auto=免费额度→活动分；all=再退到余额）",
      placeholder: "free",
    },
    {
      key: "options.lotteryMaxDraws",
      label: "自动抽奖单次最多抽几次（留空 = 抽完今日剩余；硬上限 30）",
      placeholder: "30",
    },
  ],

  async request(channel, path, { method = "GET", body, token } = {}) {
    const headers = jsonHeaders();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(joinUrl(channel.baseUrl, path), {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    return readJson(res);
  },

  async login(channel) {
    const auth = pickAuth(channel);
    if (auth.accessToken && !auth.password) {
      const me = await this.me({ ...channel, auth: { ...channel.auth, accessToken: auth.accessToken } });
      return {
        ok: me.ok,
        message: me.ok ? "token 有效" : me.message,
        tokens: {
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken || "",
        },
        user: me.user,
        raw: me.raw,
      };
    }
    if (!auth.email || !auth.password) {
      return { ok: false, message: "需要邮箱+密码，或直接填写 accessToken" };
    }
    const body = {
      email: auth.email,
      password: auth.password,
    };
    if (auth.turnstileToken) body.turnstile_token = auth.turnstileToken;

    const res = await this.request(channel, "/api/v1/auth/login", { method: "POST", body });
    const data = res.data || {};
    if (res.status >= 400 || data.code !== 0) {
      return {
        ok: false,
        message: failureMessage(data, `登录失败 HTTP ${res.status}`),
        raw: data,
      };
    }
    const d = data.data || {};
    return {
      ok: true,
      message: data.message || "登录成功",
      tokens: {
        accessToken: d.access_token || "",
        refreshToken: d.refresh_token || "",
        expiresIn: d.expires_in,
        tokenType: d.token_type || "Bearer",
      },
      user: normalizeUser(d.user ? { data: d.user } : d),
      raw: data,
    };
  },

  async refresh(channel) {
    const auth = pickAuth(channel);
    if (!auth.refreshToken) {
      return { ok: false, message: "没有 refreshToken" };
    }
    const res = await this.request(channel, "/api/v1/auth/refresh", {
      method: "POST",
      body: { refresh_token: auth.refreshToken },
    });
    const data = res.data || {};
    if (res.status >= 400 || data.code !== 0) {
      return {
        ok: false,
        message: failureMessage(data, `刷新失败 HTTP ${res.status}`),
        raw: data,
      };
    }
    const d = data.data || {};
    return {
      ok: true,
      tokens: {
        accessToken: d.access_token || "",
        refreshToken: d.refresh_token || auth.refreshToken,
        expiresIn: d.expires_in,
      },
      raw: data,
    };
  },

  async ensureToken(channel) {
    const auth = pickAuth(channel);
    if (auth.accessToken) {
      return { ok: true, accessToken: auth.accessToken, refreshed: false, tokens: null };
    }
    const login = await this.login(channel);
    if (!login.ok) return { ok: false, message: login.message, raw: login.raw };
    return {
      ok: true,
      accessToken: login.tokens.accessToken,
      refreshed: true,
      tokens: login.tokens,
      user: login.user,
    };
  },

  /**
   * runner 会收到第二个参数 authVia，说明本次请求用的是哪条鉴权路径：
   *   token   直接用已存的 accessToken
   *   login   本地没有 token，先账密登录再请求
   *   refresh token 失效，用 refreshToken 换新后重试
   *   relogin token 失效且刷新不可用/失败，重新账密登录后重试
   * 签到日志据此写明「直接签到」还是「登录后签到」——只看 success 分不出这点。
   *
   * 回退链失败的两种形态要分清（旧实现把两者都压成一句原始报错，读不出发生过什么）：
   *   · 换到新 token 后重试仍失败 → 标出「已用新 token 重试」；
   *   · 刷新 / 重登都拿不到 token → 带上各自原因，并按是否只有浏览器能解标 needsBrowser。
   */
  async withAuthRetry(channel, runner) {
    const ensured = await this.ensureToken(channel);
    if (!ensured.ok) {
      // ensureToken 自己就失败（渠道只配账密、没有 accessToken 时走这条）：同样要把
      // 「登录为什么不行」写清并标 needsBrowser —— 否则「登录要 Turnstile」的渠道会被
      // 误降到注定再失败一次的 gha_api，浏览器通道永远轮不到。
      return annotateAuthFailure(
        { ok: false, message: ensured.message, raw: ensured.raw },
        { auth: pickAuth(channel), refreshMsg: "", loginMsg: ensured.message || "" }
      );
    }

    let result = await runner(ensured.accessToken, ensured.refreshed ? "login" : "token");
    // 只有失败的结果才谈得上「鉴权失效」。成功结果一律不重试：否则成功文案里出现
    // 「登录」「token」等字样（如「登录后签到：…」）会被误判成 401，触发第二次
    // POST /api/v1/check-in —— 重复签到请求，且第二次通常报「今日已签到」覆盖真实奖励。
    if (!authExpired(result)) {
      // 签到接口自己要求人机验证（message 含 turnstile 之类）也算「只有浏览器能解」
      // 登录换来的 token 与 runner 自己刷出来的 token 合并：runner 的更晚，优先它
      // （checkin 里顺带的抽奖就可能刷出新 token，不能被登录那份旧的盖回去）
      if (ensured.tokens) result.tokens = { ...ensured.tokens, ...(result.tokens || {}) };
      return withBrowserHint(result);
    }

    // 鉴权失效：先 refreshToken 换新，不行再账密重新登录；两条都拿不到 token 才算失败
    const auth = pickAuth(channel);
    let nextToken = null;
    let tokens = null;
    let retryVia = null;
    let refreshMsg = "";
    let loginMsg = "";
    let authGatedByBrowser = false;
    if (auth.refreshToken) {
      const refreshed = await this.refresh({
        ...channel,
        auth: { ...channel.auth, refreshToken: auth.refreshToken },
      });
      if (refreshed.ok) {
        nextToken = refreshed.tokens.accessToken;
        tokens = refreshed.tokens;
        retryVia = "refresh";
      } else {
        refreshMsg = String(refreshed.message || "");
        if (browserOnlySignal(refreshed, { inspectRaw: true })) authGatedByBrowser = true;
      }
    }
    if (!nextToken && auth.email && auth.password) {
      const login = await this.login({
        ...channel,
        auth: { ...channel.auth, accessToken: "", refreshToken: auth.refreshToken },
      });
      if (login.ok) {
        nextToken = login.tokens.accessToken;
        tokens = login.tokens;
        retryVia = "relogin";
      } else {
        loginMsg = String(login.message || "");
        if (browserOnlySignal(login, { inspectRaw: true })) authGatedByBrowser = true;
      }
    }
    if (nextToken) {
      result = await runner(nextToken, retryVia);
      result.tokens = tokens;
      // 新 token 仍被拒：说明问题不在 token，别让日志看着像「回退没跑」
      if (!result.ok) {
        result.message = `${result.message || "失败"}（已用${
          retryVia === "refresh" ? "刷新" : "重新登录"
        }得到的 token 重试）`;
      }
      return withBrowserHint(result);
    }
    // 两条回退都拿不到 token；ensureToken 阶段登录得到的 tokens 也要带上，供面板写回持久化
    return annotateAuthFailure(
      ensured.tokens && !result.tokens ? { ...result, tokens: ensured.tokens } : result,
      { auth, refreshMsg, loginMsg, browserOnly: authGatedByBrowser }
    );
  },

  async me(channel) {
    return this.withAuthRetry(channel, async (token) => {
      const tz = encodeURIComponent(timezoneOf(channel));
      const res = await this.request(channel, `/api/v1/auth/me?timezone=${tz}`, { token });
      const data = res.data || {};
      if (res.status >= 400 || data.code !== 0) {
        return {
          ok: false,
          httpStatus: res.status,
          message: data.message || `获取用户失败 HTTP ${res.status}`,
          raw: data,
        };
      }
      return {
        ok: true,
        httpStatus: res.status,
        user: normalizeUser(data),
        message: data.message || "ok",
        raw: data,
      };
    });
  },

  async status(channel) {
    return this.withAuthRetry(channel, async (token) => {
      const tz = encodeURIComponent(timezoneOf(channel));
      const res = await this.request(channel, `/api/v1/check-in/status?timezone=${tz}`, { token });
      const data = res.data || {};
      if (res.status >= 400 || data.code !== 0) {
        return {
          ok: false,
          httpStatus: res.status,
          message: data.message || `获取签到状态失败 HTTP ${res.status}`,
          raw: data,
        };
      }
      return {
        ok: true,
        httpStatus: res.status,
        status: normalizeStatus(data),
        message: data.message || "ok",
        raw: data,
      };
    });
  },

  /**
   * 抽奖状态（只读）：活动开关、今日剩余次数、可用消耗方式、余额。
   * 与站点前端一致只带 timezone —— device_id 实测可省。
   *
   * 第二个参数走对象（{ token }）而不是裸字符串：面板的抽奖弹窗会通过
   * runAction 调它（extra 从第二个参数传进来），裸字符串签名会把 extra 对象
   * 当成 token 拼成 "Bearer [object Object]"。
   */
  async lotteryStatus(channel, { token = "" } = {}) {
    const run = async (tk) => {
      const tz = encodeURIComponent(timezoneOf(channel));
      const res = await this.request(channel, `/api/v1/lottery/status?timezone=${tz}`, { token: tk });
      const data = res.data || {};
      if (res.status >= 400 || data.code !== 0) {
        return {
          ok: false,
          httpStatus: res.status,
          message: failureMessage(data, `获取抽奖状态失败 HTTP ${res.status}`),
          raw: data,
        };
      }
      return {
        ok: true,
        httpStatus: res.status,
        status: normalizeLotteryStatus(data),
        message: data.message || "ok",
        raw: data,
      };
    };
    // 调用方（checkin 的顺带抽奖）已经拿着刚签到时用的 token，别再走一遍刷新/登录
    // 调用方（checkin 的顺带抽奖）已经拿着刚签到时用的 token，别再走一遍刷新/登录
    if (token) return run(token);
    return this.withAuthRetry(channel, (tk) => run(tk));
  },

  /** 面板抽奖弹窗用：状态 + 这次能抽几次（今日剩余与消耗方式都算好） */
  async lotteryInfo(channel) {
    const res = await this.lotteryStatus(channel);
    if (!res.ok) return res;
    const status = res.status;
    const mode = lotteryCostMode(channel);
    const cost = pickLotteryCost(status, mode);
    const skip = lotterySkipReason(status);
    return {
      ...res,
      message: skip || cost.reason || `可抽 ${lotteryBudget(channel, status.todayRemaining)} 次`,
      status,
      // 面板读的是 result（publicResult 只透传 result/status，别的顶层字段会被丢掉）
      result: {
        canDraw: !skip && !!cost.type,
        reason: skip || cost.reason || "",
        costMode: mode,
        costType: cost.type,
        costAmount: cost.amount,
        maxDraws: lotteryBudget(channel, status.todayRemaining),
        hardCap: LOTTERY_HARD_CAP,
      },
    };
  },

  /**
   * 抽奖（面板「抽奖」按钮与签到后的自动抽奖都走这里）。
   *
   * 抽几次由 extra.count 决定（面板上「抽奖」按钮旁边的数字框）：
   *   · 填了 N → 抽 N 次（用户明确要几次就抽几次），仍受今日剩余与硬上限约束，
   *     被卡住时在文案里说明（「今日只剩 3 次」/「单次上限 30 次」）；
   *   · 留空 → 按渠道选项 options.lotteryMaxDraws，缺省即把今日剩余次数一次抽完。
   *
   * 循环口径：
   *   · 每抽一次都以服务端回的 today_remaining 为准，抽完即停；
   *   · 每抽一次都用最新余额重新挑消耗方式 —— 免费额度抽干了，mode=auto/all 时
   *     能顺势退到活动分/余额，mode=free（默认）则停下并说明原因；
   *   · 单次上限 LOTTERY_HARD_CAP（可用 options.lotteryMaxDraws 调小）；
   *   · 中途失败保留已抽到的结果，把失败原因一并报出来（抽到的奖品是真实到账的，
   *     不能因为后面一次失败就当成整体失败）。
   * 每次抽奖都带新的 idempotency_key：重复用同一个 key 会被服务端去重，等于白抽。
   */
  async lottery(channel, { count } = {}) {
    return this.withAuthRetry(channel, async (token, authVia) => {
      const statusRes = await this.lotteryStatus(channel, { token });
      if (!statusRes.ok) {
        return { ok: false, httpStatus: statusRes.httpStatus, message: statusRes.message, raw: statusRes.raw };
      }
      let status = statusRes.status;
      const mode = lotteryCostMode(channel);
      const base = {
        enabled: status.enabled,
        canDraw: status.canDraw,
        todayDraws: status.todayDraws,
        dailyDrawLimit: status.dailyDrawLimit,
        todayRemaining: status.todayRemaining,
        costs: status.costs,
        balance: status.balance,
        freeBalance: status.freeBalance,
        activityScore: status.activityScore,
      };

      const skip = lotterySkipReason(status);
      if (skip) {
        return {
          ok: true,
          skipped: true,
          httpStatus: statusRes.httpStatus,
          message: `未抽奖：${skip}`,
          result: { skipped: true, reason: skip, summary: null, draws: [], status: base },
          raw: statusRes.raw,
        };
      }

      let cost = pickLotteryCost(status, mode);
      if (!cost.type) {
        return {
          ok: true,
          skipped: true,
          httpStatus: statusRes.httpStatus,
          message: `未抽奖：${cost.reason}（消耗方式 ${mode}）`,
          result: { skipped: true, reason: cost.reason, costMode: mode, summary: null, draws: [], status: base },
          raw: statusRes.raw,
        };
      }

      // 面板手填的次数（留空 = 按渠道选项 / 硬上限，即抽完今日剩余）
      const want = lotteryRequestedCount(count);
      const remainingAtStart = status.todayRemaining;
      const budget = lotteryBudget(channel, remainingAtStart, want);
      const draws = [];
      let stopReason = "";
      let failure = null;
      let lastRaw = statusRes.raw;
      for (let i = 0; i < budget; i += 1) {
        if (i > 0) {
          // 上一抽之后余额可能已经不够了：重新挑一次，挑不到就停
          const next = pickLotteryCost(status, mode);
          if (!next.type) {
            stopReason = next.reason;
            break;
          }
          cost = next;
        }
        const res = await this.request(channel, LOTTERY_PATH, {
          method: "POST",
          token,
          body: { cost_type: cost.type, idempotency_key: crypto.randomUUID(), boost: false },
        });
        const data = res.data || {};
        if (res.status >= 400 || data.code !== 0) {
          failure = {
            httpStatus: res.status,
            message: failureMessage(data, `抽奖失败 HTTP ${res.status}`),
            raw: data,
          };
          break;
        }
        lastRaw = data;
        const draw = data.data?.draw || null;
        if (draw) draws.push(draw);
        status = statusAfterDraw(status, data);
        if (status.todayRemaining <= 0) break;
      }

      // 填的次数比实际能抽的多：说明白是被今日剩余次数还是被硬上限卡住了
      if (!stopReason && !failure && want && draws.length < want) {
        stopReason =
          draws.length >= LOTTERY_HARD_CAP
            ? `单次上限 ${LOTTERY_HARD_CAP} 次`
            : `今日只剩 ${remainingAtStart} 次`;
      }
      const summary = summarizeDraws(draws);
      const finalStatus = {
        ...base,
        todayDraws: status.todayDraws,
        todayRemaining: status.todayRemaining,
        balance: status.balance,
        freeBalance: status.freeBalance,
        activityScore: status.activityScore,
      };
      const result = {
        count: summary.count,
        wins: summary.wins,
        misses: summary.misses,
        cost: summary.cost,
        prize: summary.prize,
        byPrize: summary.byPrize,
        draws: draws.map((d) => ({
          id: d.id,
          prize_type: d.prize_type,
          prize_amount: d.prize_amount,
          prize_amount_actual: d.prize_amount_actual,
          cost_type: d.cost_type,
          cost_free: d.cost_free,
          cost_activity: d.cost_activity,
          cost_paid: d.cost_paid,
          status: d.status,
          created_at: d.created_at,
        })),
        costMode: mode,
        costType: cost.type,
        stopReason: stopReason || null,
        requested: want,
        failure: failure ? { httpStatus: failure.httpStatus, message: failure.message } : null,
        status: finalStatus,
      };

      // 一次都没抽成（第一抽就失败）才算失败；抽到过奖品就是成功，失败原因写进文案
      if (!draws.length && failure) {
        return {
          ok: false,
          httpStatus: failure.httpStatus,
          message: `抽奖失败：${failure.message}`,
          result,
          raw: failure.raw,
          authVia,
        };
      }
      let message = lotterySummaryText(summary, finalStatus, stopReason);
      if (failure) message += `；中途失败：${failure.message}`;
      return {
        ok: true,
        httpStatus: lastRaw === statusRes.raw ? statusRes.httpStatus : 200,
        message,
        result,
        raw: lastRaw,
        authVia,
      };
    });
  },

  /**
   * 签到顺带自动抽奖（渠道选项 options.autoLottery，默认关）。
   * 抽奖失败不推翻签到结论，只追加说明（与 linux.sb 的 autoGacha 同规矩）；
   * 顺带把抽奖过程中刷新出来的 token 交回给调用方持久化。
   */
  async autoLotteryNote(channel, token) {
    if (!autoLotteryOn(channel)) return { note: "", tokens: null, lottery: null };
    let r;
    try {
      r = await this.lottery({
        ...channel,
        auth: { ...(channel.auth || {}), accessToken: token || channel.auth?.accessToken || "" },
      });
    } catch (err) {
      return { note: ` · 抽奖异常：${err.message || String(err)}`, tokens: null, lottery: { ok: false, message: err.message || String(err) } };
    }
    const lottery = {
      ok: !!r.ok,
      skipped: !!r.skipped,
      message: r.message || "",
      result: r.result || null,
    };
    return {
      note: r.ok ? ` · ${r.message}` : ` · 抽奖失败：${r.message}`,
      tokens: r.tokens || null,
      lottery,
    };
  },

  async checkin(channel) {
    return this.withAuthRetry(channel, async (token, authVia) => {
      const auth = pickAuth(channel);
      // HAR observed empty JSON body {}; timezone/turnstile are optional extras
      const body = {};
      if (channel.options?.sendTimezone !== false) body.timezone = timezoneOf(channel);
      if (auth.turnstileToken) body.turnstile_token = auth.turnstileToken;
      const res = await this.request(channel, "/api/v1/check-in", {
        method: "POST",
        body,
        token,
      });
      const data = res.data || {};
      const normalized = normalizeCheckin(data);
      // success when code===0, or already checked in messages
      const ok =
        res.status < 400 &&
        (data.code === 0 ||
          normalized.alreadyCheckedIn ||
          normalized.success ||
          data.success === true);
      if (!ok) {
        return {
          ok: false,
          httpStatus: res.status,
          message: data.message || data.detail || `签到失败 HTTP ${res.status}`,
          result: normalized,
          raw: data,
        };
      }
      // 签到成功后顺带自动抽奖（渠道选项 options.autoLottery，默认关）。
      // 「今日已签到」这条路径也要抽：定时任务常在用户手动签过的日子拿到这个回话，
      // 而抽奖次数与签到是两回事（与 onyxaxis 的 autoClaim 同规矩）。
      // 抽奖失败不推翻签到结论，只追加说明。
      const lot = await this.autoLotteryNote(channel, token);
      return {
        ok: true,
        httpStatus: res.status,
        result: lot.lottery ? { ...normalized, lottery: lot.lottery } : normalized,
        // 自行拼装的结论优先于服务端的 "success" 套话，否则日志只剩「渠道名：success」
        message: `${AUTH_VIA_LABEL[authVia] || ""}${normalized.message || data.message || "签到成功"}${lot.note}`,
        raw: data,
        authVia: authVia || null,
        tokens: lot.tokens || undefined,
      };
    });
  },
};
