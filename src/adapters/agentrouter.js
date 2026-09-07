/**
 * AgentRouter adapter (NewAPI family, special-cased)
 *
 * Observed / reverse-engineered from:
 *   https://github.com/millylee/anyrouter-check-in
 *
 * Domain: https://agentrouter.org
 *
 * Differences vs generic NewAPI:
 * 1. No dedicated sign-in API — querying GET /api/user/self auto-triggers daily check-in
 * 2. Residual session cookies are flaky; login should logout/clear first, then re-login
 * 3. Needs New-Api-User header (user id)
 * 4. Often behind WAF (acw_tc); pure fetch may still need a browser-copied cookie
 * 5. Community scripts often require proxy for stable access
 *
 * Auth: session Cookie + New-Api-User
 * Login: POST /api/user/login (after logout)
 * User / Check-in: GET /api/user/self
 */

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function parseSetCookie(res) {
  const cookies = [];
  if (typeof res.headers.getSetCookie === "function") {
    for (const c of res.headers.getSetCookie()) cookies.push(c);
  } else {
    const single = res.headers.get("set-cookie");
    if (single) cookies.push(single);
  }
  const pairs = [];
  for (const c of cookies) {
    const first = String(c).split(";")[0];
    if (first && first.includes("=")) pairs.push(first);
  }
  return pairs;
}

