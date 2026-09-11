/**
 * 代理池：住宅 SOCKS5 出口的存储、校验与连通性测试。
 *
 * 为什么需要它：Cloudflare 对 GitHub Actions 的机房 IP 段**静默不签发 Turnstile
 * 挑战**（组件能渲染，但永远等不到 token —— gorouter / SeekAi / JustDoWork 均已实测）。
 * 换成住宅 IP 出口后同一套流程 27 秒就拿到了 token（2026-09-11 实测，len 794）。
 * 所以浏览器通道要能挂 SOCKS5 代理，代理池就存在 KV 里供 GHA 运行时挑选。
 *
 * 关键约束（实测得出，不要想当然）：
 *  1. **Chromium 不支持 SOCKS5 用户名密码认证**。带 `user:pass@` 时 Chromium 直接报
 *     ERR_SOCKS_CONNECTION_FAILED，而同一代理用 curl 带认证是通的。所以传给浏览器
 *     的 URL 必须剥掉凭证；剥掉后能用的前提是该代理本身允许免认证（很多公开
 *     SOCKS5 的 user:pass 只是摆设，实测这批 184.178.172.* 就是）。
 *  2. Worker 的 `fetch()` 不能走 SOCKS5，测连通性只能用 `cloudflare:sockets` 的
 *     TCP socket 自己拼 SOCKS5 握手。
 *  3. Worker 出口 ≠ GHA 出口，此处测通不代表 GHA 能用（反之亦然），所以测试结果
 *     只作参考，真正的挑选在 GHA 运行时做。
 */

/** SOCKS5 握手用的常量 */
const SOCKS5_VER = 0x05;
const METHOD_NO_AUTH = 0x00;
const METHOD_USERPASS = 0x02;
const CMD_CONNECT = 0x01;
const ATYP_DOMAIN = 0x03;

/**
 * 解析代理 URL。
 * 接受 `socks5://user:pass@host:port#备注` 形式（`socks5h://` 同义），
 * 也接受省略 scheme 的 `host:port`。返回 null 表示格式不合法。
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
  if (!/^socks5h?:\/\//i.test(s)) {
    if (/^(https?|socks4):\/\//i.test(s)) return null; // 明确不支持的协议
    s = `socks5://${s}`;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname;
  const port = Number(u.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host,
    port,
    username: u.username ? decodeURIComponent(u.username) : "",
    password: u.password ? decodeURIComponent(u.password) : "",
    note,
  };
}

/** 规范化成存储形态；无凭证时不留空字段 */
export function normalizeProxy(input = {}) {
  const raw = typeof input === "string" ? input : input.url || "";
  const parsed = parseProxyUrl(raw);
  if (!parsed) return null;
  const cred = parsed.username
    ? `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password)}@`
    : "";
  return {
    url: `socks5://${cred}${parsed.host}:${parsed.port}`,
    note: (typeof input === "object" && input.note) || parsed.note || "",
    enabled: typeof input === "object" && input.enabled === false ? false : true,
    lastCheck: (typeof input === "object" && input.lastCheck) || null,
  };
}

/**
 * 给浏览器用的 URL：**必须剥掉凭证**。
 * Chromium 不支持 SOCKS5 的用户名密码认证，带上就是 ERR_SOCKS_CONNECTION_FAILED。
 */
export function proxyUrlForBrowser(url) {
  const p = parseProxyUrl(url);
  return p ? `socks5://${p.host}:${p.port}` : null;
}

/** 面板展示用：把密码打码，IP/端口保留（否则没法辨认是哪条） */
export function maskProxyUrl(url) {
  const p = parseProxyUrl(url);
  if (!p) return String(url || "").slice(0, 60);
  if (!p.username) return `socks5://${p.host}:${p.port}`;
  return `socks5://${p.username}:***@${p.host}:${p.port}`;
}

/**
 * 把底层报错翻译成能指导下一步的说明。
 *
 * Workers 的 socket 失败常常只抛「Stream was cancelled.」或
 * 「connection failed」这类内部措辞（实测拿一个不存在的 IP 就是前者），
 * 直接显示在面板上等于没信息——用户看不出是代理挂了还是自己填错了。
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

/**
 * 通过 SOCKS5 代理建连到 target，验证握手是否成功。
 *
 * 只做到 CONNECT 被 granted 为止——这已足以证明「代理活着且愿意转发到目标」。
 * 不再发 HTTP 请求，避免把 TLS/证书问题混进代理连通性的判断里
 * （本机实测就踩过：curl rc=60 是证书拦截，不是代理不通）。
 *
 * 返回 { ok, ms, error, authUsed }。authUsed 说明代理实际接受的认证方式，
 * "none" 表示免认证 —— 这正是浏览器能用的前提。
 */
export async function testSocks5(url, { targetHost = "api.ipify.org", targetPort = 443, timeoutMs = 12000 } = {}) {
  const p = parseProxyUrl(url);
  if (!p) return { ok: false, error: "代理地址格式不合法", ms: 0 };

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
      socket = connect({ hostname: p.host, port: p.port });
      const writer = socket.writable.getWriter();
      const reader = socket.readable.getReader();

      // 1) 协商认证方式：同时声明支持「免认证」和「用户名密码」
      const methods = p.username ? [METHOD_NO_AUTH, METHOD_USERPASS] : [METHOD_NO_AUTH];
      await writer.write(new Uint8Array([SOCKS5_VER, methods.length, ...methods]));
      const greet = await readAtLeast(reader, 2);
      if (greet.length < 2) throw new Error("代理未响应握手（可能不是 SOCKS5 服务）");
      if (greet[0] !== SOCKS5_VER) throw new Error(`不是 SOCKS5 协议（返回版本 0x${greet[0]?.toString(16)}）`);

      let authUsed = "none";
      if (greet[1] === METHOD_USERPASS) {
        if (!p.username) throw new Error("代理要求用户名密码，但地址里没有提供");
        authUsed = "userpass";
        const uBytes = new TextEncoder().encode(p.username);
        const pBytes = new TextEncoder().encode(p.password);
        await writer.write(
          new Uint8Array([0x01, uBytes.length, ...uBytes, pBytes.length, ...pBytes])
        );
        const authRes = await readAtLeast(reader, 2);
        if (authRes.length < 2 || authRes[1] !== 0x00) throw new Error("用户名密码认证被拒绝");
      } else if (greet[1] === 0xff) {
        throw new Error("代理拒绝了所有认证方式");
      } else if (greet[1] !== METHOD_NO_AUTH) {
        throw new Error(`代理要求不支持的认证方式 0x${greet[1]?.toString(16)}`);
      }

      // 2) CONNECT 到目标（域名形式，让代理侧解析 DNS）
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
    })();

    const authUsed = await Promise.race([run, timer]);
    return {
      ok: true,
      ms: Date.now() - started,
      authUsed,
      // Chromium 用不了带认证的 SOCKS5，这里顺带把结论算出来给面板显示
      browserUsable: authUsed === "none",
    };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: friendlyError(err) };
  } finally {
    try {
      await socket?.close();
    } catch {
      /* ignore */
    }
  }
}
