/**
 * Telegram Bot Webhook / 指令 / inline 按钮。
 *
 * 入口（index.js 注册路由）：
 *   POST /api/tg/webhook  —— 免面板登录，但强制 secret 校验，fail closed
 *   POST /api/tg/setup    —— 面板登录后注册 webhook + 命令
 *   GET  /api/tg/status   —— 面板登录后查看配置状态
 *
 * 安全模型（fail closed）：
 *   - TG_BOT_TOKEN / TG_CHAT_ID / TG_WEBHOOK_SECRET 缺一即 503；
 *   - 本应用要求 secret 为 16..256 个 A-Za-z0-9_-；
 *   - X-Telegram-Bot-Api-Secret-Token 用 auth.js 的 timingSafeEqual 比较；
 *   - 只处理配置的 TG_CHAT_ID 对应的聊天；其他聊天回 200 ignored；
 *   - 群聊（chat.id < 0）在未配 TG_ALLOWED_USER_ID 时一律拒绝；
 *   - 不处理 edited_message / channel_post；
 *   - callback 与 message 走同一套聊天/用户校验；
 *   - callback 先 answerCallbackQuery 消除转圈，再执行动作；
 *   - update_id 去重（KV，24h TTL）防 Telegram 重投导致重复签到。
 *
 * 一致性说明：KV 为最终一致存储，不承诺跨区域并发严格 exactly-once。
 * 签到可能附带抽奖等动作，不应依赖重复请求一定幂等。
 */

import { timingSafeEqual } from "./auth.js";
import { telegramApi, escapeHtml, sendTelegram, redactTelegramText } from "./tg.js";
import { getChannels, getLastRun, getProxies } from "./kv.js";
import { maskProxyUrl } from "./proxy.js";

const TG_WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const MAX_STATUS_CHANNELS = 10;
const MAX_PROXIES_SHOWN = 10;
const BOT_COMMANDS = ["start", "help", "status", "checkin", "proxies", "testproxies"];

function jsonBody(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function validConfiguredId(value, { user = false } = {}) {
  const text = String(value ?? "");
  return (user ? /^[1-9]\d*$/ : /^-?[1-9]\d*$/).test(text) && Number.isSafeInteger(Number(text));
}

async function finishInBackground(ctx, promise) {
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(promise);
  else await promise;
}

function webhookUrlForDisplay(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "（非 HTTPS Webhook，地址已隐藏）";
    return url.origin + (url.pathname === "/api/tg/webhook" ? url.pathname : "/[已隐藏旧路径]");
  } catch {
    return raw ? "（无效 Webhook 地址）" : "";
  }
}

/** 缺失/非法配置变量名列表（fail closed 的唯一事实来源） */
function configProblems(env) {
  const missing = [];
  const secret = env.TG_WEBHOOK_SECRET;
  if (!env.TG_BOT_TOKEN) missing.push("TG_BOT_TOKEN");
  if (!env.TG_CHAT_ID) missing.push("TG_CHAT_ID");
  else if (!validConfiguredId(env.TG_CHAT_ID)) missing.push("TG_CHAT_ID(必须为非零数值ID)");
  if (env.TG_ALLOWED_USER_ID != null && env.TG_ALLOWED_USER_ID !== "" && !validConfiguredId(env.TG_ALLOWED_USER_ID, { user: true })) {
    missing.push("TG_ALLOWED_USER_ID(必须为正整数用户ID)");
  }
  if (!secret) missing.push("TG_WEBHOOK_SECRET");
  else if (!TG_WEBHOOK_SECRET_RE.test(String(secret))) {
    missing.push("TG_WEBHOOK_SECRET(格式非法：需16..256位 A-Za-z0-9_-)");
  }
  return missing;
}

/**
 * setup：用 request.url 的 https origin 注册 webhook（带 secret_token，
 * allowed_updates 限定 message/callback_query，不 drop_pending_updates），
 * 并注册命令菜单。返回 POJO { ok, message?/error? }。
 */
