import { sub2apiAdapter } from "./sub2api.js";
import { newapiAdapter } from "./newapi.js";
import { agentrouterAdapter } from "./agentrouter.js";

export const adapters = {
  sub2api: sub2apiAdapter,
  newapi: newapiAdapter,
  agentrouter: agentrouterAdapter,
};

export function listAdapters() {
  return Object.values(adapters).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    fields: a.fields,
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

export async function runAction(type, action, channel) {
  const adapter = getAdapter(type);
  if (typeof adapter[action] !== "function") {
    const err = new Error(`渠道 ${type} 不支持动作 ${action}`);
    err.status = 400;
    throw err;
  }
  return adapter[action](channel);
}
