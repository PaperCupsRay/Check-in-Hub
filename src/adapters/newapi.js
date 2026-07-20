/**
 * New API (one-api fork) check-in adapter
 * Observed from:
 *  - https://free.lyclaude.site
 *  - https://api.gemai.cc (哈基米)
 *  - https://api.pie-xian.com (OAuth-only + Cloudflare, no password login)
 *
 * Auth: session Cookie (browser UI). Official web also sends `new-api-user: <id>`.
 * HAR exports often strip cookies — prefer pasting Cookie from Application panel.
 * Some sites only support GitHub/LinuxDo OAuth (`has_password: false`) → password login 404.
 *
 * Login (optional): POST /api/user/login { username, password }
 * Self: GET /api/user/self
 * Status: GET /api/user/checkin?month=YYYY-MM
 * Check-in: POST /api/user/checkin  (optional ?turnstile=)
 */

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function currentMonth(tz = "Asia/Shanghai") {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
    });
    // en-CA => YYYY-MM-DD-ish parts
    const parts = fmt.formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    return `${y}-${m}`;
  } catch {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
}

function parseSetCookie(res) {
  // Workers/fetch may expose getSetCookie()
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
  for (const part of setPairs) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function readJson(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data, headers: res.headers, setCookies: parseSetCookie(res) };
}

/**
 * Normalize pasted cookie strings from DevTools / extensions.
 * Accepts:
 *  - document.cookie style: "a=1; b=2"
 *  - header style: "Cookie: a=1; b=2"
 *  - multi-line Application panel dumps
 * Drops browser-only noise that is not sent as Cookie (sessionStorage keys etc.)
 */
function normalizeCookie(input) {
  let s = String(input || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!s) return "";
  s = s.replace(/^cookie\s*:\s*/i, "");
  // multi-line "name\tvalue" or "name=value" dumps → join
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
  // collapse whitespace around separators
  s = s
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const name = p.split("=")[0].trim().toLowerCase();
      // not cookie material
      if (!name || name.startsWith("_cfpre_")) return false;
      return true;
    })
    .join("; ");
  return s;
}

function pickAuth(channel) {
  const auth = channel.auth || {};
  return {
    username: auth.username || auth.email || "",
    password: auth.password || "",
    cookie: normalizeCookie(auth.cookie || auth.session || ""),
    userId: String(auth.userId || auth.newApiUser || "").trim(),
    token: auth.token || auth.accessToken || "", // system access token if any
    turnstileToken: auth.turnstileToken || "",
  };
}

function authHeaders(channel, cookie, { method = "GET" } = {}) {
  const auth = pickAuth(channel);
  // Align with real browser traffic (pie-xian HAR used Chrome 150)
  const headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-store",
    "sec-ch-ua": '"Chromium";v="150", "Not A(Brand";v="24", "Google Chrome";v="150"',
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
  // pie-xian / 新前端使用小写 new-api-user；旧站用 New-Api-User，两头都带
  if (auth.userId) {
    headers["New-Api-User"] = String(auth.userId);
    headers["new-api-user"] = String(auth.userId);
  }
  // Some deployments accept Authorization for personal tokens
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const origin = String(channel.baseUrl || "").replace(/\/+$/, "");
  if (origin) {
    headers.Origin = origin;
    headers.Referer = `${origin}/console/personal`;
  }
  return headers;
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

function looksLikeHtmlChallenge(data, status) {
  const raw = responseTextHint(data);
  // Only treat as CF challenge when body looks like interstitials / HTML, not bare 403 JSON APIs
  if (/just a moment|cf-browser-verification|attention required|cdn-cgi\/challenge|enable javascript and cookies/i.test(raw)) {
    return true;
  }
  if (/<!doctype html|<html[\s>]|cloudflare/i.test(raw) && (status === 403 || status === 503 || status === 429)) {
    return true;
  }
  return false;
}

function httpErrorMessage(action, res) {
  const data = res?.data || {};
  const status = res?.status;
  const serverMsg = data.message || data.msg || data.error || "";
  if (status === 404) {
    if (action === "login") {
      return (
        "登录接口 404：该站可能只支持 GitHub/LinuxDo OAuth，不提供账密登录。" +
        "请在浏览器登录后，从 Application → Cookies 复制完整 Cookie，并填写 New-Api-User（用户 ID）。"
      );
    }
    return `${action} 接口不存在 (HTTP 404)${serverMsg ? `：${serverMsg}` : ""}。请确认 Base URL 是否为 API 根地址（如 https://api.pie-xian.com）。`;
  }
  if (looksLikeHtmlChallenge(data, status) || status === 403) {
    return (
      (serverMsg ? `${serverMsg} · ` : "") +
      `${action} 被目标站 Cloudflare 拒绝 (HTTP ${status || "?"})。` +
      `原因：请求从 Cloudflare Workers 出口发出，与浏览器 IP/人机验证不匹配；` +
      `粘贴 session/cf_clearance 通常也无效。` +
      `请改用面板渠道上的「浏览器直连」：在已登录的目标站点控制台运行脚本查询状态/签到。`
    );
  }
  return serverMsg || `${action} 失败 HTTP ${status}`;
}

/**
 * 部分 NewAPI 变体（如哈基米 api.gemai.cc）会把 wallet 额度放在 gift_quota / total_quota，
 * 而 data.quota 恒为 0。展示时优先用可用额度字段，避免面板显示 0。
 */
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
  // 全是 0 / 空时仍回传 0，便于区分「真的没额度」
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
    // 面板展示用（可能来自 gift_quota / total_quota）
    quota: displayQuota,
    // 原始 wallet 字段，避免被 0 覆盖后丢失
    walletQuota: u.quota,
    giftQuota: u.gift_quota ?? null,
    totalQuota: u.total_quota ?? null,
    usedQuota: u.used_quota,
    requestCount: u.request_count,
    role: u.role,
    status: u.status,
    // 保留原始字段，前端可按 quota_per_unit 换算美元展示
    raw: u,
  };
}

