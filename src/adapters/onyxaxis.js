/**
 * Obsidian Arc（Axis AI）签到适配器
 *
 * 站点：自建 AI 站。开源实现 https://github.com/OnyxAxisOwO/ObsidianArc（MIT），
 * 实测实例 https://ai.onyxaxis.org（站点名 Axis AI，v0.10.0）。同系实例只要
 * 没改接口路径都能直接用，Base URL 填自己的域名即可。
 *
 * 鉴权：服务端会话 Cookie（默认名 `obsidian_session`，运营方可用
 * `OBSIDIAN_SESSION_COOKIE` 改），HttpOnly + SameSite=Lax。**没有** Bearer token /
 * API key 能签到 —— 所以本适配器只有两条路：手抄 Cookie，或账密登录换 Cookie。
 *
 * 接口（2026-10-16 对着站点源码 internal/checkin、internal/auth 逐条核对）：
 *   POST /api/auth/login  { identifier, password, turnstile?, guards? }
 *        → 200 { user } + Set-Cookie（会话）
 *        → 200 { two_factor: true } 账号开了二次验证，只下发 pending 会话，
 *          必须再 POST /api/auth/two-factor { code, remember } 才算登录
 *        → 401 unauthorized/invalid_credentials；429 too_many_attempts（带 Retry-After）
 *        → 403 challenge_failed（登录人机验证没过）/ account_banned
 *   GET  /api/auth/me     → 200 { user, preferences }；未登录 401 session_required
 *   GET  /api/checkin     → 200 { enabled, today, checked_in_today, streak,
 *                                month_days, month_count, daily, rules }
 *   POST /api/checkin {}  → 201 { day, streak, reward, reward_failed }
 *        重复签到 → 409 already_checked_in「You have already checked in today.」
 *        未开启   → 403 checkin_disabled
 *        邮箱未验证 → 403 email_unverified
 *        账号被封 → 403 account_inactive
 *   里程碑（连续 N 天 / 本月 N 天）要自己领：POST /api/checkin/claims/{rule_id}，
 *   本适配器不代领（面板的动作集里没有「领奖」，硬塞进 gacha 会让日志说谎）。
 *
 * 状态变更类请求会过服务端 httpx.SameOrigin：带 Origin 且与站点同源，或
 * Sec-Fetch-Site 为 same-origin/none 才放行。HAR 里浏览器发的正是
 * `Origin: https://ai.onyxaxis.org` + `Sec-Fetch-Site: same-origin`，这里照抄。
 *
 * 奖励形态（源码 internal/checkin 的 Reward）：
 *   { kind: "" }                        当日无奖励（站点没配每日奖励）
 *   { kind: "bonus", amount, … }        积分，进 bonus bar
 *   { kind: "card", name, cards, … }    额度重置卡
 * amount 是积分不是钱，所以走 result.rewardPoints，**不进** result.reward
 * （面板会把 reward 按 quota_per_unit 当美元显示，积分塞进去会变成 $0.00）。
 */

import {
  joinUrl,
  CHROME_UA,
  looksLikeCfChallenge,
  mergeCookie,
  normalizeCookie,
  readResponse,
} from "./forum.js";

/** 站点默认的会话 Cookie 名（internal/config：env SESSION_COOKIE，默认 obsidian_session） */
const SESSION_COOKIE = "obsidian_session";

/** 鉴权路径前缀：让日志分得清「直接签到」和「登录后签到」 */
const AUTH_VIA_LABEL = {
  cookie: "",
  login: "登录后签到：",
  relogin: "重新登录后签到：",
};

const NO_CREDS_MESSAGE =
  "缺少凭证。Obsidian Arc 只认服务端会话 Cookie（没有 API token 能签到）：" +
  `在浏览器登录后从 F12 → Application → Cookies 复制 ${SESSION_COOKIE} 填入本渠道，` +
  "或填「用户名 / 邮箱 + 密码」由本工具自动登录换 Cookie。";

