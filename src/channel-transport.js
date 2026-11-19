/** Shared channel networking policy. A fixed proxy must never silently become direct. */
const TRANSPORT = Symbol("channel-request-transport");
const BROWSER_TYPES = new Set(["sub2api", "newapi", "nodeseek", "linuxsb"]);
export const fixedProxyUrl = (channel) => String(channel?.options?.proxyUrl || "").trim();
export const hasFixedProxy = (channel) => !!fixedProxyUrl(channel);
export function channelRunner(channel) {
  const configured = channel?.options?.runner;
  if (hasFixedProxy(channel)) return configured === "gha_browser" && BROWSER_TYPES.has(channel.type) ? "gha_browser" : "gha_api";
  return ["worker", "gha_api", "gha_browser"].includes(configured) ? configured : "worker";
}
export function withChannelTransport(channel, transport) {
  // Enumerable symbol is retained by adapters' {...channel} credential-refresh clones,
  // but is never serialized into stored configuration or dispatch payloads.
  return { ...channel, [TRANSPORT]: transport };
}
export function channelFetch(channel, url, init) {
  if (typeof channel?.[TRANSPORT] === "function") return channel[TRANSPORT](url, init);
  if (hasFixedProxy(channel)) throw new Error("固定代理必须通过 GitHub Actions 执行；已阻止直连，请检查 GitHub 集成配置");
  return fetch(url, init);
}
export function requireChannelTransport(channel) {
  if (hasFixedProxy(channel) && typeof channel?.[TRANSPORT] !== "function") {
    throw new Error("固定代理必须通过 GitHub Actions 执行；已阻止直连，请检查 GitHub 集成配置");
  }
}
