/**
 * NodeLoc（https://www.nodeloc.com）签到适配器
 *
 * 站点平台：Discourse 2026.9.0-latest（nodeloc.cc 会 301 到 www.nodeloc.com），
 * 装了 discourse-checkin 插件。签到机制来自插件前端
 * /assets/js/plugins/discourse-checkin_main.*.js：
 *
 *   const nonce = Math.random().toString(36).slice(2,15)
 *               + Math.random().toString(36).slice(2,15)
 *   await ajax("/checkin", {
 *     type: "POST",
 *     headers: { "X-Discourse-Checkin": "true", "X-Checkin-Nonce": nonce },
 *     data: { nonce, timestamp: Date.now() },
 *   })
 *
 * 返回体：{"success":true,"points":N,"user_date":"YYYY-MM-DD"} 或
 *         {"success":false,"message":"..."}（含「今日已签到」）。
 *
 * 插件把「今天是否已签」记在浏览器 localStorage（checkin-<userId>-<date>），
 * **没有只读状态接口**，所以 status() 如实说明这点，不伪造 checkedInToday。
 * Discourse 自带的 /session/current.json 可以取当前用户，用作 me()。
 *
 * 鉴权：Discourse 的会话 Cookie（_t）+ 会话级 CSRF token（GET /session/csrf.json）。
 */

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/** 插件前端用的是 Math.random().toString(36) 截取，这里同构生成（Worker 有 crypto.randomUUID）。 */
function makeNonce() {
  const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 13);
  return `${rand()}${rand()}`;
}

/* 只复用 forum.js 里这一个零件，其余本文件自带（readJson 还要读 location / setCookies） */
import { mergeCookie } from "./forum.js";

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
    .filter((p) => !p.split("=")[0].trim().toLowerCase().startsWith("_cfpre_"))
    .join("; ");
}

function pickAuth(channel) {
  const auth = channel.auth || {};
  return {
    username: String(auth.username || "").trim(),
    cookie: normalizeCookie(auth.cookie || auth.session || ""),
    csrf: String(auth.csrfToken || auth.csrf || "").trim(),
  };
}

async function readJson(res) {
  const text = await res.text();
  let data = null;
  let parsed = false;
  try {
    data = text ? JSON.parse(text) : null;
    parsed = true;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, parsed, data, headers: res.headers };
}

function looksLikeCfChallenge(data, status) {
  const raw = typeof data?.raw === "string" ? data.raw : "";
  if (
    /just a moment|cf-browser-verification|attention required|cdn-cgi\/challenge|challenge-platform/i.test(
      raw
    )
  ) {
    return true;
  }
  return /<!doctype html|<html[\s>]/i.test(raw) && (status === 403 || status === 429 || status === 503);
}

const ALREADY_RE = /已经?签到|重复签到|重复领取|already/i;

function messageOf(data) {
  if (!data || typeof data !== "object") return "";
  return String(data.message || data.msg || data.errors?.[0] || "").trim();
}

function baseHeaders(channel, cookie, csrf) {
  const origin = String(channel.baseUrl || "").replace(/\/+$/, "");
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": CHROME_UA,
    "X-Requested-With": "XMLHttpRequest",
    // Discourse 前端 ajax 会带这个头，服务端据此认为请求来自已登录的 SPA
    "Discourse-Logged-In": "true",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    // HAR 里 POST /checkin 带的就是这个头
    "Discourse-Present": "true",
  };
  if (csrf) headers["X-CSRF-Token"] = csrf;
  if (cookie) headers.Cookie = cookie;
  if (origin) {
    headers.Origin = origin;
    headers.Referer = `${origin}/`;
  }
  return headers;
}

