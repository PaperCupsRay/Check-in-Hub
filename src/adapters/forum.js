/**
 * 社区站适配器的共用工具（Cookie 归一化 / 响应读取 / Cloudflare 挑战识别 …）。
 *
 * 三站机制各不相同，所以只有这些底层零件共用：
 *  - nodeseek：POST /api/attendance?random=true（Express，JSON 信封）
 *  - linuxsb ：打开页面即自动签到（读 window.__pageFlash）；抽称号走表单 POST /gacha_pull
 *  - nodeloc ：Discourse 插件 POST /checkin（form-urlencoded）
 *
 * 下面的「已签到 / 未登录」词表是照 2026-09-30 实测 + 用户 HAR 里真实响应写的，
 * 别为了「看起来更通用」随意放宽：放宽了会把**没签到**误报成已签到，用户就不会补签。
 */

export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

export function responseTextHint(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data.raw === "string") return data.raw;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/** Cloudflare 托管挑战页：HTML + 403/503/429。认出来才不会当成业务失败。 */
export function looksLikeCfChallenge(data, status) {
  const raw = responseTextHint(data);
  if (
    /just a moment|cf-browser-verification|attention required|cdn-cgi\/challenge|challenge-platform|cf_chl_|enable javascript and cookies/i.test(
      raw
    )
  ) {
    return true;
  }
  return /<!doctype html|<html[\s>]/i.test(raw) && (status === 403 || status === 429 || status === 503);
}

export function parseSetCookie(res) {
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

export function mergeCookie(existing, setPairs) {
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

/** 归一化从 DevTools / 插件复制来的 Cookie（同名逻辑见 newapi.js）。 */
export function normalizeCookie(input) {
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

export function pickCookie(channel) {
  const auth = channel.auth || {};
  return normalizeCookie(auth.cookie || auth.session || "");
}

/**
 * 读一个响应：既能当 JSON 也能当 HTML（linux.sb 的签到/抽称号都在 HTML 里）。
 * `location` 用于读 302 的 Location（抽称号 POST 后的结果地址）。
 */
export async function readResponse(res) {
  const text = await res.text();
  let data = null;
  let parsed = false;
  try {
    data = text ? JSON.parse(text) : null;
    parsed = true;
  } catch {
    data = { raw: text };
  }
  return {
    status: res.status,
    ok: res.ok,
    parsed,
    data,
    text,
    location: res.headers.get("location"),
    headers: res.headers,
    setCookies: parseSetCookie(res),
  };
}

export function messageOf(data) {
  if (!data || typeof data !== "object") return "";
  return String(data.message || data.msg || data.error || "").trim();
}

/** 已签到判定。词表收窄：裸「重复」会命中「请勿重复提交」这类限流措辞。 */
export const ALREADY_RE = /已经?签到|已签过|重复签到|重复领取|重复打卡|already/i;

/**
 * 未登录判定。NodeSeek 未登录回 403「high risk action」、linux.sb 页面退回未登录版，
 * 字面上都看不出是会话问题，这里归一化成同一个提示，否则用户会去查错方向。
 */
export const AUTH_FAIL_RE =
  /high risk action|请求已过期|会话已过期|请先登录|未登录|登录已过期|unauthorized|forbidden|请登录|cookie|登录已失效/i;