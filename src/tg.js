/**
 * Telegram 通知：签到结果汇总推送到 TG Bot。
 * Token/ChatID 通过 Worker secrets 配置：
 *   npx wrangler secret put TG_BOT_TOKEN
 *   npx wrangler secret put TG_CHAT_ID
 * 未配置时静默跳过，不影响签到流程。
 *
 * 另提供 telegramApi() 供 tg-bot.js（指令/Webhook）复用：
 *   - 统一超时（AbortController，可用 env.TG_API_TIMEOUT_MS 覆盖）；
 *   - 严格判定 HTTP ok 且 data.ok === true；
 *   - 错误一律返回对象、绝不抛出，且消息里不含 token 或请求 URL。
 */

const TG_TEXT_LIMIT = 4096; // Telegram 单条消息上限
const TG_MAX_PARTS = 10; // 超长消息最多拆这么多条，防止失控
const TG_API_TIMEOUT_MS = 15000;

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 对外诊断文本不回显令牌、Webhook secret 或请求 URL。 */
export function redactTelegramText(text, env = {}, { stripUrls = true } = {}) {
  let value = String(text ?? "");
  if (stripUrls) value = value.replace(/https?:\/\/\S+/gi, "[URL已隐藏]");
  for (const key of ["TG_BOT_TOKEN", "TG_WEBHOOK_SECRET", "ACCESS_PASSWORD", "SESSION_SECRET", "CRON_SECRET", "GH_TOKEN"]) {
    const secret = env[key] && String(env[key]);
    if (!secret) continue;
    value = value.split(secret).join("***").split(encodeURIComponent(secret)).join("***");
  }
  return value.slice(0, 1000);
}

/**
 * Telegram Bot API 调用。永不抛出；失败返回 { ok:false, error }，
 * error 已脱敏（不含 token / 完整请求 URL）。
 * 成功要求 res.ok 且 data.ok === true（Telegram 业务层失败也算失败）。
 */
async function telegramApi(env, method, payload = {}) {
  const token = env?.TG_BOT_TOKEN;
  if (!token) return { ok: false, skipped: true, error: "未配置 TG_BOT_TOKEN" };
  const requestedTimeout = Number(env?.TG_API_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, 15000) : TG_API_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok === true) return { ok: true, status: res.status, data };
    const desc = redactTelegramText(data?.description || `HTTP ${res.status}`, env);
    return { ok: false, status: res.status, data: { ok: false }, error: `Telegram API ${method} 失败：${desc}` };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "请求超时" : "网络请求失败";
    return { ok: false, error: `Telegram API ${method} 请求失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 超长消息改发纯文本，避免把 HTML 标签、实体或 emoji 从中间切断。 */
function plainText(html) {
  return html.replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function splitMessage(text, limit = TG_TEXT_LIMIT, maxParts = TG_MAX_PARTS) {
  const chunks = [];
  let current = "";
  // 按 code point 遍历；长度按 UTF-16 保守计算，保证每条不超过 API 上限。
  for (const character of text) {
    if (current.length + character.length > limit) {
      chunks.push(current);
      current = "";
      if (chunks.length === maxParts) {
        const tail = "\n…（消息过长已截断）";
        let last = chunks[maxParts - 1];
        while (last.length + tail.length > limit) last = Array.from(last).slice(0, -1).join("");
        chunks[maxParts - 1] = last + tail;
        return chunks;
      }
    }
    current += character;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

/**
 * 发送文本消息。options.reply_markup 可带 inline keyboard（发给第一条）。
 * 短消息保留 HTML，超长消息转纯文本分条发送；返回最后一条结果（兼容旧形状）。
 */
async function sendTelegram(env, text, options = {}) {
  const token = env?.TG_BOT_TOKEN;
  const chatId = env?.TG_CHAT_ID;
  if (!token || !chatId) return { ok: false, skipped: true, reason: "未配置 TG_BOT_TOKEN / TG_CHAT_ID" };
  const message = String(text ?? "");
  const asPlainText = message.length > TG_TEXT_LIMIT;
  const chunks = splitMessage(asPlainText ? plainText(message) : message);
  let last = { ok: false, error: "空消息" };
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      chat_id: chatId,
      text: chunks[i],
      ...(asPlainText ? {} : { parse_mode: "HTML" }),
      disable_web_page_preview: true,
    };
    if (i === 0 && options?.reply_markup) payload.reply_markup = options.reply_markup;
    last = await telegramApi(env, "sendMessage", payload);
    if (!last.ok) {
      return { ok: false, status: last.status, data: last.data, error: last.error, parts: chunks.length };
    }
  }
  return { ...last, parts: chunks.length };
}

/**
 * 签到报告。
 *
 * results: [{ name, ok, message, lottery? }]
 *   lottery 是抽奖结论（{ ok, skipped, message }），单独占一行 —— 签到文案本身
 *   就常有一长串（奖励/余额/连续天数），把抽奖挤在同一行会被 90 字上限截断，
 *   推送里就看不到抽到啥了。
 */
function formatCheckinReport(title, results, extra = "") {
  const esc = escapeHtml;
  const okCount = results.filter((r) => r.ok).length;
  const lines = [];
  for (const r of results) {
    const msg = esc(String(r.message || (r.ok ? "ok" : "failed")).slice(0, 90));
    lines.push(`${r.ok ? "✅" : "❌"} <b>${esc(r.name)}</b>：${msg}`);
    const lot = r.lottery;
    const lotMsg = String(lot?.message || "").trim();
    if (lotMsg) {
      // 抽奖是签到之外的独立动作：跳过（今日已抽完/额度不够）用 ⏭️，成功 🎰，失败 ⚠️
      const icon = lot.ok === false ? "⚠️" : lot.skipped ? "⏭️" : "🎰";
      lines.push(`${icon} <b>${esc(r.name)}</b> 抽奖：${esc(lotMsg.slice(0, 160))}`);
    }
  }
  return [
    `<b>${esc(title)}</b>`,
    `成功 ${okCount}/${results.length}${extra ? ` · ${esc(extra)}` : ""}`,
    ...lines,
  ].join("\n");
}

export { sendTelegram, formatCheckinReport, telegramApi, escapeHtml };
