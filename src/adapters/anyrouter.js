/**
 * AnyRouter adapter (NewAPI / OneAPI family)
 *
 * Based on community script:
 *   https://github.com/millylee/anyrouter-check-in
 *
 * Domain default: https://anyrouter.top
 *
 * Key differences vs generic NewAPI:
 * 1. Check-in is POST /api/user/sign_in (NOT /api/user/checkin)
 * 2. Balance comes from GET /api/user/self → data.quota / data.used_quota
 *    Display USD = quota / 500000 (community default)
 * 3. Request header `new-api-user: <id>` is required for most cookie sessions
 * 4. Site may sit behind WAF (acw_tc); pure Workers fetch can still fail —
 *    prefer browser-copied session cookie, or password login when available
 *
 * Flow (aligned with millylee):
 *   before = GET /api/user/self
 *   POST /api/user/sign_in
 *   after  = GET /api/user/self
 *   reward ≈ after.quota - before.quota
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

function normalizeCookie(input) {
  let s = String(input || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!s) return "";
  s = s.replace(/^cookie\s*:\s*/i, "");
  if (s.includes("\n")) {
    const pairs = [];
    for (const line of s.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (/^(name|cookie)\b/i.test(line) && !line.includes("=")) continue;
      if (line.includes("\t")) {
        const [n, ...rest] = line.split("\t");
        if (n && rest.length) pairs.push(`${n.trim()}=${rest.join("\t").trim()}`);
        continue;
      }
      if (line.includes("=")) pairs.push(line.replace(/;\s*$/, ""));
    }
    s = pairs.join("; ");
  }
  return s
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const name = p.split("=")[0].trim().toLowerCase();
      if (!name || name.startsWith("_cfpre_")) return false;
      return true;
    })
    .join("; ");
}

function responseTextHint(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data.raw === "string") return data.raw;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/**
 * Aliyun WAF / acw_sc__v2 / Cloudflare interstitials return HTML/JS even with HTTP 200.
 * Must not treat as NewAPI JSON success (otherwise quota stays null with ok:true).
 */
function isWafOrChallengeBody(data, status) {
  const raw = responseTextHint(data);
  if (!raw) return false;
  if (
    /acw_sc__v2|acw_tc|var arg1=|aliyun_waf|waf.?cookie|just a moment|cf-browser-verification|attention required|cdn-cgi\/challenge|enable javascript and cookies/i.test(
      raw
    )
  ) {
    return true;
  }
  if (/<!doctype html|<html[\s>]|<script>/i.test(raw) && !/^\s*\{/.test(raw.trim())) {
    return true;
  }
  // HTML with 403/503/429
  if (/<!doctype html|<html[\s>]/i.test(raw) && (status === 403 || status === 503 || status === 429)) {
    return true;
  }
  return false;
}

function isValidUserSelfPayload(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.raw === "string" && !data.success && data.data == null) return false;
  // NewAPI: { success: true, data: { id, quota, ... } }
  if (data.success === true && data.data && typeof data.data === "object") return true;
  // Some forks return user object at top level with id + quota fields
  if (data.id != null && (data.quota != null || data.username != null || data.display_name != null)) {
    return true;
  }
  return false;
}

function wafBlockMessage(action = "请求") {
  return (
    `${action}被目标站 WAF 拦截（返回 acw_sc__v2 挑战脚本，不是 JSON）。` +
    `Cloudflare Workers 出口无法执行浏览器 JS 解挑战；` +
    `公开库 millylee/anyrouter-check-in 用本机 Playwright 先拿 WAF cookie 再请求。` +
    `可行方案：①在已登录的 anyrouter.top 控制台直接 fetch 查询；` +
    `②用本机/青龙脚本签到；③若有住宅代理+浏览器环境再代发。` +
    `仅粘贴 session 往往不够，需要浏览器实时解出的 acw_sc__v2 / acw_tc。`
  );
}

function truncateRaw(data, max = 400) {
  if (data == null) return data;
  if (typeof data === "string") {
    return data.length > max ? data.slice(0, max) + `…(+${data.length - max} chars)` : data;
  }
  if (typeof data === "object" && typeof data.raw === "string" && data.raw.length > max) {
    return {
      ...data,
      raw: data.raw.slice(0, max) + `…(+${data.raw.length - max} chars)`,
      _waf: isWafOrChallengeBody(data, 200),
    };
  }
  return data;
}

async function readJson(res) {
  const text = await res.text();
  let data = null;
  let jsonOk = false;
  try {
    data = text ? JSON.parse(text) : null;
    jsonOk = true;
  } catch {
    data = { raw: text };
    jsonOk = false;
  }
  return {
    status: res.status,
    ok: res.ok,
    data,
    jsonOk,
    headers: res.headers,
    setCookies: parseSetCookie(res),
  };
}

