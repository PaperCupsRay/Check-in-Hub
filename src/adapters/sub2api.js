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

export const sub2apiAdapter = {
  id: "sub2api",
  name: "Sub2API",
  description: "JWT Bearer 鉴权（k40 / 100xlabs 等同系）",
  fields: [
    { key: "baseUrl", label: "站点地址", placeholder: "https://k40.example.com", required: true },
    { key: "auth.email", label: "邮箱", placeholder: "user@example.com" },
    { key: "auth.password", label: "密码", type: "password" },
    { key: "auth.accessToken", label: "Access Token（可选，优先于账密）", type: "password" },
    { key: "auth.refreshToken", label: "Refresh Token（可选）", type: "password" },
    { key: "options.timezone", label: "时区", placeholder: "Asia/Shanghai" },
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
      if (ensured.tokens) result.tokens = ensured.tokens;
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
      return {
        ok: true,
        httpStatus: res.status,
        result: normalized,
        // 自行拼装的结论优先于服务端的 "success" 套话，否则日志只剩「渠道名：success」
        message: `${AUTH_VIA_LABEL[authVia] || ""}${normalized.message || data.message || "签到成功"}`,
        raw: data,
        authVia: authVia || null,
      };
    });
  },
};