function normalizeStatus(payload) {
  const d = payload?.data || payload || {};
  const stats = d.stats || d;
  return {
    enabled: d.enabled !== false,
    checkedInToday: !!(stats.checked_in_today ?? d.checked_in_today),
    records: stats.records || d.records || d.checkins || [],
    checkinCount:
      stats.checkin_count ??
      stats.total_checkins ??
      d.checkin_count ??
      (stats.records ? stats.records.length : null),
    totalQuota: stats.total_quota ?? d.total_quota ?? null,
    minQuota: d.min_quota ?? null,
    maxQuota: d.max_quota ?? null,
    month: d.month || null,
    raw: d,
  };
}

function normalizeCheckin(payload) {
  const d = payload?.data || payload || {};
  const msg = payload?.message || "";
  const reward = d.quota_awarded ?? d.quota ?? null;
  const alreadyCheckedIn = /already|已签到|重复/i.test(msg);
  let message = msg || "ok";
  if (alreadyCheckedIn) message = msg || "今日已签到";
  else if (reward != null && (!msg || /^(ok|success|签到成功)$/i.test(msg))) {
    const perUnit = 500000;
    const usd = Number(reward) / perUnit;
    const money = Number.isFinite(usd)
      ? `$${usd.toFixed(Math.abs(usd) > 0 && Math.abs(usd) < 0.01 ? 4 : 2)}`
      : null;
    message = money ? `签到成功，奖励 ${money}` : "签到成功";
  }
  return {
    success: payload?.success === true || !!d.quota_awarded || !!d.checkin_date || alreadyCheckedIn,
    message,
    reward,
    checkInDate: d.checkin_date || d.check_in_date || null,
    alreadyCheckedIn,
    raw: payload,
  };
}