export async function setupTelegramWebhook(request, env) {
  try {
    const missing = configProblems(env);
    if (!env.CHECKIN_KV) missing.push("CHECKIN_KV");
    if (Number(env.TG_CHAT_ID) < 0 && !env.TG_ALLOWED_USER_ID) missing.push("TG_ALLOWED_USER_ID(群聊必填)");
    if (missing.length) {
      return { ok: false, error: `缺少或非法配置：${missing.join("、")}` };
    }
    const origin = new URL(request.url).origin;
    if (!origin.startsWith("https://")) {
      const proto = origin.startsWith("http://") ? "http" : "未知协议";
      return { ok: false, error: `webhook origin 必须是 https（当前 ${proto}）` };
    }
    const webhookUrl = `${origin}/api/tg/webhook`;
    const r1 = await telegramApi(env, "setWebhook", {
      url: webhookUrl,
      secret_token: String(env.TG_WEBHOOK_SECRET),
      allowed_updates: ["message", "callback_query"],
    });
    if (!r1.ok) return { ok: false, error: r1.error || "setWebhook 失败" };
    const commands = [
      { command: "start", description: "开始 / 菜单" },
      { command: "help", description: "查看可用指令" },
      { command: "status", description: "查看最近签到与渠道概况" },
      { command: "checkin", description: "立即签到全部启用渠道" },
      { command: "proxies", description: "查看代理池概况" },
      { command: "testproxies", description: "提交一次代理连通性测试" },
    ];
    const r2 = await telegramApi(env, "setMyCommands", { commands });
    if (!r2.ok) return { ok: false, error: `Webhook 已注册，但命令菜单设置失败：${r2.error || "setMyCommands 失败"}；可重试注册` };
    return { ok: true, message: `已注册 webhook（${webhookUrl}）并设置命令菜单` };
  } catch (e) {
    return { ok: false, error: `setup 失败：${redactTelegramText(e?.message || e, env)}` };
  }
}

/**
 * status：配置布尔值 + 缺失变量名 + getWebhookInfo 安全概况
 * 旧地址只展示 origin，已知回调路径可保留；剥离用户信息、查询串与片段。
 */
export async function getTelegramStatus(env) {
  const missing = configProblems(env);
  const info = {
    tg_bot_token: !!env.TG_BOT_TOKEN,
    tg_chat_id: !!env.TG_CHAT_ID,
    tg_webhook_secret: !!env.TG_WEBHOOK_SECRET,
    tg_allowed_user_id: !!env.TG_ALLOWED_USER_ID,
    missing,
  };
  if (missing.length) {
    return { ok: false, config: info, error: `缺少或非法配置：${missing.join("、")}` };
  }
  const r = await telegramApi(env, "getWebhookInfo", {});
  if (!r.ok) return { ok: false, config: info, error: r.error || "getWebhookInfo 失败" };
  const d = r.data?.result || {};
  return {
    ok: true,
    config: info,
    webhook: {
      url: redactTelegramText(webhookUrlForDisplay(d.url || ""), env, { stripUrls: false }),
      pending_update_count: d.pending_update_count ?? 0,
      last_error_message: redactTelegramText(d.last_error_message || "", env),
      last_error_date: d.last_error_date || null,
      ip_address: d.ip_address || "",
    },
  };
}

