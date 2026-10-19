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

/**
 * 签到报告。
 *
 * results: [{ name, ok, message, lottery? }]
 *   lottery 是抽奖结论（{ ok, skipped, message }），单独占一行 —— 签到文案本身
 *   就常有一长串（奖励/余额/连续天数），把抽奖挤在同一行会被 90 字上限截断，
 *   推送里就看不到抽到啥了。
 */
function formatCheckinReport(title, results, extra = "") {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

export { sendTelegram, formatCheckinReport };