export const nodelocAdapter = {
  id: "nodeloc",
  name: "NodeLoc",
  description: "nodeloc.com（Discourse）：POST /checkin + X-Checkin-Nonce",
  fields: [
    {
      key: "baseUrl",
      label: "站点地址",
      placeholder: "https://www.nodeloc.com",
      required: true,
    },
    {
      key: "auth.cookie",
      label: "Cookie（必需；Discourse 会话 Cookie _t，浏览器登录后从 F12 → Application → Cookies 复制）",
      type: "textarea",
      placeholder: "_t=...; _forum_session=...",
    },
    {
      key: "auth.csrfToken",
      label: "CSRF Token（可选；留空则自动用 Cookie 请求 /session/csrf.json 获取）",
      placeholder: "留空即可自动获取",
    },
    {
      key: "auth.username",
      label: "备注账号（可选，仅用于面板上辨认渠道）",
      placeholder: "你的论坛用户名",
    },
  ],

  async request(channel, path, { method = "GET", cookie, csrf, body, headers: extra } = {}) {
    const headers = baseHeaders(channel, cookie, csrf);
    // HAR 实测：POST /checkin 用的是 x-www-form-urlencoded（Discourse 的 ajax 对
    // 纯对象 data 就是表单编码），不是 JSON —— 发 JSON 服务端拿不到 nonce。
    if (method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    }
    if (extra) {
      // 插件自定义头（X-Discourse-Checkin / X-Checkin-Nonce）不能丢：站点服务端
      // 会校验它们与 body 里的 nonce 是否一致。
      Object.assign(headers, extra);
    }
    const res = await fetch(joinUrl(channel.baseUrl, path), {
      method,
      headers,
      body: body == null ? undefined : new URLSearchParams(body).toString(),
      redirect: "manual",
    });
    return readJson(res);
  },

  /**
   * CSRF token 与会话绑定：带 Cookie 请求 /session/csrf.json 拿到的就是当前
   * 会话的 token。渠道里手填的 auth.csrfToken 优先（省一次往返）。
   *
   * 顺带把这个响应下发的 Cookie 并进 cookie 串：Discourse 可能在这步轮换会话
   * cookie，浏览器会把新值带在后续请求上，我们手动管理 Cookie，必须自己跟上。
   */
  async ensureCsrf(channel, cookie) {
    const auth = pickAuth(channel);
    if (auth.csrf) return { csrf: auth.csrf, cookie };
    const res = await this.request(channel, "/session/csrf.json", { cookie });
    const csrf = String(res.data?.csrf || "").trim();
    if (!csrf) {
      return {
        error:
          `拿不到 CSRF token（HTTP ${res.status}）。请确认 Cookie 里的 _t 有效：` +
          `在浏览器重新登录 https://www.nodeloc.com 后重新复制 Cookie。`,
      };
    }
    return { csrf, cookie: mergeCookie(cookie, res.setCookies || []) };
  },

  /** Discourse 标准端点：GET /session/current.json → { current_user: {...} } */
  async me(channel) {
    const auth = pickAuth(channel);
    if (!auth.cookie) {
      return { ok: false, message: "缺少 Cookie。NodeLoc 只支持 Discourse 会话 Cookie 鉴权。" };
    }
    const res = await this.request(channel, "/session/current.json", { cookie: auth.cookie });
    const data = res.data || {};
    if (looksLikeCfChallenge(data, res.status)) {
      return {
        ok: false,
        httpStatus: res.status,
        message:
          "请求被 Cloudflare 拦截（返回 Just a moment... 挑战页）。" +
          "请在 Cookie 里补上 cf_clearance，或把本渠道通道改为 gha_api（Azure 出口 IP）再试。",
        raw: data,
      };
    }
    const user = data.current_user || null;
    if (!user) {
      return {
        ok: false,
        httpStatus: res.status,
        message:
          `${messageOf(data) || `HTTP ${res.status}`} · Cookie 无效或已过期（Discourse 未识别当前用户）。` +
          "请在浏览器重新登录 https://www.nodeloc.com 后复制 Cookie（含 _t）更新本渠道。",
        raw: data,
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      user: {
        id: user.id,
        username: user.username || "",
        displayName: user.name || user.username || "",
        group: user.trust_level != null ? `TL${user.trust_level}` : null,
        raw: user,
      },
      message: `${user.name || user.username} · ${user.username ? `@${user.username}` : ""}`.trim(),
      raw: data,
      tokens: { cookie: auth.cookie },
    };
  },

  /** Cookie 校验：只读端点，不触发签到（与 forum 系相反，这里不必借签到接口）。 */
  async login(channel) {
    const me = await this.me(channel);
    return {
      ok: me.ok,
      httpStatus: me.httpStatus,
      message: me.ok ? `Cookie 有效 · ${me.message}` : me.message,
      user: me.user || null,
      raw: me.raw,
      tokens: me.tokens || null,
    };
  },

  async status(channel) {
    const auth = pickAuth(channel);
    if (!auth.cookie) {
      return { ok: false, message: "缺少 Cookie，无法签到 NodeLoc。" };
    }
    return {
      ok: true,
      httpStatus: null,
      status: {
        enabled: true,
        note: "discourse-checkin 插件没有只读状态接口，签到接口幂等",
      },
      message:
        "NodeLoc 无只读签到状态接口（插件把「今天是否已签」存在浏览器 localStorage 里）。" +
        "直接点「签到」即可，重复签到会返回「今日已签到」。",
      raw: null,
      tokens: { cookie: auth.cookie },
    };
  },

  async checkin(channel) {
    const auth = pickAuth(channel);
    if (!auth.cookie) {
      return {
        ok: false,
        message:
          "缺少 Cookie。NodeLoc 只支持 Discourse 会话 Cookie 鉴权：" +
          "在浏览器登录 https://www.nodeloc.com 后复制 Cookie（含 _t）填入本渠道。",
      };
    }

    const cs = await this.ensureCsrf(channel, auth.cookie);
    if (cs.error) {
      return { ok: false, message: cs.error, raw: null };
    }
    // /session/csrf.json 可能轮换了会话 cookie，用更新后的那一份去签到
    const cookie = cs.cookie;

    const nonce = makeNonce();
    const res = await this.request(channel, "/checkin", {
      method: "POST",
      cookie,
      csrf: cs.csrf,
      // 这两个头是 discourse-checkin 插件自己加的（见文件头注释），
      // 服务端会校验 X-Checkin-Nonce 与 body 里的 nonce 一致
      headers: { "X-Discourse-Checkin": "true", "X-Checkin-Nonce": nonce },
      body: { nonce, timestamp: Date.now() },
    });

    const data = res.data || {};
    const serverMsg = messageOf(data);
    // 回写更新后的 cookie（/session/csrf.json 可能轮换了会话）
    const tokens = { cookie };

    if (looksLikeCfChallenge(data, res.status)) {
      return {
        ok: false,
        httpStatus: res.status,
        message:
          "请求被 Cloudflare 拦截（返回 Just a moment... 挑战页），不是凭证问题。" +
          "请在 Cookie 里补上 cf_clearance，或把本渠道通道改为 gha_api（GitHub Actions 的 Azure 出口 IP）再试。",
        raw: data,
        tokens,
      };
    }

    // HAR 实测成功体：{"success":true,"points":10,"user_date":"2026-10-01","timezone":"Asia/Shanghai"}
    // points 是站点积分，不是钱：放 rewardPoints，别让面板按美元显示。
    if (res.parsed && data.success === true) {
      const points = Number(data.points);
      const rewardText = Number.isFinite(points) && points > 0 ? `，奖励 ${points} 积分` : "";
      // 响应头 x-discourse-username 带当前用户名（HAR 实测），顺手取来当用户信息
      const username = res.headers?.get("x-discourse-username") || "";
      return {
        ok: true,
        httpStatus: res.status,
        result: {
          success: true,
          alreadyCheckedIn: false,
          message: serverMsg || `签到成功${rewardText}`,
          reward: null,
          rewardPoints: Number.isFinite(points) ? points : null,
          checkInDate: data.user_date || null,
          timezone: data.timezone || null,
          via: "/checkin",
        },
        status: { enabled: true, checkedInToday: true },
        user: username ? { username, displayName: username, raw: {} } : null,
        message: [serverMsg || `签到成功${rewardText}`, data.user_date ? `（${data.user_date}）` : null]
          .filter(Boolean)
          .join(""),
        raw: data,
        tokens,
      };
    }

    // 插件已签到时回 success:false + 「今日已签到」，这算成功而不是失败
    if (ALREADY_RE.test(serverMsg)) {
      return {
        ok: true,
        httpStatus: res.status,
        result: {
          success: true,
          alreadyCheckedIn: true,
          message: serverMsg,
          reward: null,
          via: "/checkin",
        },
        status: { enabled: true, checkedInToday: true },
        message: serverMsg,
        raw: data,
        tokens,
      };
    }

    if (res.status === 403 || res.status === 401 || /csrf|invalid|未登录|请先登录|not logged in|expired/i.test(serverMsg)) {
      return {
        ok: false,
        httpStatus: res.status,
        message:
          `${serverMsg || `HTTP ${res.status}`} · Cookie 无效或已过期 / CSRF 不匹配。` +
          "Discourse 的 CSRF token 与会话绑定：请在浏览器重新登录 https://www.nodeloc.com，" +
          "重新复制 Cookie（含 _t）后更新本渠道（不要复用旧的 csrfToken 字段）。",
        raw: data,
        tokens,
      };
    }

    return {
      ok: false,
      httpStatus: res.status,
      message: serverMsg || `签到失败 HTTP ${res.status}`,
      raw: data,
      tokens,
    };
  },
};