/** update_id 必须是非负安全整数，否则放弃处理（fail closed） */
function validUpdateId(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * KV 去重：同一 update_id 只执行一次（24h 过期）。
 * 注意：先鉴权（secret/chat/user），通过后才走到这里。
 * KV 未绑定直接拒绝（503），避免重复派发账号操作。
 */
async function markIfNew(env, updateId) {
  if (!env.CHECKIN_KV) return { ok: false, error: "CHECKIN_KV 未绑定，无法去重，拒绝处理" };
  const key = `tg_update_${updateId}`;
  try {
    const seen = await env.CHECKIN_KV.get(key);
    if (seen) return { ok: false, duplicate: true };
    await env.CHECKIN_KV.put(key, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
    return { ok: true };
  } catch {
    return { ok: false, error: "CHECKIN_KV 去重读写失败，拒绝执行，请稍后重试" };
  }
}

/** 从 message/callback 里抽出待校验的 actor；其他类型一律 null（不处理） */
function extractActor(update) {
  if (update.message && typeof update.message === "object") {
    const m = update.message;
    return {
      kind: "message",
      chatId: m.chat?.id,
      fromId: m.from?.id,
      text: typeof m.text === "string" ? m.text : "",
    };
  }
  if (update.callback_query && typeof update.callback_query === "object") {
    const cb = update.callback_query;
    return {
      kind: "callback",
      chatId: cb.message?.chat?.id,
      fromId: cb.from?.id,
      data: typeof cb.data === "string" ? cb.data : "",
      callbackId: cb.id,
    };
  }
  return null;
}

function makeMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📋 状态", callback_data: "cmd:status" },
        { text: "🌐 代理", callback_data: "cmd:proxies" },
      ],
      [
        { text: "✅ 签到", callback_data: "cmd:checkin" },
        { text: "🧪 测代理", callback_data: "cmd:testproxies" },
      ],
    ],
  };
}

/**
 * Webhook 主入口。
 * actions: { checkin: async () => ..., testProxies: async () => ... }
 */
export async function handleTelegramWebhook(request, env, ctx, actions) {
  // ── 1. fail-closed 配置门 ──
  const missing = configProblems(env);
  if (missing.length) {
    return jsonBody({ ok: false, error: `TG bot 未配置或配置非法：${missing.join("、")}` }, 503);
  }

  // ── 2. secret 校验（timingSafeEqual，来自 auth.js）──
  const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!got || !timingSafeEqual(got, String(env.TG_WEBHOOK_SECRET))) {
    return jsonBody({ ok: false, error: "invalid secret" }, 403);
  }

  // ── 3. JSON / 结构 / update_id 检查 ──
  let update = null;
  try {
    update = JSON.parse(await request.text());
  } catch {
    return jsonBody({ ok: false, error: "invalid json" }, 400);
  }
  if (!update || typeof update !== "object" || Array.isArray(update) || !validUpdateId(update.update_id)) {
    return jsonBody({ ok: false, error: "invalid update" }, 400);
  }

  // ── 4. 只认配置的 chat；其他聊天 200 ignored，不产生任何 API 调用/动作 ──
  const actor = extractActor(update);
  if (!actor) return jsonBody({ ok: true, result: "ignored: unsupported update type" });
  const chatId = Number(env.TG_CHAT_ID);
  if (!Number.isSafeInteger(actor.fromId) || actor.fromId <= 0) {
    return jsonBody({ ok: true, result: "ignored: invalid sender" });
  }
  if (actor.kind === "callback" && (typeof actor.callbackId !== "string" || !actor.callbackId || actor.callbackId.length > 256)) {
    return jsonBody({ ok: false, error: "invalid callback id" }, 400);
  }
  if (actor.chatId !== chatId) {
    return jsonBody({ ok: true, result: "ignored: wrong chat" });
  }

  // ── 5. 用户白名单（群聊无白名单时默认拒绝）──
  const allowedRaw = env.TG_ALLOWED_USER_ID;
  const allowedUser = allowedRaw ? Number(allowedRaw) : null;
  const allowedSet = Number.isSafeInteger(allowedUser);
  if (allowedSet && actor.fromId !== allowedUser) {
    return jsonBody({ ok: true, result: "ignored: user not allowed" });
  }
  if (!allowedSet && actor.chatId < 0) {
    // 群聊没配 TG_ALLOWED_USER_ID：任何群成员都能触发账号操作，默认拒绝
    if (actor.kind === "callback") {
      await finishInBackground(ctx, telegramApi(env, "answerCallbackQuery", {
        callback_query_id: actor.callbackId,
        text: "群聊未配置 TG_ALLOWED_USER_ID，已忽略",
      }));
    }
    return jsonBody({ ok: true, result: "ignored: group chat without TG_ALLOWED_USER_ID" });
  }

  // ── 6. 完整命令匹配；普通文本或未知按钮不写去重键、不执行动作 ──
  const match = actor.kind === "callback"
    ? actor.data.match(/^cmd:([a-z]+)$/)
    : actor.text.match(/^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/);
  const command = match && BOT_COMMANDS.includes(match[1]) ? match[1] : null;
  const answer = () => telegramApi(env, "answerCallbackQuery", { callback_query_id: actor.callbackId });
  if (!command) {
    if (actor.kind === "callback") await finishInBackground(ctx, answer());
    return jsonBody({ ok: true, result: "ignored: not a supported command" });
  }

  // ── 7. 先鉴权再去重，已处理的按钮也回执，但不再运行账号动作 ──
  const dedupe = await markIfNew(env, update.update_id);
  if (!dedupe.ok) {
    if (dedupe.duplicate) {
      if (actor.kind === "callback") await finishInBackground(ctx, answer());
      return jsonBody({ ok: true, result: "ignored: duplicate update_id" });
    }
    return jsonBody({ ok: false, error: dedupe.error }, 503);
  }

  // ── 8. 异步执行，快速 200；失败收敛，不泄漏秘密 ──
  const run = async () => {
    try {
      if (actor.kind === "callback") await answer();
      await dispatchCommand(env, command, actions);
    } catch (e) {
      const msg = redactTelegramText(e?.message || e, env).slice(0, 200);
      try {
        await sendTelegram(env, `⚠️ 指令处理失败：${escapeHtml(msg)}`);
      } catch (e2) {
        console.error("tg webhook async notification failed");
      }
    }
  };
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run());
    return jsonBody({ ok: true });
  }
  await run();
  return jsonBody({ ok: true });
}