function mergeCookie(existing, setPairs) {
  const map = new Map();
  for (const part of String(existing || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const part of setPairs || []) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function dropSessionCookies(cookie) {
  // Keep WAF cookies (acw_tc etc.), drop auth session so re-login is clean
  const keep = [];
  for (const part of String(cookie || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    if (
      name === "session" ||
      name === "sessionid" ||
      name === "token" ||
      name.startsWith("session") ||
      name.includes("auth") ||
      name === "jwt" ||
      name === "access_token"
    ) {
      continue;
    }
    keep.push(part);
  }
  return keep.join("; ");
}

async function readJson(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return {
    status: res.status,
    ok: res.ok,
    data,
    headers: res.headers,
    setCookies: parseSetCookie(res),
  };
}

function pickAuth(channel) {
  const auth = channel.auth || {};
  return {
    username: auth.username || auth.email || "",
    password: auth.password || "",
    cookie: auth.cookie || auth.session || "",
    userId: auth.userId || auth.newApiUser || "",
    token: auth.token || auth.accessToken || "",
  };
}

function authHeaders(channel, cookie) {
  const auth = pickAuth(channel);
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  };
  if (cookie || auth.cookie) headers.Cookie = cookie || auth.cookie;
  // HTTP 头名不区分大小写：同时写 New-Api-User 和 new-api-user 会被 fetch
  // 合并成 "1750, 1750"，服务端 strconv.Atoi 解析失败并报「格式错误」。只能写一次。
  if (auth.userId) {
    headers["New-Api-User"] = String(auth.userId);
  }
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const origin = String(channel.baseUrl || "").replace(/\/+$/, "");
  if (origin) {
    headers.Origin = origin;
    headers.Referer = `${origin}/`;
  }
  return headers;
}

function pickDisplayQuota(u = {}) {
  const candidates = [
    u.quota,
    u.gift_quota,
    u.total_quota,
    u.aff_quota,
    u.aff_history_quota,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  if (u.quota != null) return Number(u.quota) || 0;
  if (u.gift_quota != null) return Number(u.gift_quota) || 0;
  if (u.total_quota != null) return Number(u.total_quota) || 0;
  return null;
}

function normalizeUser(payload) {
  const u = payload?.data || payload || {};
  const displayQuota = pickDisplayQuota(u);
  return {
    id: u.id,
    username: u.username || u.display_name || "",
    displayName: u.display_name || u.username || "",
    group: u.group,
    quota: displayQuota,
    walletQuota: u.quota,
    giftQuota: u.gift_quota ?? null,
    totalQuota: u.total_quota ?? null,
    usedQuota: u.used_quota,
    requestCount: u.request_count,
    role: u.role,
    status: u.status,
    raw: u,
  };
}

function formatUsd(quota, perUnit = 500000) {
  const q = Number(quota);
  const p = Number(perUnit) || 500000;
  if (!Number.isFinite(q) || !p) return null;
  const n = q / p;
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `$${n.toFixed(digits)}`;
}

function buildQuotaMessage(user) {
  if (!user) return "";
  const parts = [];
  if (user.quota != null) {
    const usd = formatUsd(user.quota);
    if (usd) parts.push(`余额 ${usd}`);
  }
  if (user.usedQuota != null) {
    const usd = formatUsd(user.usedQuota);
    if (usd) parts.push(`已用 ${usd}`);
  }
  return parts.join(" · ");
}

export const agentrouterAdapter = {
  id: "agentrouter",
  name: "AgentRouter",
  description: "NewAPI 变体：先退出再登录；签到=查询用户信息自动完成",
  fields: [
    {
      key: "baseUrl",
      label: "站点地址",
      placeholder: "https://agentrouter.org",
      required: true,
    },
    { key: "auth.username", label: "用户名/邮箱", placeholder: "username" },
    { key: "auth.password", label: "密码", type: "password" },
    {
      key: "auth.cookie",
      label: "Cookie（可选；建议含 session，WAF 站点可附带 acw_tc）",
      type: "password",
    },
    {
      key: "auth.userId",
      label: "New-Api-User（用户 ID，推荐）",
      placeholder: "12345",
    },
    {
      key: "auth.token",
      label: "Bearer Token / system access token（可选）",
      type: "password",
    },
    {
      key: "options.forceLogout",
      label: "登录前强制退出（true/false，默认 true）",
      placeholder: "true",
    },
  ],

  async request(channel, path, { method = "GET", body, cookie } = {}) {
    const res = await fetch(joinUrl(channel.baseUrl, path), {
      method,
      headers: authHeaders(channel, cookie),
      body: body == null ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    return readJson(res);
  },

  /**
   * Best-effort logout. AgentRouter/community scripts treat residual session as toxic.
   * We try common NewAPI logout endpoints, then drop session cookies locally.
   */
  async logout(channel, cookie = "") {
    const auth = pickAuth(channel);
    let current = cookie || auth.cookie || "";
    const paths = [
      { method: "POST", path: "/api/user/logout" },
      { method: "GET", path: "/api/user/logout" },
      { method: "POST", path: "/api/user/logout/" },
    ];
    let last = null;
    for (const item of paths) {
      try {
        const res = await this.request(channel, item.path, {
          method: item.method,
          body: item.method === "POST" ? {} : undefined,
          cookie: current,
        });
        last = res;
        if (res.setCookies?.length) current = mergeCookie(current, res.setCookies);
        // Any non-5xx is fine; we still clear local session cookies after
        if (res.status < 500) break;
      } catch {
        /* ignore and try next */
      }
    }
    current = dropSessionCookies(current);
    return {
      ok: true,
      message: "已尝试退出并清理会话 cookie",
      cookie: current,
      raw: last?.data ?? null,
      httpStatus: last?.status ?? null,
    };
  },

  async login(channel) {
    const auth = pickAuth(channel);
    const forceLogout =
      channel.options?.forceLogout === false ||
      channel.options?.forceLogout === "false" ||
      String(channel.auth?.forceLogout || "").toLowerCase() === "false"
        ? false
        : true;

    // Cookie-only validation path: still optional logout+recheck when forceLogout
    if (auth.cookie && !auth.password) {
      let cookie = auth.cookie;
      if (forceLogout) {
        const out = await this.logout(channel, cookie);
        cookie = out.cookie || dropSessionCookies(cookie);
        // Cookie-only mode cannot re-login after logout; keep original cookie for me()
        // and only drop if user explicitly wants pure re-auth via password.
        cookie = auth.cookie;
      }
      const me = await this.me({
        ...channel,
        auth: { ...channel.auth, cookie },
      });
      return {
        ok: me.ok,
        message: me.ok
          ? `cookie 有效${me.user ? ` · ${buildQuotaMessage(me.user)}` : ""}`
          : me.message || "cookie 无效，建议退出后重新登录并更新 Cookie",
        tokens: {
          cookie: me.tokens?.cookie || cookie,
          userId: me.user?.id || auth.userId || "",
        },
        user: me.user,
        raw: me.raw,
      };
    }

    if (!auth.username || !auth.password) {
      return {
        ok: false,
        message: "需要用户名+密码，或直接粘贴 Cookie（含 session）",
      };
    }

    let cookie = auth.cookie || "";
    if (forceLogout) {
      const out = await this.logout(channel, cookie);
      cookie = out.cookie || "";
    } else {
      cookie = dropSessionCookies(cookie);
    }

    const attempts = [
      { path: "/api/user/login", body: { username: auth.username, password: auth.password } },
      { path: "/api/user/login", body: { username: auth.username, password: auth.password, turnstile: "" } },
      { path: "/api/user/login", body: { email: auth.username, password: auth.password } },
    ];

    let last = null;
    for (const attempt of attempts) {
      const res = await this.request(channel, attempt.path, {
        method: "POST",
        body: attempt.body,
        cookie,
      });
      last = res;
      if (res.setCookies?.length) cookie = mergeCookie(cookie, res.setCookies);
      const data = res.data || {};
      if (res.status < 400 && (data.success === true || data.data)) {
        // Confirm session via /api/user/self (also triggers auto check-in on AgentRouter)
        const meRes = await this.request(channel, "/api/user/self", { cookie });
        if (meRes.setCookies?.length) cookie = mergeCookie(cookie, meRes.setCookies);
        const user =
          meRes.data?.success !== false ? normalizeUser(meRes.data) : normalizeUser(data);
        return {
          ok: true,
          message: `登录成功（已先退出再登录）${user ? ` · ${buildQuotaMessage(user)}` : ""}`,
          tokens: {
            cookie,
            userId: user?.id || auth.userId || "",
          },
          user,
          raw: data,
        };
      }
    }

    const data = last?.data || {};
    return {
      ok: false,
      message:
        data.message ||
        `登录失败 HTTP ${last?.status}。若站点有 WAF，请先在浏览器登录后复制完整 Cookie`,
      raw: data,
    };
  },

  async ensureSession(channel) {
    const auth = pickAuth(channel);
    if (auth.cookie || auth.token) {
      return { ok: true, cookie: auth.cookie || "", tokens: null };
    }
    const login = await this.login(channel);
    if (!login.ok) return { ok: false, message: login.message, raw: login.raw };
    return {
      ok: true,
      cookie: login.tokens.cookie,
      tokens: login.tokens,
      user: login.user,
    };
  },

  async me(channel) {
    const ensured = await this.ensureSession(channel);
    if (!ensured.ok) return ensured;
    const res = await this.request(channel, "/api/user/self", {
      cookie: ensured.cookie,
    });
    const data = res.data || {};
    if (res.status >= 400 || data.success === false) {
      // Stale session: one retry with forced re-login if password available
      const auth = pickAuth(channel);
      if (auth.username && auth.password) {
        const relogin = await this.login({
          ...channel,
          auth: { ...channel.auth, cookie: ensured.cookie },
          options: { ...(channel.options || {}), forceLogout: true },
        });
        if (relogin.ok) {
          return {
            ok: true,
            httpStatus: 200,
            user: relogin.user,
            message: `会话失效已重登 · ${buildQuotaMessage(relogin.user) || relogin.message}`,
            raw: relogin.raw,
            tokens: relogin.tokens,
          };
        }
      }
      return {
        ok: false,
        httpStatus: res.status,
        message: data.message || `获取用户失败 HTTP ${res.status}`,
        raw: data,
        tokens: ensured.tokens,
      };
    }
    const user = normalizeUser(data);
    const tokens = ensured.tokens || {};
    if (user.id && !tokens.userId) tokens.userId = user.id;
    if (ensured.cookie) tokens.cookie = ensured.cookie;
    if (res.setCookies?.length) {
      tokens.cookie = mergeCookie(ensured.cookie, res.setCookies);
    }
    return {
      ok: true,
      httpStatus: res.status,
      user,
      message: buildQuotaMessage(user) || data.message || "ok",
      raw: data,
      tokens: Object.keys(tokens).length ? tokens : null,
    };
  },

  /**
   * AgentRouter has no dedicated check-in status endpoint in community scripts.
   * Surface user quota as status, and try optional /api/user/checkin?month= for NewAPI compat.
   */
  async status(channel) {
    const me = await this.me(channel);
    if (!me.ok) return me;

    let monthStatus = null;
    try {
      const now = new Date();
      const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const res = await this.request(
        channel,
        `/api/user/checkin?month=${encodeURIComponent(month)}`,
        { cookie: me.tokens?.cookie || pickAuth(channel).cookie }
      );
      const data = res.data || {};
      if (res.status < 400 && data.success !== false) {
        const d = data.data || data;
        const stats = d.stats || d;
        monthStatus = {
          enabled: d.enabled !== false,
          checkedInToday: !!(stats.checked_in_today ?? d.checked_in_today),
          checkinCount:
            stats.checkin_count ??
            stats.total_checkins ??
            d.checkin_count ??
            null,
          totalQuota: stats.total_quota ?? d.total_quota ?? null,
          month: d.month || month,
          raw: d,
        };
      }
    } catch {
      /* optional */
    }

    return {
      ok: true,
      httpStatus: me.httpStatus,
      user: me.user,
      status: monthStatus || {
        enabled: true,
        note: "AgentRouter 通过查询用户信息自动签到，无独立状态接口",
      },
      message:
        [
          buildQuotaMessage(me.user),
          monthStatus?.checkedInToday != null
            ? monthStatus.checkedInToday
              ? "今日已签到"
              : "今日未签到/状态未知"
            : "状态=用户信息（自动签到型）",
          monthStatus?.checkinCount != null
            ? `本月签到 ${monthStatus.checkinCount} 次`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || "ok",
      raw: me.raw,
      tokens: me.tokens,
    };
  },

  /**
   * Check-in for AgentRouter = fetch user self (auto check-in side effect).
   * Optionally also try POST /api/user/sign_in and /api/user/checkin for forks.
   */
  async checkin(channel) {
    const auth = pickAuth(channel);
    // 本站签到机制：奖励在【登录时】发放（login/OAuth 回调里的 checked_in 字段），
    // 没有独立签到 API；访问令牌/旧会话调 self 不触发。
    // 因此有账密时，每日首次 checkin 直接走完整 logout→login 流程来触发签到。
    if (auth.username && auth.password) {
      const loginRes = await this.login(channel);
      if (!loginRes.ok) {
        return {
          ok: false,
          httpStatus: loginRes.httpStatus,
          message: `登录签到失败：${loginRes.message}`,
          raw: loginRes.raw,
        };
      }
      const after = await this.me(channel);
      const checkedIn = loginRes.raw?.data?.checked_in === true;
      return {
        ok: true,
        httpStatus: 200,
        user: after.user || loginRes.user,
        result: {
          success: true,
          message: checkedIn
            ? "签到成功（登录触发），新增额度已到账"
            : "登录成功（今日已通过登录触发过签到）",
          reward: null,
          alreadyCheckedIn: !checkedIn,
          via: "/api/user/login",
        },
        message: [
          checkedIn ? "✅ 签到成功（登录触发）" : "今日已签到（登录时已触发）",
          buildQuotaMessage(after.user || loginRes.user),
        ]
          .filter(Boolean)
          .join(" · "),
        raw: { login: loginRes.raw, after: after.raw },
        tokens: loginRes.tokens,
      };
    }

    // 无账密：无法触发登录签到，如实告知
    return {
      ok: false,
      message:
        "本站签到只能通过登录触发（无独立签到 API），访问令牌不触发。" +
        "请在渠道中填写邮箱+密码以启用自动签到，或每日手动登录一次站点。",
    };
  },

  async checkinLegacy(channel) {
    const before = await this.me(channel);
    if (!before.ok) return before;

    const cookie = before.tokens?.cookie || pickAuth(channel).cookie || "";
    const tried = [];

    // Community default: sign_in_path is null — user/self already counts as check-in.
    // Still try common endpoints once for NewAPI/AnyRouter-like forks of the same UI.
    for (const path of ["/api/user/sign_in", "/api/user/checkin"]) {
      try {
        const res = await this.request(channel, path, {
          method: "POST",
          body: {},
          cookie,
        });
        tried.push({ path, status: res.status, data: res.data });
        const data = res.data || {};
        const msg = String(data.message || data.msg || "");
        if (
          res.status < 400 &&
          (data.success === true ||
            data.ret === 1 ||
            data.code === 0 ||
            /already|已签到|重复/i.test(msg))
        ) {
          const after = await this.me({
            ...channel,
            auth: { ...channel.auth, cookie, userId: before.user?.id || pickAuth(channel).userId },
          });
          const reward =
            after.ok && before.user?.quota != null && after.user?.quota != null
              ? Number(after.user.quota) - Number(before.user.quota)
              : data.data?.quota_awarded ?? null;
          return {
            ok: true,
            httpStatus: res.status,
            user: after.user || before.user,
            result: {
              success: true,
              message: msg || "签到成功",
              reward: reward != null && Number.isFinite(Number(reward)) ? Number(reward) : null,
              alreadyCheckedIn: /already|已签到|重复/i.test(msg),
              via: path,
            },
            message: [
              msg && !/\d{5,}/.test(msg) ? msg : "签到成功",
              reward != null && Number(reward) !== 0
                ? `奖励 ${formatUsd(reward) || ""}`.trim()
                : null,
              buildQuotaMessage(after.user || before.user),
            ]
              .filter(Boolean)
              .join(" · "),
            raw: { endpoint: path, data, before: before.raw, after: after.raw },
            tokens: after.tokens || before.tokens,
          };
        }
      } catch (e) {
        tried.push({ path, error: e.message || String(e) });
      }
    }

    // Fallback: user/self already requested above = AgentRouter auto check-in
    const after = await this.me({
      ...channel,
      auth: {
        ...channel.auth,
        cookie,
        userId: before.user?.id || pickAuth(channel).userId,
      },
    });
    const reward =
      after.ok && before.user?.quota != null && after.user?.quota != null
        ? Number(after.user.quota) - Number(before.user.quota)
        : null;

    return {
      ok: after.ok,
      httpStatus: after.httpStatus || before.httpStatus,
      user: after.user || before.user,
      result: {
        success: after.ok,
        message: "通过查询用户信息完成自动签到",
        reward: reward != null && Number.isFinite(reward) ? reward : null,
        alreadyCheckedIn: reward === 0,
        via: "/api/user/self",
      },
      message: [
        after.ok ? "自动签到完成" : after.message || "签到失败",
        reward != null && reward !== 0
          ? `今日奖励 +${formatUsd(Math.abs(reward)) || "?"}`
          : reward === 0
            ? "今日奖励已入账（本站签到为被动式：查询用户信息即触发，当日首次查询时发放）"
            : null,
        buildQuotaMessage(after.user || before.user),
      ]
        .filter(Boolean)
        .join(" · "),
      raw: { tried, before: before.raw, after: after.raw },
      tokens: after.tokens || before.tokens,
    };
  },
};