function pickAuth(channel) {
  const auth = channel.auth || {};
  return {
    username: auth.username || auth.email || "",
    password: auth.password || "",
    cookie: normalizeCookie(auth.cookie || auth.session || ""),
    userId: String(auth.userId || auth.newApiUser || auth.api_user || "").trim(),
    token: auth.token || auth.accessToken || "",
  };
}

/** Community default display unit for NewAPI family (millylee/anyrouter-check-in). */
const DEFAULT_QUOTA_PER_UNIT = 500000;

function authHeaders(channel, cookie, { method = "GET" } = {}) {
  const auth = pickAuth(channel);
  const origin = String(channel.baseUrl || "").replace(/\/+$/, "");
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    // Note: Workers may strip/ignore Accept-Encoding; keep for fidelity with browser scripts
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }
  if (cookie || auth.cookie) headers.Cookie = cookie || auth.cookie;
  // HTTP 头名不区分大小写：同时写 new-api-user 和 New-Api-User 会被 fetch
  // 合并成 "1750, 1750"，服务端 strconv.Atoi 解析失败并报「格式错误」。只能写一次。
  if (auth.userId) {
    headers["New-Api-User"] = String(auth.userId);
  }
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (origin) {
    headers.Origin = origin;
    // community uses domain root as Referer (not /console/personal)
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
  const perUnit =
    Number(u.quota_per_unit ?? u.QuotaPerUnit ?? u.quotaPerUnit) || DEFAULT_QUOTA_PER_UNIT;
  return {
    id: u.id,
    username: u.username || u.display_name || "",
    displayName: u.display_name || u.username || "",
    group: u.group,
    quota: displayQuota,
    walletQuota: u.quota,
    giftQuota: u.gift_quota ?? null,
    totalQuota: u.total_quota ?? null,
    usedQuota: u.used_quota ?? null,
    requestCount: u.request_count,
    role: u.role,
    status: u.status,
    quotaPerUnit: perUnit,
    // raw always kept for UI extractQuotaInfo fallbacks
    raw: { ...u, quota_per_unit: perUnit },
  };
}

function formatUsd(quota, perUnit = DEFAULT_QUOTA_PER_UNIT) {
  const q = Number(quota);
  const p = Number(perUnit) || DEFAULT_QUOTA_PER_UNIT;
  if (!Number.isFinite(q) || !p) return null;
  // millylee: round(quota / 500000, 2)
  const n = q / p;
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `$${n.toFixed(digits)}`;
}

function buildQuotaMessage(user) {
  if (!user) return "";
  const perUnit = user.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT;
  const parts = [];
  if (user.quota != null) {
    const usd = formatUsd(user.quota, perUnit);
    if (usd) parts.push(`余额 ${usd}`);
  }
  if (user.usedQuota != null) {
    const usd = formatUsd(user.usedQuota, perUnit);
    if (usd) parts.push(`已用 ${usd}`);
  }
  return parts.join(" · ");
}

function alreadyCheckedMsg(msg) {
  return /已经签到|已签到|重复签到|already checked|already signed|already/i.test(String(msg || ""));
}

function isCheckinSuccess(data, status) {
  if (status >= 400) return false;
  if (!data || typeof data !== "object") return false;
  if (data.success === true || data.ret === 1 || data.code === 0) return true;
  if (alreadyCheckedMsg(data.message || data.msg)) return true;
  return false;
}

