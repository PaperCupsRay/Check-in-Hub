/**
 * NodeSeek（https://www.nodeseek.com）签到适配器
 *
 * 机制（2026-09-30 用户 HAR 实测，NodeSeek 前端 Express 接口）：
 *
 *   POST /api/attendance?random=true      （无请求体，content-length: 0）
 *   → {"success":true,"message":"今天的签到收益是6个鸡腿","gain":6,"current":599}
 *
 *   gain    = 今日获得的鸡腿；current = 当前鸡腿余额（不是美元，面板别按金额显示）
 *
 *   GET /api/attendance/board?page=1
 *   → {"list":[{"id":…,"member_id":…,"day_id":…,"gain":13,"created_at":…,"member_name":"…"}]}
 *     这是**今日**签到排行榜；渠道里填了用户名就能用它当只读状态源。
 *
 * 三个坑：
 *  1. 站点风控对任何可疑请求回 403 + {"success":false,"message":"high risk action"}。
 *     无 Cookie、带 Cookie 但已失效、路径写错（我一开始误以为接口叫 /api/attend）
 *     都是这一句，所以**不能**把它当成「接口不存在」，只能当成会话/风控问题。
 *  2. HAR 里那次成功请求带了站点自己的签名头 refract-key / refract-sign /
 *     refract-version（由 sw.js 生成，key 里带时间戳）。本适配器不带这些头；
 *     若站点强制校验，日志会表现为 high risk action。
 *  3. **本适配器对这两站已经不够用了**（2026-10-13 线上实测）：NodeSeek 全站在
 *     Cloudflare 后面，Worker 出口只拿到一个 302（CF 边缘重定向）、Azure 出口
 *     403 Just a moment；而 Cookie 里的 cf_clearance 与签发它的出口 IP 绑定，
 *     拷到机房出口直接失效。结论：把渠道的签到通道设成 gha_browser，让真浏览器
 *     过挑战、再在页面里发这一枪（见 scripts/browser-checkin.py 的
 *     nodeseek_browser_checkin）。下面的实现保留为 worker 通道的降级尝试。
 */

import {
  CHROME_UA,
  ALREADY_RE,
  AUTH_FAIL_RE,
  joinUrl,
  looksLikeCfChallenge,
  messageOf,
  mergeCookie,
  pickCookie,
  responseTextHint,
  readResponse,
} from "./forum.js";

const ATTEND_PATH = "/api/attendance";
const BOARD_PATH = "/api/attendance/board";

