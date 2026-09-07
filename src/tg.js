/**
 * Telegram 通知：签到结果汇总推送到 TG Bot。
 * Token/ChatID 通过 Worker secrets 配置：
 *   npx wrangler secret put TG_BOT_TOKEN
 *   npx wrangler secret put TG_CHAT_ID
 * 未配置时静默跳过，不影响签到流程。
 */

async function sendTelegram(env, text) {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return { ok: false, skipped: true, reason: "未配置 TG_BOT_TOKEN / TG_CHAT_ID" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.ok !== false, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** results: [{ name, ok, message }] */
function formatCheckinReport(title, results, extra = "") {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const okCount = results.filter((r) => r.ok).length;
  const lines = results.map((r) => {
    const msg = esc(String(r.message || (r.ok ? "ok" : "failed")).slice(0, 90));
    return `${r.ok ? "✅" : "❌"} <b>${esc(r.name)}</b>：${msg}`;
  });
  return [
    `<b>${esc(title)}</b>`,
    `成功 ${okCount}/${results.length}${extra ? ` · ${esc(extra)}` : ""}`,
    ...lines,
  ].join("\n");
}

export { sendTelegram, formatCheckinReport };
