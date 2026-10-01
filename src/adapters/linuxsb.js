/**
 * linux.sb（烧饼社区，https://linux.sb）适配器：自动签到 + 抽称号
 *
 * 机制全部来自 2026-09-30 用户 HAR（PHP/8.5.8，服务端渲染页面 + 少量 JS 增强）：
 *
 * 【签到是自动的】
 *   站点没有单独的签到接口：打开任意页面时，如果当天还没签，服务端顺手完成签到，
 *   并把提示写进页面里的 <script>window.__pageFlash="…"</script>。
 *   /app/assets/plugins.js 的 daily_checkin 模块就是这么读的：
 *       if (!message.startsWith('您是') || !message.includes('已帮您完成自动签到')) return;
 *   所以「签到」= 带 Cookie GET /，再读 __pageFlash：
 *     - 有「已帮您完成自动签到」→ 今天刚签上，+N 积分（HAR 里用户页显示「每日签到 +19 积分」）
 *     - __pageFlash 为空       → 今天已经签过了（页面里确实会出现这种情况）
 *   HAR 的 209 条记录里没有任何 /api/attend 调用 —— 该路由存在但前端不用，别去猜它。
 *
 * 【抽称号】
 *   /gacha 页面是纯 HTML 表单（data-no-ajax="1"）：
 *     POST /gacha_pull     _csrf=<token>   →「今日免费一抽」（data-cost="0"）
 *     POST /gacha_pull_10  _csrf=<token>   → 十连抽 90 积分
 *     POST /gacha_pull_100 _csrf=<token>  → 百连抽 800 积分
 *   成功时 302 → Location: /gacha_pull?result=<token>，该页 HTML 里是
 *     <div class="gacha-result-card gacha-result-r">
 *       <div class="gacha-result-rarity">R</div>
 *       <div class="gacha-result-icon">📨</div>
 *       <div class="gacha-result-name">回复达人</div>
 *       <div class="gacha-result-desc">秒回小能手</div>
 *       <div class="gacha-result-quantity">获得 × 1（已累计）</div>
 *
 *   _csrf 是会话级 token，站内每个页面的隐藏表单里都有同一个值（HAR 里 4 个页面
 *   的值完全相同），所以取任意一个已登录页面即可，不必专门打 /gacha。
 *
 * 本适配器只做**免费一抽**（不花积分）。十连/百连要花积分，留给手动操作。
 */

import {
  CHROME_UA,
  joinUrl,
  looksLikeCfChallenge,
  mergeCookie,
  pickCookie,
  readResponse,
} from "./forum.js";

const FREE_PULL_PATH = "/gacha_pull";

function cookieMissingMessage() {
  return (
    "缺少 Cookie。linux.sb 只支持浏览器 Cookie 鉴权（站点走 OAuth，无账密登录）：" +
    "在浏览器登录 https://linux.sb 后，F12 → Application → Cookies 复制整站 Cookie。"
  );
}

function pageHeaders(channel, cookie, { method = "GET", referer, contentType } = {}) {
  const origin = String(channel.baseUrl || "").replace(/\/+$/, "");
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": CHROME_UA,
    Origin: origin,
    Referer: referer || `${origin}/`,
    "Sec-Fetch-Dest": method === "GET" ? "document" : "empty",
    "Sec-Fetch-Mode": method === "GET" ? "navigate" : "cors",
    "Sec-Fetch-Site": "same-origin",
    ...(cookie ? { Cookie: cookie } : {}),
  };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function getPage(channel, path, cookie) {
  const res = await fetch(joinUrl(channel.baseUrl, path), {
    method: "GET",
    headers: pageHeaders(channel, cookie),
    redirect: "manual",
  });
  return readResponse(res);
}

/** 登录页特征：未登录时首页不会出现「每日签到」入口 / 用户卡 */
function loggedIn(html) {
  return /href="\/daily_checkin"/.test(html) && /class="user-name"/.test(html);
}

function csrfOf(html) {
  const m = /name="_csrf"\s+value="([^"]+)"/.exec(html);
  return m ? m[1] : "";
}