export const newapiAdapter = {
  id: "newapi",
  name: "New API",
  description: "Cookie / 账密 / OAuth 站（pie-xian、哈基米等同系）",
  fields: [
    {
      key: "baseUrl",
      label: "站点地址",
      placeholder: "https://api.pie-xian.com",
      required: true,
    },
    { key: "auth.username", label: "用户名（账密站）", placeholder: "username" },
    { key: "auth.password", label: "密码（账密站）", type: "password" },
    {
      key: "auth.cookie",
      label: "Cookie（OAuth 站必填；至少含 session=...，可附带 cf_clearance）",
      type: "textarea",
      placeholder: "session=...; cf_clearance=...",
    },
    {
      key: "auth.userId",
      label: "New-Api-User（用户 ID，推荐）",
      placeholder: "1750",
    },
    { key: "auth.token", label: "Bearer Token（可选）", type: "password" },
    {
      key: "auth.turnstileToken",
      label: "Turnstile Token（签到开启验证时可选）",
      type: "password",
    },
    { key: "options.timezone", label: "时区（用于月份）", placeholder: "Asia/Shanghai" },
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
    // Cookie / token first — OAuth-only sites (pie-xian) never have password login
    if ((auth.cookie || auth.token) && !auth.password) {
      const me = await this.me({
        ...channel,
        auth: {
          ...channel.auth,
          // ensure ensureSession does not recurse into password login
          cookie: auth.cookie,
          token: auth.token,
        },
      });
      return {
        ok: me.ok,
        message: me.ok
          ? `会话有效${me.user?.username ? ` · ${me.user.username}` : ""}${
              me.user?.quota != null ? ` · 余额已同步` : ""
            }`
          : me.message || "Cookie/Token 无效",
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
          "需要用户名+密码，或直接粘贴 Cookie。" +
          "若站点仅支持 GitHub/LinuxDo 登录（如 pie-xian），请用浏览器登录后复制 Cookie + 用户 ID。",
      };
    }

    // NewAPI variants
    const attempts = [
      { path: "/api/user/login", body: { username: auth.username, password: auth.password } },
      {
        path: "/api/user/login",
        body: { username: auth.username, password: auth.password, turnstile: "" },
      },
      { path: "/api/user/login", body: { email: auth.username, password: auth.password } },
    ];

    let last = null;
    let cookie = auth.cookie || "";
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
        // follow with self to capture more cookies / user id
        const meRes = await this.request(channel, "/api/user/self", { cookie });
        if (meRes.setCookies?.length) cookie = mergeCookie(cookie, meRes.setCookies);
        const user = meRes.data?.success !== false ? normalizeUser(meRes.data) : null;
        return {
          ok: true,
          message: data.message || "登录成功",
          tokens: {
            cookie,
            userId: user?.id || auth.userId || "",
          },
          user,
          raw: data,
        };
      }
    }
    return {
      ok: false,
      httpStatus: last?.status,
      message: httpErrorMessage("login", last),
      raw: last?.data || null,
    };
  },

  async ensureSession(channel) {
    const auth = pickAuth(channel);
    if (auth.cookie || auth.token) {
      return {
        ok: true,
        cookie: auth.cookie || "",
        tokens: auth.userId ? { userId: auth.userId, cookie: auth.cookie || "" } : null,
      };
    }
    if (!auth.username || !auth.password) {
      return {
        ok: false,
        message:
          "缺少会话：请填写 Cookie（OAuth 站）或用户名密码。" +
          "pie-xian 等站无账密接口，账密登录会 404。",
      };
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
    if (!ensured.cookie && !pickAuth(channel).token) {
      return {
        ok: false,
        message:
          "未带上 Cookie。请确认已点「保存渠道」，且 Cookie 字段含 session=...（不要只填 sessionStorage 的 _cfPre_tabId）",
      };
    }
    const res = await this.request(channel, "/api/user/self", { cookie: ensured.cookie });
    const data = res.data || {};
    if (res.status >= 400 || data.success === false) {
      let message = httpErrorMessage("获取用户", res);
      if (res.status === 401 || /未登录|login|unauthorized|token/i.test(String(data.message || ""))) {
        message =
          "会话无效/已过期。请重新在浏览器登录 api.pie-xian.com 后复制最新 session Cookie，并填写 New-Api-User。";
      }
      return {
        ok: false,
        httpStatus: res.status,
        message,
        raw: data,
        tokens: ensured.tokens,
      };
    }
    const user = normalizeUser(data);
    const tokens = { ...(ensured.tokens || {}) };
    if (user.id) tokens.userId = user.id;
    if (ensured.cookie) tokens.cookie = ensured.cookie;
    if (res.setCookies?.length) {
      tokens.cookie = mergeCookie(ensured.cookie, res.setCookies);
    }
    return {
      ok: true,
      httpStatus: res.status,
      user,
      message: data.message || "ok",
      raw: data,
      tokens: Object.keys(tokens).length ? tokens : null,
    };
  },

  async status(channel) {
    const ensured = await this.ensureSession(channel);
    if (!ensured.ok) return ensured;
    const month = currentMonth(channel.options?.timezone || "Asia/Shanghai");
    const res = await this.request(channel, `/api/user/checkin?month=${encodeURIComponent(month)}`, {
      cookie: ensured.cookie,
    });
    const data = res.data || {};
    if (res.status >= 400 || data.success === false) {
      // 404: some forks disable status endpoint; fall back to user info
      if (res.status === 404) {
        const me = await this.me(channel);
        if (me.ok) {
          return {
            ok: true,
            httpStatus: 200,
            user: me.user,
            status: {
              enabled: true,
              note: "该站无签到状态接口，已回退为用户信息",
            },
            message: "签到状态接口 404，已显示用户额度",
            raw: { checkinStatus: data, user: me.raw },
            tokens: me.tokens || ensured.tokens,
          };
        }
      }
      return {
        ok: false,
        httpStatus: res.status,
        message: httpErrorMessage("获取签到状态", res),
        raw: data,
        tokens: ensured.tokens,
      };
    }
    const st = normalizeStatus(data);
    const parts = [];
    if (st.checkedInToday != null) parts.push(st.checkedInToday ? "今日已签到" : "今日未签到");
    if (st.checkinCount != null) parts.push(`本月 ${st.checkinCount} 次`);
    if (st.totalQuota != null) {
      const usd = Number(st.totalQuota) / 500000;
      if (Number.isFinite(usd)) parts.push(`本月获得 $${usd.toFixed(2)}`);
    }
    return {
      ok: true,
      httpStatus: res.status,
      status: st,
      message: parts.join(" · ") || data.message || "ok",
      raw: data,
      tokens: ensured.tokens,
    };
  },

  async checkin(channel) {
    const ensured = await this.ensureSession(channel);
    if (!ensured.ok) return ensured;
    const auth = pickAuth(channel);
    let cookie = ensured.cookie;
    let tokens = ensured.tokens;

    // 1) Prefer GET status first — many CF sites allow GET but block POST from non-browser IPs
    let preStatus = null;
    try {
      const month = currentMonth(channel.options?.timezone || "Asia/Shanghai");
      const stRes = await this.request(
        channel,
        `/api/user/checkin?month=${encodeURIComponent(month)}`,
        { cookie }
      );
      if (stRes.setCookies?.length) {
        cookie = mergeCookie(cookie, stRes.setCookies);
        tokens = { ...(tokens || {}), cookie };
      }
      if (stRes.status < 400 && stRes.data?.success !== false) {
        preStatus = normalizeStatus(stRes.data);
        if (preStatus.checkedInToday) {
          return {
            ok: true,
            httpStatus: stRes.status,
            result: {
              success: true,
              alreadyCheckedIn: true,
              message: "今日已签到",
              reward: null,
            },
            status: preStatus,
            message: "今日已签到（未再发起 POST，避免 Cloudflare 拦截）",
            raw: stRes.data,
            tokens,
          };
        }
      }
    } catch {
      /* continue to POST */
    }

    // 2) Actual check-in POST
    const turnstile =
      auth.turnstileToken || channel.options?.turnstileToken || channel.auth?.turnstileToken || "";
    const path = turnstile
      ? `/api/user/checkin?turnstile=${encodeURIComponent(turnstile)}`
      : "/api/user/checkin";
    const res = await this.request(channel, path, {
      method: "POST",
      body: {},
      cookie,
    });
    if (res.setCookies?.length) {
      cookie = mergeCookie(cookie, res.setCookies);
      tokens = { ...(tokens || {}), cookie };
    }
    const data = res.data || {};
    const normalized = normalizeCheckin(data);

    // POST blocked by CF, but we already know not checked in / or status unknown
    if (res.status === 403 || looksLikeHtmlChallenge(data, res.status)) {
      // One more GET status for final truth
      try {
        const month = currentMonth(channel.options?.timezone || "Asia/Shanghai");
        const stRes = await this.request(
          channel,
          `/api/user/checkin?month=${encodeURIComponent(month)}`,
          { cookie }
        );
        if (stRes.status < 400 && stRes.data?.success !== false) {
          preStatus = normalizeStatus(stRes.data);
          if (preStatus.checkedInToday) {
            return {
              ok: true,
              httpStatus: stRes.status,
              result: {
                success: true,
                alreadyCheckedIn: true,
                message: "今日已签到",
              },
              status: preStatus,
              message: "POST 被 Cloudflare 拦截，但状态查询显示今日已签到",
              raw: { post: data, status: stRes.data },
              tokens,
            };
          }
        }
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        httpStatus: res.status,
        message: httpErrorMessage("签到", res),
        result: normalized,
        status: preStatus,
        raw: data,
        tokens,
      };
    }

    if (res.status >= 400 || (data.success === false && !normalized.alreadyCheckedIn)) {
      return {
        ok: false,
        httpStatus: res.status,
        message: httpErrorMessage("签到", res),
        result: normalized,
        status: preStatus,
        raw: data,
        tokens,
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      result: normalized,
      status: preStatus,
      message: normalized.message || data.message || "签到成功",
      raw: data,
      tokens,
    };
  },
};
