import { timingSafeEqual } from "./auth.js";
import { telegramApi, escapeHtml, sendTelegram, redactTelegramText } from "./tg.js";
import { getChannels, getLastRun, getProxies } from "./kv.js";
import { maskProxyUrl } from "./proxy.js";

const SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;
const DEDUPE_TTL = 86400;
const ACTION_TTL = 900;
const ACTION_PREFIX = "tg_channel_action_";
const MAX_CHANNELS_PER_PAGE = 8;
const BOT_COMMANDS = new Set(["start", "help", "status", "checkin", "checkinall", "retryfailed", "channels", "actions", "proxies", "testproxies"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function numericId(value, user = false) {
  const text = String(value ?? "");
  return (user ? /^[1-9]\d*$/ : /^-?[1-9]\d*$/).test(text) && Number.isSafeInteger(Number(text));
}

function configProblems(env) {
  const out = [];
  if (!env.TG_BOT_TOKEN) out.push("TG_BOT_TOKEN");
  if (!numericId(env.TG_CHAT_ID)) out.push("TG_CHAT_ID(必须为非零安全整数)");
  if (env.TG_ALLOWED_USER_ID && !numericId(env.TG_ALLOWED_USER_ID, true)) out.push("TG_ALLOWED_USER_ID(必须为正整数)");
  if (!env.TG_WEBHOOK_SECRET) out.push("TG_WEBHOOK_SECRET");
  else if (!SECRET_RE.test(String(env.TG_WEBHOOK_SECRET))) out.push("TG_WEBHOOK_SECRET(格式非法)");
  return out;
}

const MAX_STATUS_CHANNELS = 10;
const MAX_PROXIES_SHOWN = 10;

function publicWebhookUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return "（非 HTTPS Webhook，地址已隐藏）";
    return u.origin + (u.pathname === "/api/tg/webhook" ? u.pathname : "/[已隐藏旧路径]");
  } catch { return raw ? "（无效 Webhook 地址）" : ""; }
}

export async function setupTelegramWebhook(request, env) {
  const missing = configProblems(env);
  if (!env.CHECKIN_KV) missing.push("CHECKIN_KV");
  if (Number(env.TG_CHAT_ID) < 0 && !env.TG_ALLOWED_USER_ID) missing.push("TG_ALLOWED_USER_ID(群聊必填)");
  if (missing.length) return { ok: false, error: `缺少或非法配置：${missing.join("、")}` };
  let origin;
  try { origin = new URL(request.url).origin; } catch { return { ok: false, error: "请求地址无效" }; }
  if (!origin.startsWith("https://")) return { ok: false, error: "webhook origin 必须是 https" };
  const webhookUrl = `${origin}/api/tg/webhook`;
  const hook = await telegramApi(env, "setWebhook", {
    url: webhookUrl,
    secret_token: String(env.TG_WEBHOOK_SECRET),
    allowed_updates: ["message", "callback_query"],
  });
  if (!hook.ok) return { ok: false, error: hook.error || "setWebhook 失败" };
  const commands = [
    { command: "start", description: "开始 / 菜单" },
    { command: "help", description: "查看可用指令" },
    { command: "status", description: "查看最近签到与渠道概况" },
    { command: "checkin", description: "选择签到范围" },
    { command: "checkinall", description: "签到全部启用渠道" },
    { command: "channels", description: "选择单个渠道签到" },
    { command: "actions", description: "查询余额并执行渠道功能" },
    { command: "retryfailed", description: "重试最近失败渠道" },
    { command: "proxies", description: "查看代理池概况" },
    { command: "testproxies", description: "测试启用代理" },
  ];
  const menu = await telegramApi(env, "setMyCommands", { commands });
  if (!menu.ok) return { ok: false, error: `Webhook 已注册，但命令菜单设置失败：${menu.error}；可重试注册` };
  return { ok: true, message: `已注册 webhook（${webhookUrl}）并设置 ${commands.length} 个指令` };
}