/** 服务端把一次性提示写在这里（HTML 里的 JS 字符串字面量） */
function flashOf(html) {
  const m = /window\.__pageFlash\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(html);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

function pageFailure(channel, res, action) {
  const html = res.text || "";
  if (looksLikeCfChallenge({ raw: html }, res.status)) {
    return (
      `linux.sb 的${action}被 Cloudflare 拦截（Just a moment...，HTTP ${res.status}），不是凭证问题。` +
      "解法：①Cookie 里补上 cf_clearance；②把该渠道的签到通道改成 gha_api（Azure 出口 IP）。"
    );
  }
  if (res.status === 403 || res.status === 401) {
    return `${action}被拒绝（HTTP ${res.status}）。${cookieMissingMessage()}`;
  }
  if (!loggedIn(html)) {
    return (
      `${action}拿到的页面不是登录态（未登录时首页没有「每日签到」入口）。` +
      `Cookie 无效或已过期。${cookieMissingMessage()}`
    );
  }
  return null;
}

function pointsFrom(text) {
  const m = /\+?\s*(\d+(?:\.\d+)?)\s*(?:积分|分)/.exec(text);
  return m ? Number(m[1]) : null;
}

export const linuxsbAdapter = {
  id: "linuxsb",
  name: "linux.sb",
  description: "linux.sb：打开页面即自动签到；可另抽称号（免费一抽）",
  // 面板按这个数组在卡片上渲染额外按钮（见 src/ui.html）
  actions: [{ action: "gacha", label: "抽称号", title: "消耗每日免费一抽机会（不花积分）" }],
  fields: [
    { key: "baseUrl", label: "站点地址", placeholder: "https://linux.sb", required: true },
    {
      key: "auth.cookie",
      label: "Cookie（必需；浏览器登录后从 F12 → Application → Cookies 复制，含 cf_clearance 更好）",
      type: "textarea",
      placeholder: "PHPSESSID=...; ...",
    },
    {
      key: "auth.username",
      label: "备注账号（可选，仅用于面板上辨认渠道）",
      placeholder: "你的论坛用户名",
    },
    {
      key: "options.autoGacha",
      label: "签到后自动抽称号（true/false，默认 false）",
      placeholder: "true",
    },
  ],

  /**
   * 签到 = GET / 让服务端顺手签，结论从 window.__pageFlash 读。
   * __pageFlash 为空 = 今天已经签过（HAR 里两次 GET / 都是空串）。
   */
  async checkin(channel) {
    let cookie = pickCookie(channel);
    if (!cookie) return { ok: false, message: cookieMissingMessage() };

    const res = await getPage(channel, "/", cookie);
    if (res.setCookies?.length) cookie = mergeCookie(cookie, res.setCookies);
    const html = res.text || "";
    const tokens = { cookie };

    const failed = pageFailure(channel, res, "签到");
    if (failed) return { ok: false, httpStatus: res.status, message: failed, raw: null, tokens };

    const flash = flashOf(html);
    const auto = /已帮您完成自动签到/.test(flash);
    const points = pointsFrom(flash);
    const parts = [];
    if (auto) {
      parts.push(flash || "已帮您完成自动签到");
      if (points != null) parts.push(`+${points} 积分`);
    } else {
      parts.push(
        flash
          ? `今日自动签到无变化（站点提示：${flash}）`
          : "今日已签过（linux.sb 是打开页面自动签到，__pageFlash 为空即当日已完成）"
      );
    }

    let result = {
      success: true,
      alreadyCheckedIn: !auto,
      message: parts.join(" · "),
      rewardPoints: auto ? points : null,
      via: "GET / (服务端自动签到)",
    };
    let message = parts.join(" · ");

    // 可选：签到顺带抽一次称号（免费一抽）。失败不推翻签到结论，只追加说明。
    if (autoGachaOn(channel)) {
      const g = await this.gacha(channel);
      if (g.ok) {
        result.titles = g.result?.titles || [];
        message += ` · ${g.message}`;
      } else {
        message += ` · 抽称号失败：${g.message}`;
      }
    }

    return {
      ok: true,
      httpStatus: res.status,
      result,
      status: { enabled: true, checkedInToday: true },
      message,
      raw: { flash },
      tokens,
    };
  },

  /** 抽称号（免费一抽）：取 _csrf → POST /gacha_pull → 302 → 解析结果页 */
  async gacha(channel) {
    const cookie = pickCookie(channel);
    if (!cookie) return { ok: false, message: cookieMissingMessage() };

    // _csrf 在站内每个页面的隐藏表单里都是同一个值，取首页即可
    // _csrf 在站内每个页面的隐藏表单里都是同一个值，取首页即可
    const home = await getPage(channel, "/", cookie);
    const failed = pageFailure(channel, home, "抽称号");
    if (failed) return { ok: false, httpStatus: home.status, message: failed, raw: null, tokens: { cookie } };

    let cur = mergeCookie(cookie, home.setCookies || []);
    const csrf = csrfOf(home.text || "");
    if (!csrf) {
      return {
        ok: false,
        httpStatus: home.status,
        message:
          "页面里没找到 _csrf 令牌（linux.sb 的每个表单都带它）。" +
          "通常是 Cookie 失效导致拿到未登录页，请重新登录后重拷 Cookie。",
        raw: null,
        tokens: { cookie: cur },
      };
    }

    const origin = String(channel.baseUrl || "").replace(/\/+$/, "");
    const post = await fetch(joinUrl(channel.baseUrl, FREE_PULL_PATH), {
      method: "POST",
      headers: pageHeaders(channel, cur, {
        method: "POST",
        referer: `${origin}/gacha`,
        contentType: "application/x-www-form-urlencoded",
      }),
      body: new URLSearchParams({ _csrf: csrf }).toString(),
      redirect: "manual",
    });
    const postRes = await readResponse(post);
    if (postRes.setCookies?.length) cur = mergeCookie(cur, postRes.setCookies);

    const tokens = { cookie: cur };

    if (looksLikeCfChallenge({ raw: postRes.text || "" }, postRes.status)) {
      return {
        ok: false,
        httpStatus: postRes.status,
        message:
          "抽称号被 Cloudflare 拦截（Just a moment...）。" +
          "解法：①Cookie 里补上 cf_clearance；②把该渠道的签到通道改成 gha_api（Azure 出口 IP）。",
        raw: null,
        tokens,
      };
    }

    // 正常路径：302 → /gacha_pull?result=<token>
    const location = postRes.location || "";
    if (postRes.status >= 300 && postRes.status < 400 && location) {
      const resultUrl = location.startsWith("http") ? location : joinUrl(channel.baseUrl, location);
      const page = await fetch(resultUrl, {
        method: "GET",
        headers: pageHeaders(channel, cur, { referer: `${origin}/gacha` }),
        redirect: "manual",
      });
      const pageRes = await readResponse(page);
      if (pageRes.setCookies?.length) cur = mergeCookie(cur, pageRes.setCookies);
      const titles = parseTitles(pageRes.text || "");
      if (!titles.length) {
        return {
          ok: false,
          httpStatus: pageRes.status,
          message:
            "提交成功但结果页里没解析到称号卡片（站点可能改了页面结构，或今日免费抽已用完）。" +
            `结果地址：${location}`,
          raw: { location },
          tokens: { cookie: cur },
        };
      }
      return {
        ok: true,
        httpStatus: pageRes.status,
        result: {
          success: true,
          titles,
          // 积分不是钱，别塞进 reward（面板会按美元显示）
          reward: null,
          via: FREE_PULL_PATH,
        },
        message: `抽到 ${titles.map(titleLine).join("、")}`,
        raw: { location },
        tokens: { cookie: cur },
      };
    }

    // 非 302：多半是「今日免费抽已用完」/ 令牌失效，页面本身会说明
    const html = postRes.text || "";
    const flash = flashOf(html);
    return {
      ok: false,
      httpStatus: postRes.status,
      message:
        `抽称号未成功（HTTP ${postRes.status}${flash ? `：${flash}` : ""}）。` +
        "常见原因：今日免费一抽已用完（每天一次），或 _csrf 过期（重新点一次即可刷新）。",
      raw: { flash, snippet: html.replace(/\s+/g, " ").slice(0, 200) },
      tokens,
    };
  },

  /** 只读状态：没有状态接口，但可以读「每日签到」页面的今日状态 */
  async status(channel) {
    const cookie = pickCookie(channel);
    if (!cookie) return { ok: false, message: cookieMissingMessage() };
    const res = await getPage(channel, "/daily_checkin", cookie);
    const failed = pageFailure(channel, res, "状态查询");
    if (failed) return { ok: false, httpStatus: res.status, message: failed, raw: null, tokens: { cookie } };

    const html = res.text || "";
    const flash = flashOf(html);
    const done = /已签到|今日已签|签到完成|已获得/.test(html);
    const points = pointsFrom(html);
    return {
      ok: true,
      httpStatus: res.status,
      status: { enabled: true, checkedInToday: done || !!flash },
      message: done
        ? `今日已签到${points != null ? ` · ${points} 积分` : ""}`
        : "「每日签到」页面上没看到今日已签记录；直接点「签到」即可（打开页面就会自动签）。",
      raw: null,
      tokens: { cookie },
    };
  },

  /** Cookie 校验：读首页看是不是登录态 */
  async me(channel) {
    const cookie = pickCookie(channel);
    if (!cookie) return { ok: false, message: cookieMissingMessage() };
    const res = await getPage(channel, "/", cookie);
    const html = res.text || "";
    // 只认侧栏 user-card 里那一份：页面别处也有 /user/<id> 链接（管理员、楼层用户），
    // 泛匹配 /href="\/user\/(\d+)"/ 会抓到别人的 id（实测首页第一个是 /user/1）。
    const id = /class="user-avatar-big"\s+href="\/user\/(\d+)"/.exec(html)?.[1];
    const name = /class="user-name"\s+href="\/user\/\d+">([^<]+)</.exec(html)?.[1]?.trim();
    const points = /class="user-rank"[^>]*>\s*积分\s*([\d,]+)/.exec(html)?.[1];
    if (!loggedIn(html)) {
      return {
        ok: false,
        httpStatus: res.status,
        message: `Cookie 无效或已过期（拿到的首页不是登录态）。${cookieMissingMessage()}`,
        raw: null,
        tokens: { cookie },
      };
    }
    return {
      ok: true,
      httpStatus: res.status,
      user: {
        id: id ? String(id) : null,
        username: channel.auth?.username || name || "",
        displayName: name || "",
        // 积分是站内点数，不是钱：不放进 balance（面板会按美元换算），只写在 message
        points: points ? Number(String(points).replace(/,/g, "")) : null,
        raw: {},
      },
      message: [name || (id ? `用户 #${id}` : "已登录"), points ? `积分 ${points}` : null]
        .filter(Boolean)
        .join(" · "),
      raw: null,
      tokens: { cookie },
    };
  },

  /** Cookie 校验（面板的「登录校验」按钮）：跑一次自动签到，幂等 */
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

function autoGachaOn(channel) {
  const v = channel.options?.autoGacha ?? channel.auth?.autoGacha;
  return v === true || v === "true" || v === 1 || v === "1";
}

function titleLine(t) {
  const head = [t.rarity, t.icon, t.name].filter(Boolean).join(" ");
  return t.desc ? `${head}（${t.desc}）` : head;
}

/** 解析结果页：<div class="gacha-result-card">…rarity/icon/name/desc/quantity…</div> */
function parseTitles(html) {
  const cards = html.match(/<div class="gacha-result-card[\s\S]*?(?=<div class="gacha-result-card|<\/div><\/div><\/div><\/div>|$)/g);
  if (!cards) return [];
  const out = [];
  for (const card of cards.slice(0, 20)) {
    const pick = (cls) => {
      const m = new RegExp(`class="gacha-result-${cls}"[^>]*>([\\s\\S]*?)</div>`).exec(card);
      return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
    };
    const rarity = pick("rarity");
    const name = pick("name");
    if (!name) continue;
    out.push({
      rarity,
      icon: pick("icon"),
      name,
      desc: pick("desc"),
      quantity: pick("quantity"),
    });
  }
  return out;
}