export const anyrouterAdapter = {
  id: "anyrouter",
  name: "AnyRouter",
  description: "anyrouter.top：POST /api/user/sign_in；余额=quota/500000",
  fields: [
    {
      key: "baseUrl",
      label: "站点地址",
      placeholder: "https://anyrouter.top",
      required: true,
    },
    { key: "auth.username", label: "邮箱/用户名（可选）", placeholder: "you@example.com" },
    { key: "auth.password", label: "密码（可选）", type: "password" },
    {
      key: "auth.cookie",
      label: "Cookie（推荐；至少含 session，WAF 可附带 acw_tc）",
      type: "password",
    },
    {
      key: "auth.userId",
      label: "New-Api-User / api_user（用户数字 ID，强烈推荐）",
      placeholder: "从 F12 请求头 new-api-user 复制",
    },
    {
      key: "auth.token",
      label: "Bearer Token（可选）",
      type: "password",
    },
  ],

  async request(channel, path, { method = "GET", body, cookie } = {}) {
    const res = await fetch(joinUrl(channel.baseUrl, path), {
      method,
      headers: authHeaders(channel, cookie, { method }),
      body: body == null ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    return readJson(res);
  },

  async login(channel) {
    const auth = pickAuth(channel);

    // Cookie-only: validate via /api/user/self
    if (auth.cookie && !auth.password) {
      const me = await this.me(channel);
      return {
        ok: me.ok,
        message: me.ok
          ? `cookie 有效${me.user ? ` · ${buildQuotaMessage(me.user)}` : ""}`
          : me.message ||
            "cookie 无效。请重新登录 anyrouter.top，复制完整 Cookie，并填写 New-Api-User（用户 ID）",
        tokens: {
          cookie: me.tokens?.cookie || auth.cookie,
          userId: me.user?.id || auth.userId || "",
        },
        user: me.user,
        raw: me.raw,
      };
    }

    if (!auth.username || !auth.password) {
      return {
        ok: false,
        message:
          "需要邮箱+密码，或粘贴 Cookie + New-Api-User。公开脚本推荐两者之一；Cookie 模式必须带用户 ID。",
      };
    }

    let cookie = auth.cookie || "";
    const attempts = [
      { path: "/api/user/login", body: { username: auth.username, password: auth.password } },
      { path: "/api/user/login", body: { email: auth.username, password: auth.password } },
      {
        path: "/api/user/login",
        body: { username: auth.username, password: auth.password, turnstile: "" },
      },
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
        const meRes = await this.request(channel, "/api/user/self", { cookie });
        if (meRes.setCookies?.length) cookie = mergeCookie(cookie, meRes.setCookies);
        const user =
          meRes.data?.success !== false ? normalizeUser(meRes.data) : normalizeUser(data);
        return {
          ok: true,
          message: `登录成功${user ? ` · ${buildQuotaMessage(user)}` : ""}`,
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
        data.msg ||
        `登录失败 HTTP ${last?.status}。AnyRouter 常有 WAF，建议浏览器登录后复制 Cookie + new-api-user。`,
      raw: data,
      httpStatus: last?.status,
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
    const auth = pickAuth(channel);

    let cookie = ensured.cookie || auth.cookie || "";
    const res = await this.request(channel, "/api/user/self", { cookie });
    if (res.setCookies?.length) cookie = mergeCookie(cookie, res.setCookies);

    const data = res.data || {};

    // HTTP 200 + WAF HTML was previously treated as success → quota null + message "ok"
    if (isWafOrChallengeBody(data, res.status) || (!res.jsonOk && !isValidUserSelfPayload(data))) {
      return {
        ok: false,
        httpStatus: res.status,
        message: wafBlockMessage("获取用户"),
        raw: truncateRaw(data),
        tokens: ensured.tokens,
        wafBlocked: true,
      };
    }

    if (res.status >= 400 || data.success === false || !isValidUserSelfPayload(data)) {
      const msg =
        data.message ||
        data.msg ||
        (!res.jsonOk
          ? `获取用户失败：响应不是 JSON (HTTP ${res.status})`
          : `获取用户失败 HTTP ${res.status}`);
      const hint =
        !auth.userId && /未登录|无权|unauthorized|401/i.test(String(msg) + res.status)
          ? " · 请补填 New-Api-User（用户数字 ID，F12 请求头 new-api-user）"
          : "";
      if (auth.username && auth.password) {
        const relogin = await this.login({
          ...channel,
          auth: { ...channel.auth, cookie },
        });
        if (relogin.ok && relogin.user?.quota != null) {
          return {
            ok: true,
            httpStatus: 200,
            user: relogin.user,
            message: `会话已刷新 · ${buildQuotaMessage(relogin.user) || relogin.message}`,
            raw: truncateRaw(relogin.raw),
            tokens: relogin.tokens,
          };
        }
      }
      return {
        ok: false,
        httpStatus: res.status,
        message: msg + hint,
        raw: truncateRaw(data),
        tokens: ensured.tokens,
      };
    }

    const user = normalizeUser(data);
    // Guard: valid-looking payload but still no user id — treat as incomplete
    if (user.id == null && user.quota == null && user.username === "") {
      return {
        ok: false,
        httpStatus: res.status,
        message: "用户接口返回异常（无 id/quota）。可能是 WAF 半页或会话无效。",
        raw: truncateRaw(data),
        tokens: ensured.tokens,
      };
    }

    const tokens = { ...(ensured.tokens || {}) };
    if (user.id) tokens.userId = String(user.id);
    tokens.cookie = cookie;
    return {
      ok: true,
      httpStatus: res.status,
      user,
      message: buildQuotaMessage(user) || data.message || "ok",
      raw: truncateRaw(data),
      tokens,
    };
  },

  async status(channel) {
    // Primary: user self carries balance; optional month checkin status for forks
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
      if (isWafOrChallengeBody(data, res.status) || !res.jsonOk) {
        // ignore optional status endpoint under WAF
      } else if (res.status < 400 && data.success !== false && typeof data === "object" && !data.raw) {
        const d = data.data || data;
        const stats = d.stats || d;
        monthStatus = {
          enabled: d.enabled !== false,
          checkedInToday: !!(stats.checked_in_today ?? d.checked_in_today),
          checkinCount:
            stats.checkin_count ?? stats.total_checkins ?? d.checkin_count ?? null,
          totalQuota: stats.total_quota ?? d.total_quota ?? null,
          month: d.month || month,
          raw: truncateRaw(d),
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
        note: "AnyRouter 余额来自 /api/user/self；签到走 /api/user/sign_in",
      },
      message:
        [
          buildQuotaMessage(me.user),
          monthStatus?.checkedInToday != null
            ? monthStatus.checkedInToday
              ? "今日已签到"
              : "今日未签到"
            : null,
          monthStatus?.checkinCount != null ? `本月签到 ${monthStatus.checkinCount} 次` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "ok",
      raw: me.raw,
      tokens: me.tokens,
    };
  },

  /**
   * AnyRouter check-in = POST /api/user/sign_in
   * Then re-fetch /api/user/self for balance delta (same as millylee).
   */
  async checkin(channel) {
    const before = await this.me(channel);
    if (!before.ok) return before;

    let cookie = before.tokens?.cookie || pickAuth(channel).cookie || "";
    // ensure userId is on channel for subsequent headers
    const userId = before.user?.id || pickAuth(channel).userId || "";
    const ch = {
      ...channel,
      auth: { ...channel.auth, cookie, userId: userId || channel.auth?.userId },
    };

    const tried = [];
    // Primary path from millylee: /api/user/sign_in
    // Fallbacks for forks: /api/user/checkin
    for (const path of ["/api/user/sign_in", "/api/user/checkin"]) {
      try {
        const res = await this.request(ch, path, {
          method: "POST",
          body: {},
          cookie,
        });
        if (res.setCookies?.length) cookie = mergeCookie(cookie, res.setCookies);
        const data = res.data || {};
        if (isWafOrChallengeBody(data, res.status) || !res.jsonOk) {
          tried.push({ path, status: res.status, waf: true });
          return {
            ok: false,
            httpStatus: res.status,
            user: before.user,
            message: wafBlockMessage("签到"),
            raw: { tried, sample: truncateRaw(data) },
            tokens: before.tokens,
            wafBlocked: true,
          };
        }
        tried.push({ path, status: res.status, data: truncateRaw(data) });
        const msg = String(data.message || data.msg || "");

        if (isCheckinSuccess(data, res.status) || alreadyCheckedMsg(msg)) {
          const after = await this.me({
            ...ch,
            auth: { ...ch.auth, cookie },
          });
          const perUnit = after.user?.quotaPerUnit || before.user?.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT;
          let reward = data.data?.quota_awarded ?? data.quota_awarded ?? null;
          if (
            (reward == null || !Number.isFinite(Number(reward))) &&
            after.ok &&
            before.user?.quota != null &&
            after.user?.quota != null
          ) {
            reward = Number(after.user.quota) - Number(before.user.quota);
          }
          const already = alreadyCheckedMsg(msg);
          return {
            ok: true,
            httpStatus: res.status,
            user: after.user || before.user,
            result: {
              success: true,
              message: already ? msg || "今日已签到" : msg || "签到成功",
              reward: reward != null && Number.isFinite(Number(reward)) ? Number(reward) : null,
              alreadyCheckedIn: already,
              via: path,
            },
            message: [
              already ? msg || "今日已签到" : msg || "签到成功",
              reward != null && Number(reward) !== 0
                ? `奖励 ${formatUsd(reward, perUnit) || ""}`.trim()
                : null,
              buildQuotaMessage(after.user || before.user),
            ]
              .filter(Boolean)
              .join(" · "),
            raw: { endpoint: path, data, before: before.raw, after: after.raw, tried },
            tokens: after.tokens || { cookie, userId },
          };
        }
      } catch (e) {
        tried.push({ path, error: e.message || String(e) });
      }
    }

    // If sign_in failed but self works, surface before balance + failure detail
    return {
      ok: false,
      httpStatus: tried[0]?.status || 422,
      user: before.user,
      message:
        `签到失败（已尝试 ${tried.map((t) => t.path).join(", ")}）。` +
        `公开库对 AnyRouter 使用 POST /api/user/sign_in + 请求头 new-api-user。` +
        (before.user ? ` 当前 ${buildQuotaMessage(before.user)}。` : "") +
        ` 若 HTTP 403/挑战页，Worker 出口被 WAF 拦截，请用浏览器复制最新 Cookie。`,
      raw: { tried, before: before.raw },
      tokens: before.tokens,
    };
  },
};
