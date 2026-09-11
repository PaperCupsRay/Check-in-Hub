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
        message: data.message || data.detail || `登录失败 HTTP ${res.status}`,
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
        message: data.message || `刷新失败 HTTP ${res.status}`,
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
   */
  async withAuthRetry(channel, runner) {
    let ensured = await this.ensureToken(channel);
    if (!ensured.ok) return { ok: false, message: ensured.message, raw: ensured.raw };

    let result = await runner(ensured.accessToken, ensured.refreshed ? "login" : "token");
    // 只有失败的结果才谈得上「鉴权失效」。成功结果一律不重试：否则成功文案里出现
    // 「登录」「token」等字样（如「登录后签到：…」）会被误判成 401，触发第二次
    // POST /api/v1/check-in —— 重复签到请求，且第二次通常报「今日已签到」覆盖真实奖励。
    const unauthorized =
      !result?.ok &&
      (result?.httpStatus === 401 ||
        result?.raw?.code === 401 ||
        /unauthor|token|session|登录/i.test(String(result?.message || "")));

    if (unauthorized) {
      const auth = pickAuth(channel);
      let nextToken = null;
      let tokens = null;
      let retryVia = null;
      if (auth.refreshToken) {
        const refreshed = await this.refresh({
          ...channel,
          auth: { ...channel.auth, refreshToken: auth.refreshToken },
        });
        if (refreshed.ok) {
          nextToken = refreshed.tokens.accessToken;
          tokens = refreshed.tokens;
          retryVia = "refresh";
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
        }
      }
      if (nextToken) {
        result = await runner(nextToken, retryVia);
        result.tokens = tokens;
      }
    } else if (ensured.tokens) {
      result.tokens = ensured.tokens;
    }
    return result;
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