export async function getTelegramStatus(env) {
  const missing = configProblems(env);
  const config = {
    tg_bot_token: !!env.TG_BOT_TOKEN,
    tg_chat_id: !!env.TG_CHAT_ID,
    tg_webhook_secret: !!env.TG_WEBHOOK_SECRET,
    tg_allowed_user_id: !!env.TG_ALLOWED_USER_ID,
    missing,
  };
  if (missing.length) return { ok: false, config, error: `缺少或非法配置：${missing.join("、")}` };
  const response = await telegramApi(env, "getWebhookInfo", {});
  if (!response.ok) return { ok: false, config, error: response.error };
  const result = response.data?.result || {};
  return {
    ok: true,
    config,
    webhook: {
      url: redactTelegramText(publicWebhookUrl(result.url || ""), env, { stripUrls: false }),
      pending_update_count: result.pending_update_count ?? 0,
      last_error_message: redactTelegramText(result.last_error_message || "", env),
      last_error_date: result.last_error_date || null,
      ip_address: result.ip_address || "",
    },
  };
}

function getActor(update) {
  if (update.message && typeof update.message === "object") {
    return { kind: "message", messageId: update.message.message_id, chatId: update.message.chat?.id, fromId: update.message.from?.id, text: typeof update.message.text === "string" ? update.message.text : "" };
  }
  if (update.callback_query && typeof update.callback_query === "object") {
    const q = update.callback_query;
    return { kind: "callback", messageId: q.message?.message_id, chatId: q.message?.chat?.id, fromId: q.from?.id, data: typeof q.data === "string" ? q.data : "", callbackId: q.id };
  }
  return null;
}

async function markUpdate(env, id) {
  if (!env.CHECKIN_KV) return { error: "CHECKIN_KV 未绑定，无法安全去重" };
  const key = `tg_update_${id}`;
  try {
    if (await env.CHECKIN_KV.get(key)) return { duplicate: true };
    await env.CHECKIN_KV.put(key, "1", { expirationTtl: DEDUPE_TTL });
    return { ok: true };
  } catch { return { error: "Telegram 去重记录失败，未执行操作" }; }
}

async function putAction(env, value) {
  if (!env.CHECKIN_KV) throw new Error("CHECKIN_KV 未绑定");
  const token = crypto.randomUUID().replace(/-/g, "");
  await env.CHECKIN_KV.put(ACTION_PREFIX + token, JSON.stringify(value), { expirationTtl: ACTION_TTL });
  return token;
}