function headers(channel, cookie) {
  const origin = String(channel.baseUrl || "").replace(/\/+$/, "");
  return {
    // HAR 里成功请求就是 accept: */*，别自作聪明改成 application/json
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": CHROME_UA,
    Origin: origin,
    Referer: `${origin}/board`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function request(channel, path, cookie) {
  const res = await fetch(joinUrl(channel.baseUrl, path), {
    method: path.includes("board") ? "GET" : "POST",
    headers: headers(channel, cookie),
    redirect: "manual",
  });
  return readResponse(res);
}

function cookieMissingMessage() {
  return (
    "缺少 Cookie。NodeSeek 只支持浏览器 Cookie 鉴权（站点走 LinuxDo OAuth，无账密登录）：" +
    "在浏览器登录 https://www.nodeseek.com 后，F12 → Application → Cookies 复制整站 Cookie。"
  );
}

function riskMessage(res, serverMsg) {
  return (
    `站点风控拦截（HTTP ${res.status}${serverMsg ? `：${serverMsg}` : ""}）。` +
    "这通常不是接口写错，而是会话 Cookie 失效或站点要求浏览器指纹签名。" +
    "解法：把本渠道的签到通道改成 gha_browser（浏览器通道）—— 真浏览器过 Cloudflare" +
    "挑战、再在页面里发签到请求，签名头由站点自己的前端生成；" +
    "若仍失败，请重新登录后重抄整站 Cookie（含 cf_clearance 更好，但换出口即失效）。"
  );
}

function cfMessage(res) {
  return (
    `NodeSeek 的请求被 Cloudflare 拦截（返回 Just a moment... 挑战页，HTTP ${res.status}），不是凭证问题。` +
    "解法：把本渠道的签到通道改成 gha_browser（真浏览器过挑战，再在页面内签到）。" +
    "注意两种情况都别再试：① 把 cf_clearance 拷进渠道 —— 它与签发时的出口 IP 绑定，" +
    "换到机房出口即失效；② 改成 gha_api —— 2026-10-13 实测 Azure 出口同样是 403（挑战页）。"
  );
}

/** Worker 出口拿到 302（CF 边缘重定向，body 是空的 302 Found）时给出的说明 */
function redirectMessage(res) {
  const to = res.location || "(响应没有 Location 头)";
  return (
    `NodeSeek 把请求重定向了（HTTP ${res.status} → ${to}），本机出口拿不到签到结果。` +
    "这同样是出口被 CF 拦下的形态，不是凭证问题：把本渠道的签到通道改成 gha_browser。" +
    "若跳转目标是登录页，请重新登录后重抄整站 Cookie。"
  );
}

function notFoundMessage(res) {
  return (
    `NodeSeek 上不存在 ${ATTEND_PATH} 这个接口（HTTP ${res.status}）。` +
    "请确认 Base URL 是站点根地址（https://www.nodeseek.com）。"
  );
}

export const nodeseekAdapter = {
  id: "nodeseek",
  name: "NodeSeek",
  description: "nodeseek.com：POST /api/attendance?random=true（收益单位=鸡腿）",
  fields: [
    { key: "baseUrl", label: "站点地址", placeholder: "https://www.nodeseek.com", required: true },
    {
      key: "auth.cookie",
      label: "Cookie（必需；浏览器登录后从 F12 → Application → Cookies 复制，含 cf_clearance 更好）",
      type: "textarea",
      placeholder: "session=...; ...",
    },
    {
      key: "auth.username",
      label: "论坛用户名（可选；填了才能用签到排行榜判断「今日是否已签」）",
      placeholder: "PaperCups",
    },
  ],

  async checkin(channel) {
    let cookie = pickCookie(channel);
    if (!cookie) return { ok: false, message: cookieMissingMessage() };

    const res = await request(channel, `${ATTEND_PATH}?random=true`, cookie);
    if (res.setCookies?.length) cookie = mergeCookie(cookie, res.setCookies);

    const data = res.data || {};
    const serverMsg = messageOf(data);
    const tokens = { cookie };

    if (looksLikeCfChallenge(data, res.status)) {
      // needsBrowser：换出口（gha_api）实测同样被挑战，别再浪费一次注定失败的运行；
      // 交给 batchCheckinCore 直接分发到浏览器通道（BROWSER_CAPABLE 含 nodeseek）。
      return { ok: false, httpStatus: res.status, needsBrowser: true, message: cfMessage(res), raw: data, tokens };
    }
    if (res.status === 404) {
      return { ok: false, httpStatus: res.status, message: notFoundMessage(res), raw: data, tokens };
    }
    // 302（CF 边缘的重定向，body 是空的 302 Found）：2026-10-13 Worker 出口实测就是
    // 这条。旧版把 Location 丢掉、只报「签到失败 HTTP 302」，谁也没法判断被甩去哪。
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        httpStatus: res.status,
        needsBrowser: true,
        message: redirectMessage(res),
        raw: { location: res.location, body: responseTextHint(data) },
        tokens,
      };
    }

    // HAR 实测成功体：{"success":true,"message":"今天的签到收益是6个鸡腿","gain":6,"current":599}
    if (res.parsed && data.success === true) {
      const gain = Number(data.gain);
      const already = ALREADY_RE.test(serverMsg) || (Number.isFinite(gain) && gain === 0);
      const parts = [serverMsg || (already ? "今日已签到" : "签到成功")];
      if (data.current != null) parts.push(`鸡腿余额 ${data.current}`);
      return {
        ok: true,
        httpStatus: res.status,
        result: {
          success: true,
          alreadyCheckedIn: already,
          message: parts[0],
          // 鸡腿是站内积分，不是钱：放 rewardPoints，面板按文案展示
          rewardPoints: Number.isFinite(gain) ? gain : null,
          balance: data.current ?? null,
          via: ATTEND_PATH,
        },
        // 鸡腿余额刻意不放 user.balance：面板余额区是按美元换算的，
        // 599 鸡腿会显示成 $0.00，比不显示更误导。余额写进 message。
        user: null,
        status: { enabled: true, checkedInToday: true },
        message: parts.join(" · "),
        raw: data,
        tokens,
      };
    }

    // 「high risk action」是 NodeSeek 的通用风控回话（Cookie 失效 / 没带 CF 放行 /
    // 站点要求浏览器指纹签名都会这样），必须单独说清，否则用户只会一直换 Cookie。
    if (/high risk action/i.test(serverMsg)) {
      return { ok: false, httpStatus: res.status, message: riskMessage(res, serverMsg), raw: data, tokens };
    }
    // 其他会话类拒绝
    if (AUTH_FAIL_RE.test(serverMsg) || res.status === 401 || res.status === 403) {
      return {
        ok: false,
        httpStatus: res.status,
        message: `Cookie 无效或已过期（站点回：${serverMsg || `HTTP ${res.status}`}）。${cookieMissingMessage()}`,
        raw: data,
        tokens,
      };
    }
    return {
      ok: false,
      httpStatus: res.status,
      message: res.status === 403 ? riskMessage(res, serverMsg) : serverMsg || `签到失败 HTTP ${res.status}`,
      raw: data,
      tokens,
    };
  },

  /**
   * 只读状态源：今日签到排行榜里有自己的名字就说明今天签过了。
   * 没填用户名时返回不了结论，如实说明而不是假装「今日未签」。
   */
  async status(channel) {
    const cookie = pickCookie(channel);
    if (!cookie) return { ok: false, message: cookieMissingMessage() };
    const username = String(channel.auth?.username || "").trim();

    if (!username) {
      return {
        ok: true,
        httpStatus: null,
        status: {
          enabled: true,
          note: "NodeSeek 没有独立状态接口；填了「论坛用户名」后可用签到排行榜判断今日是否已签",
        },
        message:
          "NodeSeek 没有只读状态接口（/api/attendance 只在签到时返回收益）。" +
          "在渠道里填上「论坛用户名」，这里就能用签到排行榜判断今日是否已签。",
        raw: null,
        tokens: { cookie },
      };
    }

    const res = await request(channel, `${BOARD_PATH}?page=1`, cookie);
    const data = res.data || {};
    if (looksLikeCfChallenge(data, res.status)) {
      return { ok: false, httpStatus: res.status, message: cfMessage(res), raw: data, tokens: { cookie } };
    }
    if (res.status === 404) {
      return { ok: false, httpStatus: res.status, message: notFoundMessage(res), raw: data, tokens: { cookie } };
    }
    const list = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
    const hit = list.find(
      (row) => String(row?.member_name || "").toLowerCase() === username.toLowerCase()
    );
    if (!hit) {
      return {
        ok: true,
        httpStatus: res.status,
        status: { enabled: true, checkedInToday: false, checkinCount: list.length },
        message: `今日签到排行榜（第 1 页 ${list.length} 人）里没有 ${username}，今日大概率未签到`,
        raw: { list: list.slice(0, 5) },
        tokens: { cookie },
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      status: { enabled: true, checkedInToday: true, rewardPoints: hit.gain ?? null },
      message: `今日已签到 · 获得 ${hit.gain ?? "?"} 鸡腿（${hit.created_at || ""}）`,
      raw: hit,
      tokens: { cookie },
    };
  },

  async me(channel) {
    const cookie = pickCookie(channel);
    if (!cookie) return { ok: false, message: cookieMissingMessage() };
    // 没有 /api/user/self 之类端点：鸡腿余额只在签到响应里，别为了「有返回」去猜路径。
    return {
      ok: true,
      httpStatus: null,
      user: null,
      message:
        "NodeSeek 不提供用户信息接口（鸡腿余额只在 /api/attendance 的返回里）。" +
        "余额请看「签到」或「状态」的返回。",
      raw: null,
      tokens: { cookie },
    };
  },

  /** Cookie 校验：没有只读接口，只能跑一次幂等签到。 */
  async login(channel) {
    if (!pickCookie(channel)) return { ok: false, message: cookieMissingMessage() };
    const r = await this.checkin(channel);
    return {
      ok: r.ok,
      httpStatus: r.httpStatus,
      message: r.ok ? `Cookie 有效 · ${r.message}` : r.message,
      result: r.result || null,
      raw: r.raw,
      tokens: r.tokens || null,
    };
  },
};