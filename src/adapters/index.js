import { sub2apiAdapter } from "./sub2api.js";
import { newapiAdapter } from "./newapi.js";
import { agentrouterAdapter } from "./agentrouter.js";
import { anyrouterAdapter } from "./anyrouter.js";
import { nodeseekAdapter } from "./nodeseek.js";
import { linuxsbAdapter } from "./linuxsb.js";
import { nodelocAdapter } from "./nodeloc.js";
import { onyxaxisAdapter } from "./onyxaxis.js";

export const adapters = {
  sub2api: sub2apiAdapter,
  newapi: newapiAdapter,
  agentrouter: agentrouterAdapter,
  anyrouter: anyrouterAdapter,
  // 社区论坛三站（Cookie 鉴权）
  nodeseek: nodeseekAdapter, // POST /api/attendance?random=true
  linuxsb: linuxsbAdapter, // 打开页面即自动签到；另有「抽称号」动作
  nodeloc: nodelocAdapter, // Discourse + discourse-checkin：POST /checkin
  onyxaxis: onyxaxisAdapter, // Obsidian Arc（Axis AI）：会话 Cookie 或账密登录
};

export function listAdapters() {
  return Object.values(adapters).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    fields: a.fields,
    // 适配器自报的额外动作（目前只有 linux.sb 的「抽称号」）：面板按它在卡片上
    // 渲染按钮，src/ui.html 的 actionLabel / extraButtons 据此工作。
    actions: a.actions || [],
  }));
}

export function getAdapter(type) {
  const a = adapters[type];
  if (!a) {
    const err = new Error(`未知渠道类型: ${type}`);
    err.status = 400;
    throw err;
  }
  return a;
}

/**
 * 执行适配器动作。
 *
 * extra 是本次动作的附加参数（目前只有抽奖的 { count }）：适配器按需读，
 * 不读的适配器忽略即可 —— 这样加参数不用改每个适配器的签名。
 */
export async function runAction(type, action, channel, extra = {}) {
  const adapter = getAdapter(type);
  if (typeof adapter[action] !== "function") {
    const err = new Error(`渠道 ${type} 不支持动作 ${action}`);
    err.status = 400;
    throw err;
  }
  return adapter[action](channel, extra);
}