// ─────────────────────────── 命令实现 ───────────────────────────

async function dispatchCommand(env, command, actions = {}) {
  switch (command) {
    case "start":
    case "help":
      await sendTelegram(env, helpText(), { reply_markup: makeMainKeyboard() });
      return;

    case "status": {
      const text = await buildStatusText(env);
      await sendTelegram(env, text);
      return;
    }

    case "proxies": {
      const text = await buildProxiesText(env);
      await sendTelegram(env, text);
      return;
    }

    case "checkin": {
      if (typeof actions.checkin !== "function") {
        await sendTelegram(env, "⚠️ 签到功能未注入（actions.checkin 缺失）");
        return;
      }
      await sendTelegram(env, "⏳ 开始处理：正在签到全部启用渠道，完成后推送报告…");
      let r;
      try {
        r = await actions.checkin();
      } catch (e) {
        await sendTelegram(env, `❌ 签到失败：${escapeHtml(redactTelegramText(e?.message || e, env).slice(0, 200))}`);
        return;
      }
      if (r?.ok === false) {
        await sendTelegram(env, `❌ 签到失败：${escapeHtml(redactTelegramText(r.message || r.error || "未知错误", env).slice(0, 200))}`);
        return;
      }
      // 成功时不重复发报告：由签到流程自行推送，避免重复
      return;
    }

    case "testproxies": {
      if (typeof actions.testProxies !== "function") {
        await sendTelegram(env, "⚠️ 代理测试未注入（actions.testProxies 缺失）");
        return;
      }
      await sendTelegram(env, "⏳ 开始处理：正在提交代理连通性测试…");
      let r;
      try {
        r = await actions.testProxies();
      } catch (e) {
        await sendTelegram(env, `❌ 代理测试提交失败：${escapeHtml(redactTelegramText(e?.message || e, env).slice(0, 200))}`);
        return;
      }
      if (!r?.ok || !r.job) {
        await sendTelegram(env, `❌ 代理测试提交失败：${escapeHtml(redactTelegramText(r?.message || r?.error || "未返回检测任务", env).slice(0, 200))}`);
        return;
      }
      const cnt = r?.job?.count;
      await sendTelegram(env, `✅ 已提交代理测试${cnt != null ? `（${cnt} 条）` : ""}，结果稍后推送`);
      return;
    }

    default:
      return;
  }
}

