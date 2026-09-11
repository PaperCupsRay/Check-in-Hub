/**
 * 代理池：出口代理的存储、校验与连通性测试。
 *
 * 为什么需要它：Cloudflare 对 GitHub Actions 的机房 IP 段**静默不签发 Turnstile
 * 挑战**（组件能渲染，但永远等不到 token —— gorouter / SeekAi / JustDoWork 均已实测）。
 * 换成住宅 IP 出口后同一套流程 27 秒就拿到了 token（2026-09-11 实测，len 794/816）。
 * 所以浏览器通道要能挂代理，代理池就存在 KV 里供 GHA 运行时挑选。
 *
 * 支持的协议（Chromium --proxy-server 能认的那几种）：
 *   socks5:// socks5h://   TCP + SOCKS5 握手
 *   socks4:// socks4a://   TCP + SOCKS4a 握手（只有 CONNECT，无认证）
 *   http://                TCP + HTTP CONNECT 隧道
 *   https://               TLS 到代理本身，再 HTTP CONNECT（防止代理口令明文过网）
 *
 * 关键约束（都是实测得出，不要想当然）：
 *  1. **Chromium 不支持 SOCKS5 的用户名密码认证**。带 `user:pass@` 时直接
 *     ERR_SOCKS_CONNECTION_FAILED，而同一代理用 curl 带认证是通的。所以传给浏览器的
 *     socks5 URL 必须剥掉凭证；剥掉后仍能用的前提是该代理允许免认证（很多公开
 *     SOCKS5 的 user:pass 只是摆设，这批 184.178.172.* 实测就是 authUsed=none）。
 *     **HTTP/HTTPS 代理相反**：Chromium 原生支持 Basic 认证，凭证必须保留。
 *  2. Worker 的 `fetch()` 不能走代理，测连通性只能用 `cloudflare:sockets` 的 TCP
 *     socket 自己拼协议握手。
 *  3. Worker 出口 ≠ GHA 出口，此处测通不代表 GHA 能用（反之亦然），所以测试结果
 *     只作参考，真正的挑选在 GHA 运行时做。
 *  4. **握手成功 ≠ 这个代理能安全使用**。2026-09-11 实测这批公开 SOCKS5 全部在做
 *     TLS 中间人（回给客户端的证书 issuer 是 "None, LLC" 而不是目标站真正的
 *     Google Trust Services），能看到明文。凭证经这种代理发出等于直接交给代理方。
 *     Worker 侧没法做证书比对（socket 拿不到 peer 证书链），所以这道闸门放在
 *     GHA 的 browser-checkin.py 里（proxy_is_safe()），用前逐个比对指纹。
 */

/** SOCKS5 握手常量 */
const SOCKS5_VER = 0x05;
const METHOD_NO_AUTH = 0x00;
const METHOD_USERPASS = 0x02;
const CMD_CONNECT = 0x01;
const ATYP_DOMAIN = 0x03;

/** 支持的协议 → 规范化后的 scheme */
const SCHEMES = {
  socks5: "socks5",
  socks5h: "socks5",
  socks4: "socks4",
  socks4a: "socks4",
  http: "http",
  https: "https",
};

/** 各协议的默认端口（省略端口时用） */
const DEFAULT_PORTS = { http: 8080, https: 443, socks5: 1080, socks4: 1080 };

/** 代理类型是否属于 SOCKS 系 */
function isSocks(scheme) {
  return scheme === "socks5" || scheme === "socks4";
}

/**
 * 解析代理 URL。
 * 接受 `<scheme>://user:pass@host:port#备注`，也接受省略 scheme 的 `host:port`
 * （按 socks5 处理，公开代理列表最常见的省略写法）。返回 null 表示格式不合法。
 */