async function getAction(env, token) {
  if (!/^[a-f0-9]{32}$/.test(token || "")) return null;
  const raw = await env.CHECKIN_KV.get(ACTION_PREFIX + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function takeAction(env, token) {
  const action = await getAction(env, token);
  if (!action) return null;
  await env.CHECKIN_KV.delete(ACTION_PREFIX + token);
  return action;
}

function mainKeyboard() {
  return { inline_keyboard: [
    [{ text: "📋 状态", callback_data: "cmd:status" }, { text: "🌐 代理", callback_data: "cmd:proxies" }],
    [{ text: "✅ 签到选项", callback_data: "cmd:checkin" }, { text: "🔁 重试失败", callback_data: "cmd:retryfailed" }],
    [{ text: "🎯 渠道功能", callback_data: "cmd:actions" }, { text: "🧪 测代理", callback_data: "cmd:testproxies" }],
  ] };
}

function checkinKeyboard() {
  return { inline_keyboard: [
    [{ text: "✅ 所有启用渠道", callback_data: "cmd:checkinall" }],
    [{ text: "🎯 选择单个渠道", callback_data: "cmd:channels" }, { text: "🔁 重试失败渠道", callback_data: "cmd:retryfailed" }],
  ] };
}

async function showChannelPicker(env, requestedPage = 0, actor = {}, mode = "checkin") {
  let channels;
  try { channels = (await getChannels(env)).filter((c) => c && c.enabled !== false); }
  catch { await sendTelegram(env, "⚠️ 读取渠道失败，请检查面板存储。"); return; }
  if (!channels.length) { await sendTelegram(env, "没有启用的签到渠道。"); return; }
  const pages = Math.ceil(channels.length / MAX_CHANNELS_PER_PAGE);
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const selected = channels.slice(page * MAX_CHANNELS_PER_PAGE, (page + 1) * MAX_CHANNELS_PER_PAGE);
  const keyboard = [];
  for (let i = 0; i < selected.length; i += 2) {
    const row = [];
    for (const channel of selected.slice(i, i + 2)) {
      const selection = { id: channel.id || null, name: channel.name, type: channel.type, baseUrl: channel.baseUrl };
      const token = await putAction(env, {
        kind: mode === "actions" ? "action-channel" : "channel",
        selection,
      });
      row.push({ text: String(channel.name || channel.type || "渠道").slice(0, 32), callback_data: `${mode === "actions" ? "ac" : "ch"}:${token}` });
    }
    keyboard.push(row);
  }
  const navigation = [];
  for (const [text, target] of [["← 上一页", page - 1], ["下一页 →", page + 1]]) {
    if (target < 0 || target >= pages) continue;
    const token = await putAction(env, { kind: "page", page: target, mode });
    navigation.push({ text, callback_data: `pg:${token}` });
  }
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([{ text: mode === "actions" ? "↩ 主菜单" : "↩ 签到菜单", callback_data: mode === "actions" ? "cmd:start" : "cmd:checkin" }]);
  const text = `选择一个渠道${mode === "actions" ? "查看或执行功能" : "签到"}（${page + 1}/${pages}）`;
  if (actor?.kind === "callback" && Number.isSafeInteger(actor.messageId) && actor.messageId > 0 && actor.chatId === Number(env.TG_CHAT_ID)) {
    const edited = await telegramApi(env, "editMessageText", {
      chat_id: Number(env.TG_CHAT_ID),
      message_id: actor.messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
    if (edited.ok || /message is not modified/i.test(edited.error || "")) return;
  }
  await sendTelegram(env, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showChannelActions(env, selection, actions, actor = {}) {
  if (typeof actions.getChannelActionOptions !== "function") {
    await sendTelegram(env, "⚠️ 渠道功能暂不可用。");
    return;
  }
  const options = await actions.getChannelActionOptions(selection);
  if (!options?.ok) {
    await sendTelegram(env, `⚠️ ${escapeHtml(redactTelegramText(options?.error || "渠道选择已失效，请重新选择", env))}`);
    return;
  }
  const channel = options.channel || {};
  const operations = [
    { action: "checkin", label: "签到" },
    ...(options.actions || []).filter((item) => item.action !== "lotteryInfo"),
  ];
  const keyboard = [];
  for (let i = 0; i < operations.length; i += 2) {
    const row = [];
    for (const operation of operations.slice(i, i + 2)) {
      const token = await putAction(env, { kind: "channel-operation", selection, action: operation.action });
      row.push({ text: String(operation.label).slice(0, 32), callback_data: `op:${token}` });
    }
    keyboard.push(row);
  }
  const logToken = await putAction(env, { kind: "channel-log", selection });
  keyboard.push([{ text: "📝 最近日志", callback_data: `lg:${logToken}` }]);
  keyboard.push([{ text: "↩ 渠道列表", callback_data: "cmd:actions" }]);
  const text = `<b>${escapeHtml(String(channel.name || channel.type || "渠道").slice(0, 80))}</b>\n签到沿用渠道执行通道；其他功能使用 Worker 直连，可能受站点访问限制。`;
  if (actor?.kind === "callback" && Number.isSafeInteger(actor.messageId) && actor.messageId > 0 && actor.chatId === Number(env.TG_CHAT_ID)) {
    const edited = await telegramApi(env, "editMessageText", {
      chat_id: Number(env.TG_CHAT_ID),
      message_id: actor.messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
    if (edited.ok || /message is not modified/i.test(edited.error || "")) return;
  }
  await sendTelegram(env, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showChannelLog(env, selection, actions) {
  if (typeof actions.getChannelActionOptions !== "function") { await sendTelegram(env, "⚠️ 渠道日志暂不可用。"); return; }
  const options = await actions.getChannelActionOptions(selection);
  if (!options?.ok) { await sendTelegram(env, `⚠️ ${escapeHtml(redactTelegramText(options?.error || "渠道选择已失效，请重新选择", env))}`); return; }
  const result = options.lastResult;
  const detail = result?.summary || "暂无运行结果";
  const at = Number(result?.at);
  const when = Number.isFinite(at) && at > 0 ? `\n时间：${new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : "";
  await sendTelegram(env, `<b>${escapeHtml(String(options.channel?.name || "渠道").slice(0, 80))} · 最近日志</b>\n${escapeHtml(redactTelegramText(detail, env).slice(0, 500))}${when}`);
}

async function showLotteryChoices(env, selection, actions) {
  if (typeof actions.channelAction !== "function") { await sendTelegram(env, "⚠️ 抽奖功能暂不可用。"); return; }
  const info = await actions.channelAction(selection, "lotteryInfo");
  const draw = info?.result || {};
  const maximum = Math.min(5, Math.max(0, Math.floor(Number(draw.maxDraws) || 0)));
  const status = info?.status || {};
  const remaining = Number(status.todayRemaining) || 0;
  const costLabels = { free: "免费额度", activity: "活动分", paid: "余额" };
  const costLabel = costLabels[draw.costType] || "按渠道设置";
  const modeLabels = { free: "仅用免费额度", auto: "免费额度不足时会消耗活动分", all: "免费额度、活动分不足时会消耗余额" };
  const costMode = modeLabels[draw.costMode] || modeLabels.free;
  const amount = Number(draw.costAmount);
  const costText = `${costLabel}${Number.isFinite(amount) ? ` ${amount}/次` : ""}`;
  const summary = escapeHtml(redactTelegramText(info?.message || "抽奖状态已读取", env).slice(0, 180));
  if (!info?.ok || !draw.canDraw || maximum < 1) {
    await sendTelegram(env, `🎰 ${summary}\n今日剩余：${remaining} 次；消耗方式：${costLabel}`);
    return;
  }
  const counts = [1, 3, 5].filter((count) => count <= maximum);
  counts.push(maximum);
  const uniqueCounts = [...new Set(counts)].sort((a, b) => a - b);
  const buttons = [];
  for (let i = 0; i < uniqueCounts.length; i += 2) {
    const row = [];
    for (const count of uniqueCounts.slice(i, i + 2)) {
      const token = await putAction(env, { kind: "channel-operation", selection, action: "lottery", count, costMode: draw.costMode || "free" });
      row.push({ text: `${count} 次`, callback_data: `op:${token}` });
    }
    buttons.push(row);
  }
  buttons.push([{ text: "↩ 渠道功能", callback_data: "cmd:actions" }]);
  await sendTelegram(env, `🎰 ${summary}\n今日剩余：${remaining} 次；当前消耗：${costText}\n${costMode}\n请选择次数（单次最多 5 次）：`, { reply_markup: { inline_keyboard: buttons } });
}

function actionResultText(result, action, env) {
  const parts = [];
  const message = String(result?.message || "").trim();
  if (message && !/^(ok|success|成功)$/i.test(message)) parts.push(message);
  if (result?.ok && ["me", "status"].includes(action)) {
    const numeric = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
    const money = (amount) => `$${amount.toFixed(Math.abs(amount) > 0 && Math.abs(amount) < 0.01 ? 4 : 2)}`;
    const user = result.user || {};
    const status = result.status || {};
    const balance = numeric(user.balance ?? status.balance);
    const quota = numeric(user.quota ?? user.giftQuota ?? user.totalQuota);
    const perUnit = numeric(user.quotaPerUnit) || 500000;
    if (!message.includes("余额")) {
      if (balance != null) parts.push(`余额 ${money(balance)}`);
      else if (quota != null && perUnit > 0) parts.push(`余额 ${money(quota / perUnit)}`);
    }
    const used = numeric(user.usedQuota);
    if (used != null && perUnit > 0 && !message.includes("已用")) parts.push(`已用 ${money(used / perUnit)}`);
    if (action === "status") {
      if (status.enabled === false) parts.push("站点未开启签到");
      if (typeof status.checkedInToday === "boolean" && !message.includes("今日")) parts.push(status.checkedInToday ? "今日已签到" : "今日未签到");
      const streak = numeric(status.currentStreak);
      if (streak != null && !message.includes("连续")) parts.push(`连续 ${streak} 天`);
      const count = numeric(status.totalCheckInDays ?? status.checkinCount);
      if (count != null && !message.includes("累计") && !message.includes("本月")) parts.push(`签到 ${count} 次`);
    }
  }
  return escapeHtml(redactTelegramText(parts.join(" · ") || (result?.ok ? "操作完成" : "操作失败"), env).slice(0, 600));
}

export async function handleTelegramWebhook(request, env, ctx, actions = {}) {
  const missing = configProblems(env);
  if (missing.length) return json({ ok: false, error: `TG bot 未配置或配置非法：${missing.join("、")}` }, 503);
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!supplied || !timingSafeEqual(supplied, String(env.TG_WEBHOOK_SECRET))) return json({ ok: false, error: "invalid secret" }, 403);

  let update;
  try { update = JSON.parse(await request.text()); } catch { return json({ ok: false, error: "invalid json" }, 400); }
  if (!update || typeof update !== "object" || Array.isArray(update) || typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return json({ ok: false, error: "invalid update" }, 400);
  }
  const actor = getActor(update);
  if (!actor) return json({ ok: true, result: "ignored: unsupported update type" });
  if (!Number.isSafeInteger(actor.fromId) || actor.fromId <= 0 || actor.chatId !== Number(env.TG_CHAT_ID)) return json({ ok: true, result: "ignored: unauthorized sender or chat" });
  if (actor.kind === "callback" && (typeof actor.callbackId !== "string" || !actor.callbackId || actor.callbackId.length > 256)) return json({ ok: false, error: "invalid callback id" }, 400);

  const allowedUser = env.TG_ALLOWED_USER_ID ? Number(env.TG_ALLOWED_USER_ID) : null;
  if (allowedUser && actor.fromId !== allowedUser) return json({ ok: true, result: "ignored: user not allowed" });
  if (actor.chatId < 0 && !allowedUser) {
    if (actor.kind === "callback") await telegramApi(env, "answerCallbackQuery", { callback_query_id: actor.callbackId, text: "群聊未配置 TG_ALLOWED_USER_ID，已忽略" });
    return json({ ok: true, result: "ignored: group chat without TG_ALLOWED_USER_ID" });
  }

  let command = null;
  let payload = { actor };
  if (actor.kind === "message") {
    const match = actor.text.match(/^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/);
    if (match && BOT_COMMANDS.has(match[1])) command = match[1];
  } else {
    const commandMatch = actor.data.match(/^cmd:([a-z]+)$/);
    if (commandMatch && BOT_COMMANDS.has(commandMatch[1])) command = commandMatch[1];
    else {
      const channelMatch = actor.data.match(/^ch:([a-f0-9]{32})$/);
      const actionChannelMatch = actor.data.match(/^ac:([a-f0-9]{32})$/);
      const pageMatch = actor.data.match(/^pg:([a-f0-9]{32})$/);
      const operationMatch = actor.data.match(/^op:([a-f0-9]{32})$/);
      const logMatch = actor.data.match(/^lg:([a-f0-9]{32})$/);
      const token = (channelMatch || actionChannelMatch || pageMatch || operationMatch || logMatch)?.[1];
      let stored;
      try { stored = await getAction(env, token); }
      catch { return json({ ok: false, error: "读取渠道按钮失败，未执行操作" }, 503); }
      if (channelMatch && stored?.kind === "channel" && stored.selection) { command = "checkin_channel"; payload.selection = stored.selection; }
      if (actionChannelMatch && stored?.kind === "action-channel" && stored.selection) { command = "action_channel"; payload.selection = stored.selection; }
      if (pageMatch && stored?.kind === "page" && Number.isSafeInteger(stored.page) && stored.page >= 0) {
        command = stored.mode === "actions" ? "action_page" : "checkin_page";
        payload.page = stored.page;
      }
      if (operationMatch && stored?.kind === "channel-operation" && stored.selection && typeof stored.action === "string") {
        command = "channel_operation";
        payload.selection = stored.selection;
        payload.action = stored.action;
        payload.count = stored.count;
        payload.costMode = stored.costMode;
        payload.token = token;
      }
      if (logMatch && stored?.kind === "channel-log" && stored.selection) { command = "channel_log"; payload.selection = stored.selection; }
    }
  }
  if (!command) {
    if (actor.kind === "callback") await telegramApi(env, "answerCallbackQuery", { callback_query_id: actor.callbackId, text: "按钮已过期，请重新打开签到菜单" });
    return json({ ok: true, result: "ignored: unsupported command or expired selection" });
  }

  const dedupe = await markUpdate(env, update.update_id);
  if (!dedupe.ok) {
    if (dedupe.duplicate) {
      if (actor.kind === "callback") await telegramApi(env, "answerCallbackQuery", { callback_query_id: actor.callbackId, text: "此操作已处理" });
      return json({ ok: true, result: "ignored: duplicate update" });
    }
    return json({ ok: false, error: dedupe.error }, 503);
  }

  const run = async () => {
    try {
      if (actor.kind === "callback") await telegramApi(env, "answerCallbackQuery", { callback_query_id: actor.callbackId });
      if (command === "channel_operation" && !await takeAction(env, payload.token)) {
        await sendTelegram(env, "⚠️ 此操作按钮已使用或已过期，请重新打开渠道功能菜单。");
        return;
      }
      await dispatchCommand(env, command, actions, payload);
    } catch (error) {
      await sendTelegram(env, `⚠️ 操作失败：${escapeHtml(redactTelegramText(error?.message || error, env).slice(0, 200))}`);
    }
  };
  if (typeof ctx?.waitUntil === "function") { ctx.waitUntil(run()); return json({ ok: true }); }
  await run();
  return json({ ok: true });
}

async function dispatchCommand(env, command, actions, payload = {}) {
  switch (command) {
    case "start":
    case "help":
      await sendTelegram(env, helpText(), { reply_markup: mainKeyboard() });
      return;
    case "status":
      await sendTelegram(env, await buildStatusText(env));
      return;
    case "proxies":
      await sendTelegram(env, await buildProxiesText(env));
      return;
    case "checkin":
      await sendTelegram(env, "请选择签到范围：", { reply_markup: checkinKeyboard() });
      return;
    case "channels":
      await showChannelPicker(env, 0);
      return;
    case "actions":
      await showChannelPicker(env, 0, {}, "actions");
      return;
    case "checkin_page":
      await showChannelPicker(env, payload.page || 0, payload.actor || {});
      return;
    case "action_page":
      await showChannelPicker(env, payload.page || 0, payload.actor || {}, "actions");
      return;
    case "action_channel":
      await showChannelActions(env, payload.selection, actions, payload.actor || {});
      return;
    case "channel_log":
      await showChannelLog(env, payload.selection, actions);
      return;
    case "channel_operation": {
      const { selection, action } = payload;
      if (!selection || typeof action !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(action)) {
        await sendTelegram(env, "⚠️ 渠道操作已过期或不再支持，请重新选择。");
        return;
      }
      if (action === "checkin") {
        if (typeof actions.checkinChannel !== "function") { await sendTelegram(env, "⚠️ 单渠道签到暂不可用。"); return; }
        await sendTelegram(env, `⏳ 开始签到：<b>${escapeHtml(String(selection.name || "渠道").slice(0, 80))}</b>…`);
        const result = await actions.checkinChannel(selection);
        await sendTelegram(env, `${result?.ok ? "✅" : "❌"} ${escapeHtml(redactTelegramText(result?.message || "签到已完成", env).slice(0, 240))}`);
        return;
      }
      if (action === "lottery") {
        if (payload.count == null) { await showLotteryChoices(env, selection, actions); return; }
        const count = Number(payload.count);
        if (!Number.isSafeInteger(count) || count < 1 || count > 5) { await sendTelegram(env, "⚠️ 抽奖次数无效，请重新选择。"); return; }
        if (typeof actions.channelAction !== "function") { await sendTelegram(env, "⚠️ 抽奖功能暂不可用。"); return; }
        await sendTelegram(env, `⏳ 正在抽奖：<b>${escapeHtml(String(selection.name || "渠道").slice(0, 80))}</b>，${count} 次…`);
        const result = await actions.channelAction(selection, action, { count, costMode: payload.costMode, requestId: payload.token });
        await sendTelegram(env, `${result?.ok ? "✅" : "❌"} ${escapeHtml(redactTelegramText(result?.message || "抽奖完成", env).slice(0, 300))}`);
        return;
      }
      if (typeof actions.channelAction !== "function") { await sendTelegram(env, "⚠️ 渠道功能暂不可用。"); return; }
      await sendTelegram(env, `⏳ 正在执行：<b>${escapeHtml(String(selection.name || "渠道").slice(0, 80))}</b>…`);
      const result = await actions.channelAction(selection, action);
      await sendTelegram(env, `${result?.ok ? "✅" : "❌"} ${actionResultText(result, action, env)}`);
      return;
    }
    case "checkin_channel": {
      if (!payload.selection || typeof actions.checkinChannel !== "function") {
        await sendTelegram(env, "⚠️ 渠道选择已过期或功能暂不可用，请重新选择。");
        return;
      }
      await sendTelegram(env, `⏳ 开始签到：<b>${escapeHtml(String(payload.selection.name || "渠道").slice(0, 80))}</b>…`);
      const result = await actions.checkinChannel(payload.selection);
      await sendTelegram(env, `${result?.ok ? "✅" : "❌"} ${escapeHtml(redactTelegramText(result?.message || "签到已完成", env).slice(0, 180))}`);
      return;
    }
    case "retryfailed": {
      const retry = actions.retryFailed;
      if (typeof retry !== "function") { await sendTelegram(env, "⚠️ 失败渠道重试暂不可用。"); return; }
      await sendTelegram(env, "⏳ 正在重试最近一次失败的已启用渠道…");
      const result = await retry();
      if (result?.ok === false && result.message) await sendTelegram(env, `⚠️ ${escapeHtml(redactTelegramText(result.message, env).slice(0, 180))}`);
      else if (!result?.results?.length) await sendTelegram(env, "✅ 没有最近失败的已启用渠道，无需重试。");
      return;
    }
    case "checkinall": {
      const run = actions.checkinAll;
      if (typeof run !== "function") { await sendTelegram(env, "⚠️ 全渠道签到暂不可用。"); return; }
      await sendTelegram(env, "⏳ 开始签到全部启用渠道，完成后推送报告…");
      const result = await run();
      if (result?.ok === false) await sendTelegram(env, `❌ ${escapeHtml(redactTelegramText(result.message || "签到失败", env).slice(0, 180))}`);
      return;
    }
    case "testproxies": {
      if (typeof actions.testProxies !== "function") { await sendTelegram(env, "⚠️ 代理测试暂不可用。"); return; }
      await sendTelegram(env, "⏳ 正在提交代理检测…");
      const result = await actions.testProxies();
      if (!result?.ok || !result.job) await sendTelegram(env, `❌ ${escapeHtml(redactTelegramText(result?.message || "提交失败", env).slice(0, 180))}`);
      else await sendTelegram(env, `✅ 已提交代理检测（${result.job.count} 条），完成后推送结果`);
      return;
    }
  }
}

function helpText() {
  return [
    "<b>Check-in Hub Telegram Bot</b>",
    "",
    "/checkin — 选择全渠道、单渠道或重试失败渠道",
    "/checkinall — 签到全部启用渠道",
    "/channels — 选择单个渠道签到",
    "/actions — 渠道功能：余额、状态、抽奖/抽称号/领里程碑、日志",
    "/retryfailed — 重试最近失败渠道",
    "/status — 最近签到与渠道概况",
    "/proxies — 代理池概况",
    "/testproxies — 测试启用代理",
    "",
    "渠道功能仅列启用渠道；编辑、删除和导入导出请在面板操作。",
  ].join("\n");
}

async function buildStatusText(env) {
  const lines = ["<b>📊 最近签到状态</b>", ""];
  let channels = [];
  try { channels = await getChannels(env); } catch { lines.push("⚠️ 渠道读取失败，请检查 KV 状态"); }
  const enabled = channels.filter(c => c && c.enabled !== false);
  const lastRun = await getLastRun(env).catch(() => null);
  const lastResults = Array.isArray(lastRun?.results) ? lastRun.results.filter(r => r && typeof r === "object") : [];
  const results = new Map(lastResults.map(r => [r.name, r]));
  let failed = 0;
  for (const channel of enabled) {
    const result = channel.lastResult || results.get(channel.name);
    if (!result) continue;
    const pending = !!(result.pending || result.degraded);
    if (result.ok === false && !pending) failed++;
    lines.push(`${pending ? "⏳" : result.ok ? "✅" : "❌"} <b>${escapeHtml(String(channel.name || "渠道"))}</b>：${escapeHtml(redactTelegramText(result.summary || result.message || (pending ? "等待最终结果" : result.ok ? "ok" : "failed"), env).slice(0, 90))}`);
  }
  lines.splice(1, 0, `最近失败渠道：${failed} 个`);
  if (lastRun?.at) lines.push(`最近执行：${escapeHtml(String(lastRun.at))}`);
  lines.push(`启用渠道：${enabled.length} 个`);
  return lines.join("\n");
}

async function buildProxiesText(env) {
  const lines = ["<b>🌐 代理池概况</b>", ""];
  let proxies = [];
  try { proxies = await getProxies(env); } catch { return `${lines.join("\n")}⚠️ 代理读取失败`; }
  const enabled = proxies.filter(p => p && p.enabled !== false);
  lines.push(`共 ${proxies.length} 条，启用 ${enabled.length} 条`);
  for (const p of enabled.slice(0, MAX_PROXIES_SHOWN)) {
    const mark = p.lastCheck?.ok === true ? "✅" : p.lastCheck?.ok === false ? "❌" : "❔";
    lines.push(`${mark} ${escapeHtml(maskProxyUrl(p.url))}${p.lastCheck?.error ? ` — ${escapeHtml(String(p.lastCheck.error).slice(0, 90))}` : ""}`);
  }
  if (enabled.length > MAX_PROXIES_SHOWN) lines.push(`…另有 ${enabled.length - MAX_PROXIES_SHOWN} 条未展示`);
  return lines.join("\n");
}