function helpText() {
  return [
    "<b>Check-in Hub Telegram Bot</b>",
    "",
    "/status — 最近签到与渠道概况",
    "/checkin — 立即签到全部启用渠道",
    "/proxies — 代理池概况",
    "/testproxies — 提交一次代理连通性测试",
    "",
    "仅限配置的聊天使用；群聊需配置 TG_ALLOWED_USER_ID。",
  ].join("\n");
}

async function buildStatusText(env) {
  const lines = ["<b>📊 最近签到状态</b>", ""];
  let enabledCount = 0;
  let channels = [];
  try {
    channels = await getChannels(env);
    enabledCount = channels.filter((c) => c && c.enabled !== false).length;
  } catch (e) {
    lines.push("⚠️ 渠道读取失败，请检查 KV 状态");
  }
  let lastRun = null;
  try {
    lastRun = await getLastRun(env);
  } catch {
    lastRun = null;
  }
  if (lastRun?.at) {
    lines.push(`最近签到：${escapeHtml(String(lastRun.at))}`);
    if (lastRun.runner) lines.push(`执行来源：${escapeHtml(String(lastRun.runner))}`);
    const results = Array.isArray(lastRun.results) ? lastRun.results.filter((r) => r && typeof r === "object") : [];
    const okCount = results.filter((r) => r && r.ok).length;
    lines.push(`结果：成功 ${okCount}/${results.length}`);
    const shown = results.slice(0, MAX_STATUS_CHANNELS);
    for (const r of shown) {
      const msg = escapeHtml(redactTelegramText(r.message || (r.ok ? "ok" : "failed"), env).slice(0, 90));
      lines.push(`${r.ok ? "✅" : "❌"} <b>${escapeHtml(String(r.name))}</b>：${msg}`);
    }
    if (results.length > shown.length) lines.push(`…另有 ${results.length - shown.length} 条未展示`);
  } else {
    lines.push("尚未执行过签到");
  }
  lines.push("", `启用渠道：${enabledCount} 个`);
  return lines.join("\n");
}

async function buildProxiesText(env) {
  const lines = ["<b>🌐 代理池概况</b>", ""];
  let proxies = [];
  try {
    proxies = await getProxies(env);
  } catch (e) {
    lines.push("⚠️ 代理读取失败，请检查 KV 状态");
    return lines.join("\n");
  }
  if (!proxies.length) {
    lines.push("代理池为空");
    return lines.join("\n");
  }
  const enabled = proxies.filter((p) => p && p.enabled !== false);
  lines.push(`共 ${proxies.length} 条，启用 ${enabled.length} 条`);
  const shown = enabled.slice(0, MAX_PROXIES_SHOWN);
  for (const p of shown) {
    // maskProxyUrl 打码凭证；再过一遍 HTML escape
    let line = `${p.lastCheck?.ok === true ? "✅" : p.lastCheck?.ok === false ? "❌" : "❔"} ${escapeHtml(maskProxyUrl(p.url))}`;
    const last = p.lastCheck;
    if (last) {
      const date = last.at ? new Date(last.at) : null;
      const when = date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace("T", " ") : "";
      const ms = typeof last.ms === "number" ? `${last.ms}ms` : "";
      line += ` — ${last.ok ? "通" : "断"}${ms ? ` ${ms}` : ""}${when ? ` @ ${when}` : ""}`;
    }
    lines.push(line);
  }
  if (enabled.length > shown.length) lines.push(`…另有 ${enabled.length - shown.length} 条未展示`);
  return lines.join("\n");
}