export function parseProxyUrl(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  // 行尾 #备注（代理列表常见格式）
  let note = "";
  const hash = s.indexOf("#");
  if (hash >= 0) {
    note = s.slice(hash + 1).trim();
    s = s.slice(0, hash).trim();
  }
  if (!s) return null;

  const m = s.match(/^([a-z0-9]+):\/\//i);
  if (m) {
    if (!SCHEMES[m[1].toLowerCase()]) return null; // 不支持的协议
  } else {
    s = `socks5://${s}`; // 裸 host:port
  }

  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const scheme = SCHEMES[u.protocol.replace(":", "").toLowerCase()];
  if (!scheme) return null;
  const host = u.hostname;
  if (!host) return null;
  // 主机必须像 IP 或域名：裸单词（"garbage"）多半是粘贴错行，
  // 放进去只会在 GHA 里白等一次超时，不如当场拒掉。
  // IPv6 经 URL 解析后带方括号，单独放行。
  if (!/^\[.+\]$/.test(host) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null;
  const port = u.port ? Number(u.port) : DEFAULT_PORTS[scheme];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // SOCKS4 协议本身没有认证字段，填了凭证也用不上，明确拒绝以免用户误会
  const username = u.username ? decodeURIComponent(u.username) : "";
  const password = u.password ? decodeURIComponent(u.password) : "";
  if (scheme === "socks4" && username) return null;
  return { scheme, host, port, username, password, note };
}

/** 拼回完整 URL（含凭证），用于存储 */
function buildUrl(p) {
  const cred = p.username
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
    : "";
  return `${p.scheme}://${cred}${p.host}:${p.port}`;
}

/** 规范化成存储形态；无凭证时不留空字段 */
export function normalizeProxy(input = {}) {
  const raw = typeof input === "string" ? input : input.url || "";
  const parsed = parseProxyUrl(raw);
  if (!parsed) return null;
  return {
    url: buildUrl(parsed),
    // 存下协议：GHA 侧要据此决定「给浏览器的地址是否保留凭证」，
    // 面板也要据此提示。从 url 现推也行，但存一份省得每处都重新解析。
    scheme: parsed.scheme,
    note: (typeof input === "object" && input.note) || parsed.note || "",
    enabled: typeof input === "object" && input.enabled === false ? false : true,
    lastCheck: (typeof input === "object" && input.lastCheck) || null,
  };
}

/**
 * 给浏览器用的 URL。
 *
 * SOCKS5：**必须剥掉凭证** —— Chromium 不支持 SOCKS5 用户名密码认证，带上就是
 * ERR_SOCKS_CONNECTION_FAILED（本机实测）。
 * HTTP/HTTPS：**必须保留凭证** —— Chromium 原生支持代理 Basic 认证，
 * CloakBrowser 会把 inline 凭证透传给 --proxy-server。
 */
export function proxyUrlForBrowser(url) {
  const p = parseProxyUrl(url);
  if (!p) return null;
  if (isSocks(p.scheme)) return `${p.scheme}://${p.host}:${p.port}`;
  return buildUrl(p);
}

/** 面板展示用：把密码打码，协议/IP/端口保留（否则没法辨认是哪条） */
export function maskProxyUrl(url) {
  const p = parseProxyUrl(url);
  if (!p) return String(url || "").slice(0, 60);
  if (!p.username) return `${p.scheme}://${p.host}:${p.port}`;
  return `${p.scheme}://${p.username}:***@${p.host}:${p.port}`;
}

/** 该代理的凭证能否被 Chromium 使用（决定面板上怎么提示） */
export function browserAuthSupported(scheme) {
  return !isSocks(scheme);
}

/**
 * 把底层报错翻译成能指导下一步的说明。
 *
 * Workers 的 socket 失败常常只抛「Stream was cancelled.」或「connection failed」
 * 这类内部措辞（实测拿一个不存在的 IP 就是前者），直接显示在面板上等于没信息 ——
 * 用户看不出是代理挂了还是自己填错了。
 */
function friendlyError(err) {
  const raw = String(err?.message || err || "").trim();
  if (/^超时/.test(raw)) return `${raw}（代理无响应，可能已失效或被墙）`;
  if (/stream was cancelled|connection (failed|refused|reset)|network|closed/i.test(raw)) {
    return `连不上代理（${raw}）—— 地址/端口不通，或该代理已失效`;
  }
  return raw.slice(0, 160) || "未知错误";
}

async function readAtLeast(reader, want, chunks = []) {
  let have = chunks.reduce((n, c) => n + c.length, 0);
  while (have < want) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value?.length) {
      chunks.push(value);
      have += value.length;
    }
  }
  const out = new Uint8Array(have);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** SOCKS5：协商认证 → CONNECT。返回实际用掉的认证方式。 */
async function socks5Connect(writer, reader, p, targetHost, targetPort) {
  const methods = p.username ? [METHOD_NO_AUTH, METHOD_USERPASS] : [METHOD_NO_AUTH];
  await writer.write(new Uint8Array([SOCKS5_VER, methods.length, ...methods]));
  const greet = await readAtLeast(reader, 2);
  if (greet.length < 2) throw new Error("代理未响应握手（可能不是 SOCKS5 服务）");
  if (greet[0] !== SOCKS5_VER) {
    throw new Error(`不是 SOCKS5 协议（返回版本 0x${greet[0]?.toString(16)}）`);
  }

  let authUsed = "none";
  if (greet[1] === METHOD_USERPASS) {
    if (!p.username) throw new Error("代理要求用户名密码，但地址里没有提供");
    authUsed = "userpass";
    const uBytes = new TextEncoder().encode(p.username);
    const pBytes = new TextEncoder().encode(p.password);
    await writer.write(new Uint8Array([0x01, uBytes.length, ...uBytes, pBytes.length, ...pBytes]));
    const authRes = await readAtLeast(reader, 2);
    if (authRes.length < 2 || authRes[1] !== 0x00) throw new Error("用户名密码认证被拒绝");
  } else if (greet[1] === 0xff) {
    throw new Error("代理拒绝了所有认证方式");
  } else if (greet[1] !== METHOD_NO_AUTH) {
    throw new Error(`代理要求不支持的认证方式 0x${greet[1]?.toString(16)}`);
  }

  const hostBytes = new TextEncoder().encode(targetHost);
  await writer.write(
    new Uint8Array([
      SOCKS5_VER,
      CMD_CONNECT,
      0x00,
      ATYP_DOMAIN,
      hostBytes.length,
      ...hostBytes,
      (targetPort >> 8) & 0xff,
      targetPort & 0xff,
    ])
  );
  const rep = await readAtLeast(reader, 4);
  if (rep.length < 2) throw new Error("代理未响应 CONNECT 请求");
  if (rep[1] !== 0x00) {
    const reasons = {
      0x01: "代理内部错误",
      0x02: "代理规则不允许",
      0x03: "网络不可达",
      0x04: "目标主机不可达",
      0x05: "目标拒绝连接",
      0x06: "TTL 超时",
      0x07: "不支持的命令",
      0x08: "不支持的地址类型",
    };
    throw new Error(reasons[rep[1]] || `CONNECT 被拒绝（code 0x${rep[1]?.toString(16)}）`);
  }
  return authUsed;
}

/**
 * SOCKS4a：CONNECT 到域名。
 * SOCKS4 原生只吃 IPv4，SOCKS4a 用 0.0.0.1 占位再附域名，是通行做法。
 */
async function socks4Connect(writer, reader, targetHost, targetPort) {
  const hostBytes = new TextEncoder().encode(targetHost);
  await writer.write(
    new Uint8Array([
      0x04,
      0x01,
      (targetPort >> 8) & 0xff,
      targetPort & 0xff,
      0x00,
      0x00,
      0x00,
      0x01, // 0.0.0.1 → 走 SOCKS4a 域名模式
      0x00, // 空 userid
      ...hostBytes,
      0x00,
    ])
  );
  const rep = await readAtLeast(reader, 8);
  if (rep.length < 2) throw new Error("代理未响应（可能不是 SOCKS4 服务）");
  if (rep[1] !== 0x5a) {
    const reasons = {
      0x5b: "代理拒绝或连接失败",
      0x5c: "代理无法回连 identd",
      0x5d: "identd 用户不匹配",
    };
    throw new Error(reasons[rep[1]] || `CONNECT 被拒绝（code 0x${rep[1]?.toString(16)}）`);
  }
  return "none"; // SOCKS4 没有认证
}

/** HTTP(S) 代理：CONNECT 隧道。返回是否用了 Basic 认证。 */
async function httpConnect(writer, reader, p, targetHost, targetPort) {
  const lines = [
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
    `Host: ${targetHost}:${targetPort}`,
    "Proxy-Connection: keep-alive",
  ];
  let authUsed = "none";
  if (p.username) {
    authUsed = "basic";
    lines.push(`Proxy-Authorization: Basic ${btoa(`${p.username}:${p.password}`)}`);
  }
  await writer.write(new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`));

  // 读到首行就够判断了；CONNECT 成功是 2xx
  const chunks = [];
  let text = "";
  for (let i = 0; i < 8; i++) {
    const { value, done } = await reader.read();
    if (value?.length) {
      chunks.push(value);
      text = new TextDecoder().decode(
        (() => {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            out.set(c, off);
            off += c.length;
          }
          return out;
        })()
      );
    }
    if (text.includes("\r\n") || done) break;
  }
  if (!text) throw new Error("代理未响应 CONNECT（可能不是 HTTP 代理）");
  const status = Number(text.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1] || 0);
  if (!status) throw new Error(`代理返回了非 HTTP 响应：${text.slice(0, 60)}`);
  if (status === 407) {
    throw new Error(p.username ? "代理认证失败（用户名或密码错误）" : "代理要求认证，但未提供用户名密码");
  }
  if (status < 200 || status >= 300) {
    throw new Error(`代理拒绝 CONNECT（HTTP ${status}）`);
  }
  return authUsed;
}

/**
 * 通过代理建连到目标，验证握手是否成功。
 *
 * 只做到隧道建立为止 —— 这已足以证明「代理活着且愿意转发到目标」。
 * 不在这里发 HTTP 请求，免得把 TLS/证书问题混进"代理是否连通"的判断
 * （本机踩过：curl rc=60 是证书问题，不是代理不通）。
 *
 * 返回 { ok, ms, error, scheme, authUsed, browserUsable }。
 * browserUsable：Chromium 能否真的用这条代理 —— socks5 带认证时为 false
 * （Chromium 不支持 SOCKS5 认证），http/https 带认证仍可用。
 */
export async function testProxy(
  url,
  { targetHost = "api.ipify.org", targetPort = 443, timeoutMs = 12000 } = {}
) {
  const p = parseProxyUrl(url);
  if (!p) {
    return {
      ok: false,
      error: "代理地址格式不合法（支持 socks5:// socks4:// http:// https://）",
      ms: 0,
    };
  }

  let connect;
  try {
    ({ connect } = await import("cloudflare:sockets"));
  } catch {
    return { ok: false, error: "当前运行环境不支持 TCP socket（需 Cloudflare Workers）", ms: 0 };
  }

  const started = Date.now();
  let socket;
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)
  );

  try {
    const run = (async () => {
      // https 代理：到代理本身这一跳就要 TLS，否则 Proxy-Authorization 明文过网
      socket = connect(
        { hostname: p.host, port: p.port },
        p.scheme === "https" ? { secureTransport: "on" } : {}
      );
      const writer = socket.writable.getWriter();
      const reader = socket.readable.getReader();
      if (p.scheme === "socks5") return socks5Connect(writer, reader, p, targetHost, targetPort);
      if (p.scheme === "socks4") return socks4Connect(writer, reader, targetHost, targetPort);
      return httpConnect(writer, reader, p, targetHost, targetPort);
    })();

    const authUsed = await Promise.race([run, timer]);
    return {
      ok: true,
      ms: Date.now() - started,
      scheme: p.scheme,
      authUsed,
      // Chromium 用不了带认证的 SOCKS5；http/https 的 Basic 认证它认
      browserUsable: isSocks(p.scheme) ? authUsed === "none" : true,
    };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, scheme: p.scheme, error: friendlyError(err) };
  } finally {
    try {
      await socket?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 兼容旧调用名 */
export const testSocks5 = testProxy;