function pickAuth(channel) {
  const auth = channel.auth || {};
  return {
    identifier: String(auth.identifier || auth.email || auth.username || "").trim(),
    password: String(auth.password || ""),
    cookie: normalizeCookie(auth.cookie || auth.session || ""),
  };
}

/** 签到后是否顺带领里程碑（照 linux.sb 的 options.autoGacha 惯例，默认关） */
function autoClaimOn(channel) {
  const v = channel.options?.autoClaim;
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * 浏览器同源请求头。Origin / Referer 是服务端 SameOrigin 中间件的判据之一，
 * 少了它 POST 会回 403「Request origin is not allowed.」。
 */
function baseHeaders(channel, cookie) {
  const origin = String(channel.baseUrl || "").replace(/\/+$/, "");
  const headers = {
    Accept: "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": CHROME_UA,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  if (cookie) headers.Cookie = cookie;
  if (origin) {
    headers.Origin = origin;
    headers.Referer = `${origin}/`;
  }
  return headers;
}

/** 站点的错误信封：{ error: { code, message, code_detail? } } */
function apiError(data) {
  const e = data && typeof data === "object" ? data.error : null;
  if (!e || typeof e !== "object") return { code: "", detail: "", message: "" };
  return {
    code: String(e.code || ""),
    detail: String(e.code_detail || ""),
    message: String(e.message || "").trim(),
  };
}

function errorText(data, status) {
  const { code, detail, message } = apiError(data);
  if (message) return message;
  if (code) return `${code}${detail ? `（${detail}）` : ""}`;
  return `HTTP ${status}`;
}

/**
 * Cloudflare 拦截文案。措辞**刻意避开** src/index.js 的 PERMANENT_FAIL_RE
 * （缺少/需要/未配置/不存在/404/无可用/未知渠道/不支持）：这类失败换出口有可能过，
 * 命中永久失败判据就永远不会降级到 gha_api 了。
 */
function cfMessage(status) {
  return (
    `请求被 Cloudflare 拦截（HTTP ${status}，返回 Just a moment... 挑战页），不是凭证问题。` +
    "请在 Cookie 里补上 cf_clearance，或把本渠道通道改为 gha_api（GitHub Actions 的 Azure 出口 IP）再试。"
  );
}

function cfResult(res, data, tokens) {
  return {
    ok: false,
    httpStatus: res.status,
    message: cfMessage(res.status),
    raw: data,
    ...(tokens ? { tokens } : {}),
  };
}

/** 会话失效（Cookie 过期 / 未登录）。判据只看 401 与站点自己的 code。 */
function sessionExpired(result) {
  if (!result || result.ok) return false;
  if (result.httpStatus === 401) return true;
  const { code } = apiError(result.raw);
  return code === "session_required" || code === "unauthorized";
}

function normalizeUser(u) {
  if (!u || typeof u !== "object") return null;
  return {
    id: u.id ?? null,
    username: u.username || "",
    displayName: u.nickname || u.username || "",
    email: u.email || "",
    role: u.role || "",
    group: u.group_name || "",
    status: u.status || "",
    emailVerified: u.email_verified === true,
    createdAt: u.created_at ?? null,
    raw: u,
  };
}

function userMessage(user) {
  if (!user) return "ok";
  const parts = [user.displayName || user.username || user.email || user.id || "已登录"];
  if (user.username && user.displayName && user.displayName !== user.username) {
    parts.push(`@${user.username}`);
  }
  if (user.group) parts.push(user.group);
  if (user.role && user.role !== "user") parts.push(user.role);
  return parts.join(" · ");
}

/** Reward → 人话。kind 为空串表示当日没有奖励。 */
function rewardText(reward) {
  if (!reward || typeof reward !== "object") return "";
  const kind = String(reward.kind || "").trim();
  if (!kind) return "";
  if (kind === "bonus") {
    const amount = Number(reward.amount);
    const parts = [Number.isFinite(amount) && amount > 0 ? `${amount} 积分` : "积分"];
    if (Number(reward.valid_days) > 0) parts.push(`${Number(reward.valid_days)} 天内有效`);
    return parts.join("，");
  }
  if (kind === "card") {
    const n = Number(reward.cards);
    const count = Number.isFinite(n) && n > 0 ? n : 1;
    const name = String(reward.name || "").trim() || "重置卡";
    const parts = [`${name} × ${count}`];
    const windows = Array.isArray(reward.windows) ? reward.windows.filter(Boolean) : [];
    if (windows.length) parts.push(`重置 ${windows.join("/")}`);
    if (Number(reward.valid_days) > 0) parts.push(`${Number(reward.valid_days)} 天内有效`);
    return parts.join("，");
  }
  return kind;
}

/** 积分奖励的数值（只有 bonus 才是积分；card 的 cards 是张数，不能混进来） */
function rewardPointsOf(reward) {
  if (!reward || String(reward.kind || "") !== "bonus") return null;
  const amount = Number(reward.amount);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeStatus(d) {
  const rules = Array.isArray(d.rules) ? d.rules : [];
  const streak = Number(d.streak);
  const monthCount = Number(d.month_count);
  return {
    enabled: d.enabled !== false,
    checkedInToday: d.checked_in_today === true,
    currentStreak: Number.isFinite(streak) ? streak : null,
    // 面板把 checkinCount 渲染成「本月签到 N 次」
    checkinCount: Number.isFinite(monthCount) ? monthCount : null,
    today: d.today || null,
    monthDays: Array.isArray(d.month_days) ? d.month_days : [],
    dailyReward: rewardText(d.daily) || null,
    claimable: rules.filter((r) => r?.claimable).map((r) => r.title || r.id),
    rules: rules.map((r) => ({
      id: r?.id ?? null,
      title: r?.title || "",
      basis: r?.basis || "",
      days: r?.days ?? null,
      progress: r?.progress ?? null,
      claimable: r?.claimable === true,
      claimed: r?.claimed === true,
      reward: rewardText(r?.reward) || null,
    })),
    raw: d,
  };
}

function statusMessage(st) {
  const parts = [];
  if (!st.enabled) parts.push("站点未开启签到");
  else parts.push(st.checkedInToday ? "今日已签到" : "今日未签到");
  if (st.currentStreak != null && st.currentStreak > 0) parts.push(`连续 ${st.currentStreak} 天`);
  if (st.checkinCount != null) parts.push(`本月 ${st.checkinCount} 天`);
  if (st.dailyReward) parts.push(`每日奖励 ${st.dailyReward}`);
  if (st.claimable.length) parts.push(`可领里程碑：${st.claimable.join("、")}`);
  return parts.join("，");
}

export const onyxaxisAdapter = {
  id: "onyxaxis",
  name: "Obsidian Arc",
  description: "自建 AI 站（Axis AI / ai.onyxaxis.org 同系）：会话 Cookie 或账密登录",
  fields: [
    {
      key: "baseUrl",
      label: "站点地址",
      placeholder: "https://ai.onyxaxis.org",
      required: true,
    },
    {
      key: "auth.identifier",
      label: "用户名 / 邮箱（可留空，改用下面的 Cookie）",
      placeholder: "user@example.com",
    },
    {
      key: "auth.password",
      label: "密码",
      type: "password",
    },
    {
      key: "auth.cookie",
      label: `Cookie（可选，优先于账密；浏览器登录后复制 ${SESSION_COOKIE}）`,
      type: "textarea",
      placeholder: `${SESSION_COOKIE}=...`,
    },
    {
      key: "options.autoClaim",
      label: "签到后自动领里程碑（true/false，默认 false）",
      placeholder: "false",
    },
  ],

  // 面板按这个在渠道卡片上多渲染一个按钮（见 src/ui.html 的 extraButtons）
  actions: [
    {
      action: "claim",
      label: "领里程碑",
      title: "领取已达成的里程碑奖励（如连续 5 天的签到重置卡）；没达成会显示还差几天",
    },
  ],

  async request(channel, path, { method = "GET", cookie, body, headers: extra } = {}) {
    const headers = baseHeaders(channel, cookie);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (extra) Object.assign(headers, extra);
    const res = await fetch(joinUrl(channel.baseUrl, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    return readResponse(res);
  },

  /**
   * 账密登录换会话 Cookie。
   *
   * 成功时把服务端下发的 cookie 并进传入的 cookie 串返回（tokens.cookie 由面板 /
   * cron 写回渠道，所以「填一次账密就不用再手抄 Cookie」）。
   *
   * 两类失败**故意**让文案命中 PERMANENT_FAIL_RE：二次验证要 6 位动态码、登录接口
   * 挂了人机验证 —— 这两件事换出口（gha_api 跑的是同一份纯 HTTP 适配器）都解不了，
   * 降级只会白烧一次 Actions 运行，而「改用 Cookie」是真正可行的出路。
   */
  async signIn(channel, { cookie = "" } = {}) {
    const auth = pickAuth(channel);
    const res = await this.request(channel, "/api/auth/login", {
      method: "POST",
      body: { identifier: auth.identifier, password: auth.password },
    });
    const data = res.data || {};
    if (looksLikeCfChallenge(data, res.status)) {
      return { ok: false, httpStatus: res.status, message: cfMessage(res.status), raw: data };
    }
    // 会话 Cookie 可能轮换：先并进来，失败路径也带上，避免把新值丢掉
    const next = mergeCookie(cookie, res.setCookies || []);
    const { code } = apiError(data);

    if (res.status === 200 && data.two_factor === true) {
      return {
        ok: false,
        httpStatus: res.status,
        twoFactor: true,
        message:
          "该账号开了二次验证，登录只走到「待验证」这一步，脚本不支持代填 6 位动态码。" +
          `请改用 Cookie 方式：浏览器登录后从 F12 → Application → Cookies 复制 ${SESSION_COOKIE} 填入本渠道。`,
        raw: data,
      };
    }
    if (!res.ok) {
      const limited = res.status === 429 || code === "too_many_attempts";
      const challenged = code === "challenge_failed" || code === "challenge_unavailable";
      let message = errorText(data, res.status);
      if (limited) message += "（登录被限流，稍后再试；也可直接用 Cookie 方式绕开登录）";
      if (challenged) {
        message +=
          "（站点登录接口挂了人机验证，静态 token 一次性且几分钟就过期，自动登录不支持；请改用 Cookie 方式）";
      }
      if (code === "account_banned") message += "（账号被封，签到不会成功）";
      return { ok: false, httpStatus: res.status, message, raw: data };
    }
    if (!next) {
      return {
        ok: false,
        httpStatus: res.status,
        message: `登录成功但响应里没有会话 Cookie（${SESSION_COOKIE}），无法继续。`,
        raw: data,
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      cookie: next,
      user: normalizeUser(data.user),
      raw: data,
    };
  },

  /**
   * 会话解析 + 失效自愈。
   *
   * 顺序：渠道里存了 Cookie 就直接用（它同时是「浏览器登录过」的凭证）；用到一半
   * 回 401 而渠道又配了账密时，账密换一份新 Cookie 重试一次。没有 Cookie 但有账密
   * 就先登录再跑。runner(cookie, authVia) 的 authVia 让日志分得清走的哪条路。
   */
  async withSession(channel, runner) {
    const auth = pickAuth(channel);
    const canLogin = !!(auth.identifier && auth.password);

    if (auth.cookie) {
      const first = await runner(auth.cookie, "cookie");
      if (!sessionExpired(first) || !canLogin) {
        return { ...first, tokens: { cookie: auth.cookie } };
      }
      const signed = await this.signIn(channel, { cookie: auth.cookie });
      if (!signed.ok) {
        return {
          ...first,
          message: `${first.message}（Cookie 已失效，重新登录也失败：${signed.message}）`.slice(0, 400),
          tokens: { cookie: auth.cookie },
        };
      }
      const again = await runner(signed.cookie, "relogin");
      return { ...again, tokens: { cookie: signed.cookie } };
    }

    if (!canLogin) {
      return { ok: false, message: NO_CREDS_MESSAGE };
    }
    const signed = await this.signIn(channel);
    if (!signed.ok) {
      return {
        ok: false,
        httpStatus: signed.httpStatus,
        message: signed.message,
        raw: signed.raw,
      };
    }
    const result = await runner(signed.cookie, "login");
    return { ...result, tokens: { cookie: signed.cookie } };
  },

  /** GET /api/auth/me → { user, preferences } */
  async me(channel) {
    return this.withSession(channel, async (cookie) => {
      const res = await this.request(channel, "/api/auth/me", { cookie });
      const data = res.data || {};
      if (looksLikeCfChallenge(data, res.status)) return cfResult(res, data);
      if (!res.ok) {
        const { code } = apiError(data);
        const extra =
          code === "two_factor_pending"
            ? "（这份 Cookie 停在二次验证那一步，不是完整会话；请在浏览器完成验证后再复制）"
            : "";
        return {
          ok: false,
          httpStatus: res.status,
          message: `${errorText(data, res.status)}${extra}`,
          raw: data,
        };
      }
      const user = normalizeUser(data.user);
      return {
        ok: true,
        httpStatus: res.status,
        user,
        message: userMessage(user),
        raw: data,
      };
    });
  },

  /** 登录校验：有 Cookie 就只读验一次（不产生副作用），否则真跑一次账密登录 */
  async login(channel) {
    const auth = pickAuth(channel);
    if (auth.cookie) {
      const me = await this.me(channel);
      return {
        ok: me.ok,
        httpStatus: me.httpStatus,
        message: me.ok ? `Cookie 有效 · ${me.message}` : me.message,
        user: me.user || null,
        raw: me.raw,
        tokens: me.tokens || { cookie: auth.cookie },
      };
    }
    if (!auth.identifier || !auth.password) {
      return { ok: false, message: NO_CREDS_MESSAGE };
    }
    const signed = await this.signIn(channel);
    if (!signed.ok) {
      return { ok: false, httpStatus: signed.httpStatus, message: signed.message, raw: signed.raw };
    }
    return {
      ok: true,
      httpStatus: signed.httpStatus,
      message: signed.user ? `登录成功 · ${userMessage(signed.user)}` : "登录成功",
      user: signed.user,
      raw: signed.raw,
      tokens: { cookie: signed.cookie },
    };
  },

  /** GET /api/checkin（只读，不消耗签到机会） */
  async status(channel) {
    return this.withSession(channel, async (cookie) => {
      const res = await this.request(channel, "/api/checkin", { cookie });
      const data = res.data || {};
      if (looksLikeCfChallenge(data, res.status)) return cfResult(res, data);
      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          message: errorText(data, res.status),
          raw: data,
        };
      }
      const st = normalizeStatus(data);
      return {
        ok: true,
        httpStatus: res.status,
        status: st,
        message: statusMessage(st),
        raw: data,
      };
    });
  },

  /**
   * POST /api/checkin（body 就是 {}，HAR 里 content-length: 2）。
   * 重复签到站点回 409 already_checked_in —— 那是「今天已经签过」，算成功不算失败，
   * 否则面板会把一个正常状态报成错误，用户会去查错方向。
   */
  async checkin(channel) {
    return this.withSession(channel, async (cookie, authVia) => {
      const res = await this.request(channel, "/api/checkin", {
        method: "POST",
        cookie,
        body: {},
      });
      const data = res.data || {};
      if (looksLikeCfChallenge(data, res.status)) return cfResult(res, data);
      const { code, message: serverMsg } = apiError(data);

      // 可选：签到后顺带领里程碑。连续天数刚涨上去，可能刚好达成 —— 这正是
      // 「领重置卡」最容易被忘掉的时刻。领取失败不推翻签到结论，只追加说明
      // （与 linux.sb 的「签到后自动抽称号」同规矩）。
      //
      // 两条返回路径都要跑：定时任务常在「用户已手动签过」的日子拿到 409，
      // 若只在「刚签上」那条路上领，里程碑会一直躺在那里没人领。
      const claimNoteFor = async () => {
        if (!autoClaimOn(channel)) return "";
        // 用本次会话解析出来的 cookie（可能是刚登录/刚续期的），别用渠道里那份旧的
        const c = await this.claim({ ...channel, auth: { ...(channel.auth || {}), cookie } });
        return c.ok ? ` · ${c.message}` : ` · 领里程碑失败：${c.message}`;
      };

      if (code === "already_checked_in" || /already checked in/i.test(serverMsg)) {
        const claimNote = await claimNoteFor();
        return {
          ok: true,
          httpStatus: res.status,
          result: {
            success: true,
            alreadyCheckedIn: true,
            message: `今日已签到（站点未重复发放）${claimNote}`,
            reward: null,
            rewardPoints: null,
            checkInDate: data.day || null,
            currentStreak: Number.isFinite(Number(data.streak)) ? Number(data.streak) : null,
            via: "/api/checkin",
          },
          status: { enabled: true, checkedInToday: true },
          message: `${AUTH_VIA_LABEL[authVia] || ""}今日已签到（站点未重复发放）${claimNote}`,
          raw: data,
        };
      }

      if (!res.ok) {
        const extra =
          code === "checkin_disabled"
            ? "（站点运营方把签到关掉了）"
            : code === "email_unverified"
              ? "（站点要求先验证邮箱才能签到）"
              : code === "account_inactive"
                ? "（账号不是 active 状态，签到被拒）"
                : "";
        return {
          ok: false,
          httpStatus: res.status,
          message: `${errorText(data, res.status)}${extra}`,
          raw: data,
        };
      }

      const day = data.day || null;
      const streak = Number.isFinite(Number(data.streak)) ? Number(data.streak) : null;
      const rText = rewardText(data.reward);
      const points = rewardPointsOf(data.reward);
      const failed = data.reward_failed === true;

      const parts = [];
      if (day) parts.push(day);
      if (failed) parts.push("签到成功（当日奖励已无法发放，站点仍记了这一天）");
      else if (rText) parts.push(`签到成功，奖励 ${rText}`);
      else parts.push("签到成功（当日无奖励）");
      if (streak != null) parts.push(`连续 ${streak} 天`);
      const summary = parts.join("，");

      const claimNote = await claimNoteFor();

      return {
        ok: true,
        httpStatus: res.status,
        result: {
          success: true,
          alreadyCheckedIn: false,
          message: `${summary}${claimNote}`,
          // 积分不是钱：进 rewardPoints，别进 reward（面板按美元换算）
          reward: null,
          rewardPoints: points,
          rewardFailed: failed,
          checkInDate: day,
          currentStreak: streak,
          via: "/api/checkin",
        },
        status: { enabled: true, checkedInToday: true, currentStreak: streak },
        message: `${AUTH_VIA_LABEL[authVia] || ""}${summary}${claimNote}`,
        raw: data,
      };
    });
  },

  /**
   * 领取里程碑奖励：POST /api/checkin/claims/{rule_id}（源码 internal/checkin/http.go 的 claim）。
   *
   * 领取接口只认 rule id，所以先读一次 GET /api/checkin 拿「哪些现在可领」——
   * 面板上没有填 rule id 的地方，靠猜是猜不出来的。
   *
   * 「暂无可领」**不是失败**：里程碑按连续天数 / 本月天数达成，没到就是领不了。
   * 这时把进度（如「签到重置卡 1/5」）说清楚，用户才知道还差几天，而不是以为坏了。
   */
  async claim(channel) {
    return this.withSession(channel, async (cookie, authVia) => {
      const st = await this.request(channel, "/api/checkin", { cookie });
      const stData = st.data || {};
      if (looksLikeCfChallenge(stData, st.status)) return cfResult(st, stData);
      if (!st.ok) {
        return { ok: false, httpStatus: st.status, message: errorText(stData, st.status), raw: stData };
      }
      const status = normalizeStatus(stData);
      if (!status.enabled) {
        return {
          ok: false,
          httpStatus: st.status,
          message: "站点未开启签到，里程碑奖励也领不了。",
          raw: stData,
        };
      }

      const rules = Array.isArray(stData.rules) ? stData.rules : [];
      const claimable = rules.filter((r) => r && r.claimable === true && r.id);
      const prefix = AUTH_VIA_LABEL[authVia] || "";

      if (!claimable.length) {
        const pending = rules
          .filter((r) => r && r.claimed !== true)
          .map((r) => `${r.title || r.id} ${Number(r.progress) || 0}/${Number(r.days) || "?"}`);
        const claimedBefore = rules.filter((r) => r && r.claimed === true).map((r) => r.title || r.id);
        const parts = ["暂无可领里程碑"];
        if (pending.length) parts.push(`进行中：${pending.join("、")}`);
        if (claimedBefore.length) parts.push(`本期已领：${claimedBefore.join("、")}`);
        return {
          ok: true,
          httpStatus: st.status,
          status,
          result: {
            success: true,
            claimed: [],
            pending,
            alreadyClaimed: claimedBefore,
            via: "/api/checkin/claims",
          },
          message: `${prefix}${parts.join("；")}`,
          raw: stData,
        };
      }

      const claimed = [];
      const failed = [];
      let lastStatus = st.status;
      for (const rule of claimable) {
        const res = await this.request(channel, `/api/checkin/claims/${encodeURIComponent(rule.id)}`, {
          method: "POST",
          cookie,
          body: {},
        });
        lastStatus = res.status;
        const data = res.data || {};
        const title = rule.title || rule.id;
        if (looksLikeCfChallenge(data, res.status)) {
          failed.push({ id: rule.id, title, message: cfMessage(res.status) });
          continue;
        }
        const { code } = apiError(data);
        // 409 milestone_claimed = 本期已经领过（重复点击 / 并发），算成功不算失败
        if (res.ok || code === "milestone_claimed") {
          const reward = rewardText(data.reward);
          claimed.push({
            id: rule.id,
            title,
            reward: reward || (code === "milestone_claimed" ? "此前已领" : "已发放"),
            rewardPoints: rewardPointsOf(data.reward),
          });
          continue;
        }
        const extra =
          code === "milestone_not_reached"
            ? "（进度还没到）"
            : code === "reward_unavailable"
              ? "（该奖励已无法发放，通常是站点把对应的积分条或重置卡窗口关了）"
              : code === "checkin_disabled"
                ? "（站点把签到关掉了）"
                : "";
        failed.push({ id: rule.id, title, message: `${errorText(data, res.status)}${extra}` });
      }

      const parts = [];
      if (claimed.length) {
        parts.push(`已领：${claimed.map((c) => `${c.title}（${c.reward}）`).join("、")}`);
      }
      if (failed.length) {
        parts.push(`失败：${failed.map((f) => `${f.title}（${f.message}）`).join("、")}`);
      }
      const points = claimed.reduce((sum, c) => sum + (Number(c.rewardPoints) || 0), 0);

      return {
        ok: failed.length === 0,
        httpStatus: lastStatus,
        result: {
          success: failed.length === 0,
          claimed,
          failed,
          rewardPoints: points > 0 ? points : null,
          via: "/api/checkin/claims",
        },
        message: `${prefix}${parts.join("；")}`,
        raw: stData,
      };
    });
  },
};
