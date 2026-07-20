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

function normalizeCheckin(payload) {
  const d = payload?.data || payload || {};
  const reward = d.reward_amount ?? d.reward ?? d.today_reward ?? d.quota_awarded ?? null;
  const alreadyCheckedIn =
    !!d.already_checked_in || /already|已签到/i.test(String(payload?.message || ""));
  const balance = d.balance_after ?? d.balance ?? null;
  let message = payload?.message || "";
  if (!message || /^(ok|success)$/i.test(message)) {
    if (alreadyCheckedIn) message = "今日已签到";
    else if (reward != null) {
      const n = Number(reward);
      message = Number.isFinite(n)
        ? `签到成功，奖励 $${n.toFixed(Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 4 : 2)}`
        : "签到成功";
    } else message = "签到成功";
  }
  if (balance != null) {
    const n = Number(balance);
    if (Number.isFinite(n) && !/\$/.test(String(message))) {
      message = `${message}，余额 $${n.toFixed(Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;
    }
  }
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

  async withAuthRetry(channel, runner) {
    let ensured = await this.ensureToken(channel);
    if (!ensured.ok) return { ok: false, message: ensured.message, raw: ensured.raw };

    let result = await runner(ensured.accessToken);
    const unauthorized =
      result?.httpStatus === 401 ||
      result?.raw?.code === 401 ||
      /unauthor|token|session|登录/i.test(String(result?.message || ""));

    if (unauthorized) {
      const auth = pickAuth(channel);
      let nextToken = null;
      let tokens = null;
      if (auth.refreshToken) {
        const refreshed = await this.refresh({
          ...channel,
          auth: { ...channel.auth, refreshToken: auth.refreshToken },
        });
        if (refreshed.ok) {
          nextToken = refreshed.tokens.accessToken;
          tokens = refreshed.tokens;
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
        }
      }
      if (nextToken) {
        result = await runner(nextToken);
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
    return this.withAuthRetry(channel, async (token) => {
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
        message: data.message || normalized.message || "签到成功",
        raw: data,
      };
    });
  },
};
