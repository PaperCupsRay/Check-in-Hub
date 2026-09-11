"""
浏览器通道：反检测浏览器内完成 Turnstile 解证 + 页面内 fetch 签到。

参照 kppq66/gorouter-turnstile-checkin 的流程，适配多渠道：
  1. 从面板拉取 runner=gha_browser 的启用渠道
  2. 对每个渠道：
     - CloakBrowser (xvfb 有头模式) 打开站点首页
     - 注入渠道 cookie（session 等）
     - 挂载 Cloudflare Turnstile 组件（sitekey 取渠道 options.turnstileSiteKey，
       缺省用 gorouter 的内置 key），拟人点击 checkbox，轮询拿 token（最长 45s）
     - 在页面内 fetch /api/user/checkin?turnstile=<token> 完成签到
       （请求从浏览器发出，TLS/IP/cookie 三者天然一致）
     - 页面内 fetch /api/user/self 取余额
  3. 全部结果回传面板 /api/gh/result（写入 KV + TG 通知）

环境变量：
  HUB_BASE_URL / HUB_SECRET / HUB_ACCESS_PASSWORD   同 Node runner
  CHECKIN_HEADLESS   "true"/"false"（xvfb 下用 false）
"""

import asyncio
import json
import os
import re
import urllib.error
import urllib.request

HUB = (os.environ.get("HUB_BASE_URL") or "").rstrip("/")
PASSWORD = os.environ.get("HUB_ACCESS_PASSWORD") or ""
# 无头模式拿不到 Turnstile token。同一代理、同一 sitekey、组件都 rendered 成功，
# 无头下等满 45s 一个 token 都不出，切成有头（本机窗口 / GHA 的 xvfb）立刻 816 字符
# 到手——2026-09-11 在 JustDoWork 上正反各测一次确认。workflow 里已固定 "false"，
# 不要图省事改回无头，那等于把浏览器通道废掉。
HEADLESS = (os.environ.get("CHECKIN_HEADLESS") or "true") != "false"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
# gorouter 全站默认 sitekey（kppq66 内置值）；其他站用渠道 options.turnstileSiteKey 覆盖
DEFAULT_SITEKEY = "0x4AAAAAAELziOpg1Y2gFtAt"
# UA 必须与 CloakBrowser 内核版本一致（chromium-146）：报更高版本号（如 150）会造成
# UA 与真实指纹不匹配，Cloudflare 静默不签发 challenge（render 成功但永不出 token）。

# 绝不要在这里加 --ignore-certificate-errors。
#
# 曾经加过，理由是「本机网络疑似 TLS 劫持，页面打不开」。2026-09-11 用 openssl
# 逐个比对证书指纹后发现，劫持者不是本机网络，而是**代理自己**：这批
# 184.178.172.* 公开 SOCKS5 全部在做 TLS 中间人，回给我们的证书签发者是
# "C=US, ST=Texas, O=None, LLC"，而直连拿到的是 Google Trust Services。
# 也就是说，Chromium 报 ERR_CERT_AUTHORITY_INVALID 是它**正确拦下了中间人**，
# 而那个开关恰好把这层保护关掉了 —— 一旦打开，签到用的 Cookie / 访问令牌
# 就会以明文暴露给代理运营者。
#
# 所以证书错误必须当作「这个代理不可信，换下一个」来处理，绝不是绕过。
# 见 verify_proxy_tls()。

# 导航策略。这些站都是 SPA，首屏要串几十个请求；走住宅代理时（RTT 实测 2-8s）
# `domcontentloaded` 和 `load` 都可能永不触发——本机实测 45s、90s、120s 全部超时，
# 加大超时值无效，因为 SPA 一直有新请求在飞。
#
# 但 `commit`（首字节到达、document 开始解析）在同一代理下只要 2-4s，而且此后
# 页面内的同源 fetch 完全正常（实测 /api/status 200、拿到 turnstile_site_key）。
# 而我们真正需要的只是「一个同源的 document 上下文」用来挂 Turnstile 和发 fetch，
# 并不需要 SPA 把界面渲染完。所以走代理时用 commit + 固定等待，直连时保持原策略。
NAV_TIMEOUT_DIRECT = 45000
NAV_TIMEOUT_PROXY = 60000
# commit 之后给页面留一点时间加载 turnstile api.js 等外部脚本
PROXY_SETTLE_MS = 6000


def nav_opts(proxy):
    """返回 (wait_until, timeout)。走代理时只等 commit，否则 SPA 永远等不完。"""
    if proxy:
        return "commit", NAV_TIMEOUT_PROXY
    return "domcontentloaded", NAV_TIMEOUT_DIRECT

# 两处 launch 共用的 Chromium 参数，避免改一处漏一处。
#
# 绝对不要在这里加 --ignore-certificate-errors。曾经为了「本机 TLS 被劫持」加过，
# 后来查明那个证书错误根本不是本机问题：那批公开 SOCKS5 代理在解密 TLS
# （2026-09-11 实测，代理侧签发者是 "C=US, ST=Texas, O=None, LLC"，
# 直连是 Google Trust Services，证书指纹完全不同）。也就是说
# ERR_CERT_AUTHORITY_INVALID 是 Chromium 正确挡住了中间人，
# 加这个参数等于把渠道 Cookie/令牌明文交给代理运营者。
BROWSER_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1366,768",
]

# 一个渠道最多换几个代理重试。代理都是慢的（实测 2-8s RTT），每次尝试含 45s
# 等 token，试太多会把 job 拖到超时；3 个足够覆盖「个别代理临时挂掉」。
MAX_PROXY_TRIES = 3
# 只有「疑似出口 IP 导致」的失败才值得换代理重试。凭证缺失/表单找不到这类
# 换出口也一样失败，重试纯属浪费 45s。
RETRYABLE_VIA_PROXY = re.compile(
    r"Turnstile|token 为空|超时|timeout|挂载失败|ERR_|拒绝|blocked|403|503|challenge",
    re.I,
)


def log(msg):
    print(msg, flush=True)


# ---------------- 面板 API ----------------

def hub_api(path, data=None, headers=None):
    req = urllib.request.Request(
        HUB + path,
        headers={"Accept": "application/json", "User-Agent": UA, **(headers or {})},
    )
    if data is not None:
        req.data = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:200]
        raise RuntimeError(f"面板请求 {path} 失败: HTTP {e.code} {detail}") from e


def hub_session_headers():
    """登录面板拿会话，返回带鉴权的请求头。"""
    if not PASSWORD:
        return {}
    req = urllib.request.Request(
        HUB + "/api/auth/login",
        data=json.dumps({"password": PASSWORD}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode())
            setc = r.headers.get("Set-Cookie", "")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:200]
        raise RuntimeError(f"面板登录失败: HTTP {e.code} {detail}") from e
    if not body.get("ok"):
        raise RuntimeError(f"面板登录失败: {body}")
    headers = {}
    if body.get("token"):
        headers["Authorization"] = f"Bearer {body['token']}"
    if setc:
        headers["Cookie"] = setc.split(";")[0]
    return headers


def fetch_browser_channels():
    auth = hub_session_headers()
    data = hub_api("/api/kv/channels", headers=auth)
    if not data.get("ok"):
        raise RuntimeError(f"拉取渠道失败: {data}")
    return [
        c for c in data.get("channels", [])
        if c.get("enabled", True) and c.get("baseUrl")
        and (c.get("options") or {}).get("runner") == "gha_browser"
    ]


def fetch_all_channels():
    """全量启用渠道（不过滤 runner），供 gha_api 降级渠道合并。"""
    auth = hub_session_headers()
    data = hub_api("/api/kv/channels", headers=auth)
    if not data.get("ok"):
        raise RuntimeError(f"拉取渠道失败: {data}")
    return [c for c in data.get("channels", []) if c.get("enabled", True) and c.get("baseUrl")]


def fetch_proxies():
    """住宅代理池（面板 KV），支持 socks5 / socks4 / http / https。

    为什么需要：Cloudflare 对 GitHub Actions 的机房 IP 常静默不签发 Turnstile
    挑战——组件能渲染但永远等不到 token（gorouter / SeekAi / JustDoWork 实测）。
    换成住宅出口后同一套代码 27s 就拿到了 token，所以代理是这类站的唯一解法。

    返回的地址已按协议处理成 Chromium 能直接用的形式（见 proxy_url_for_browser）。
    """
    try:
        auth = hub_session_headers()
        data = hub_api("/api/proxies", headers=auth)
    except Exception as e:  # noqa: BLE001
        log(f"拉取代理池失败（将直连）: {e}")
        return []
    if not data.get("ok"):
        return []
    out = []
    for p in data.get("proxies", []):
        if p.get("enabled") is False:
            continue
        # rawUrl 带凭证（GET 里 url 是打码的，不能用）
        url = p.get("rawUrl") or p.get("url") or ""
        if not url:
            continue
        chk = p.get("lastCheck") or {}
        # 面板实测「该 SOCKS 代理真的强制认证」时才跳过：Chromium 用不了 SOCKS 认证，
        # 剥掉凭证也连不上，重试纯属浪费 45s。注意这只对 SOCKS 成立 ——
        # HTTP(S) 代理的 Basic 认证 Chromium 原生支持，凭证要保留（见 proxy_url_for_browser）。
        scheme = split_proxy(url)[0]
        if scheme.startswith("socks") and chk.get("ok") and chk.get("browserUsable") is False:
            log(f"  ⏭️ 跳过 {mask_proxy(url)}（实测强制 SOCKS 认证，Chromium 用不了）")
            continue
        url = proxy_url_for_browser(url)
        # 面板测过的：连通的排前面，同为连通的按延迟升序；没测过的排中间
        rank = (0 if chk.get("ok") else 1 if chk.get("ok") is None else 2, chk.get("ms") or 9999)
        out.append((rank, url))
    out.sort(key=lambda x: x[0])
    return [u for _, u in out]


def split_proxy(url):
    """拆成 (scheme, cred, host, port)。cred 是 "user:pass" 或 ""。"""
    try:
        scheme, rest = url.split("://", 1)
    except ValueError:
        return "socks5", "", url, ""
    scheme = scheme.lower()
    cred = ""
    if "@" in rest:
        cred, rest = rest.rsplit("@", 1)
    host, _, port = rest.partition(":")
    return scheme, cred, host, port


def proxy_url_for_browser(url):
    """给 Chromium 的 --proxy-server 用的地址。

    分协议处理，不能一刀切（2026-09-11 实测）：
      socks5/socks4  **必须剥掉凭证** —— Chromium 不支持 SOCKS 用户名密码认证，
                     带上直接 ERR_SOCKS_CONNECTION_FAILED。剥掉后对那些
                     "假认证"代理照样能用（本批 OTC:OTC 实测 authUsed=none）。
      http/https     **必须保留凭证** —— Chromium 原生支持代理 Basic 认证，
                     剥掉反而会变成 407 Proxy Authentication Required。
    """
    scheme, cred, host, port = split_proxy(url)
    hostport = f"{host}:{port}" if port else host
    if scheme.startswith("socks"):
        return f"{scheme}://{hostport}"
    return f"{scheme}://{cred}@{hostport}" if cred else f"{scheme}://{hostport}"


def mask_proxy(url):
    """日志里不泄露代理凭证（协议名要照实回显，不能一律写 socks5）。"""
    try:
        scheme, cred, host, port = split_proxy(url)
        hostport = f"{host}:{port}" if port else host
        if cred:
            return f"{scheme}://{cred.split(':', 1)[0]}:***@{hostport}"
        return f"{scheme}://{hostport}"
    except Exception:  # noqa: BLE001
        return "(proxy)"


def _peer_cert_sha256(host, port, proxy=None, timeout=15):
    """取目标站 TLS 证书的 SHA-256 指纹；proxy 为 None 时直连。

    故意用 verify_mode=NONE：我们要的是「看到对方递了什么证书」，
    而不是「证书是否可信」——不关校验就拿不到 MITM 代理伪造的那张证书。
    """
    import hashlib
    import socket as _socket
    import ssl as _ssl

    ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = _ssl.CERT_NONE

    if proxy:
        scheme, cred, phost, pport = split_proxy(proxy)
        raw = _socket.create_connection((phost, int(pport or 1080)), timeout=timeout)
        try:
            if scheme in ("http", "https"):
                # https 代理要先对代理这一跳做 TLS，否则 Basic 凭证明文过网
                if scheme == "https":
                    praw = ctx.wrap_socket(raw, server_hostname=phost)
                    raw = praw
                req = [f"CONNECT {host}:{port} HTTP/1.1", f"Host: {host}:{port}"]
                if cred:
                    import base64
                    req.append(
                        "Proxy-Authorization: Basic "
                        + base64.b64encode(cred.encode()).decode()
                    )
                raw.sendall(("\r\n".join(req) + "\r\n\r\n").encode())
                head = b""
                while b"\r\n\r\n" not in head and len(head) < 4096:
                    chunk = raw.recv(1024)
                    if not chunk:
                        break
                    head += chunk
                first = head.split(b"\r\n", 1)[0].decode(errors="replace")
                if " 2" not in first:
                    raise RuntimeError(f"代理 CONNECT 失败: {first[:60]}")
            elif scheme == "socks4":
                # SOCKS4a：IP 填 0.0.0.1 表示让代理解析域名
                hb = host.encode()
                raw.sendall(
                    bytes([0x04, 0x01]) + port.to_bytes(2, "big")
                    + bytes([0, 0, 0, 1]) + b"\x00" + hb + b"\x00"
                )
                rep = raw.recv(8)
                if len(rep) < 2 or rep[1] != 0x5A:
                    raise RuntimeError(f"SOCKS4 CONNECT 被拒绝 rep={rep[1] if len(rep) > 1 else '?'}")
            else:
                # SOCKS5：声明免认证 + 用户名密码两种方式
                user, _, pwd = (cred or "").partition(":")
                methods = [0x00, 0x02] if user else [0x00]
                raw.sendall(bytes([0x05, len(methods)] + methods))
                greet = raw.recv(2)
                if greet[:1] != b"\x05":
                    raise RuntimeError("不是 SOCKS5 代理")
                if greet[1:2] == b"\x02":
                    ub, pb = user.encode(), pwd.encode()
                    raw.sendall(bytes([0x01, len(ub)]) + ub + bytes([len(pb)]) + pb)
                    if raw.recv(2)[1:2] != b"\x00":
                        raise RuntimeError("SOCKS5 认证被拒绝")
                hb = host.encode()
                raw.sendall(bytes([0x05, 0x01, 0x00, 0x03, len(hb)]) + hb + port.to_bytes(2, "big"))
                rep = raw.recv(4)
                if len(rep) < 2 or rep[1] != 0x00:
                    raise RuntimeError(f"CONNECT 被拒绝 rep={rep[1] if len(rep) > 1 else '?'}")
                raw.recv(256)  # 丢掉绑定地址
        except Exception:
            try:
                raw.close()
            except Exception:  # noqa: BLE001
                pass
            raise
    else:
        raw = _socket.create_connection((host, port), timeout=timeout)

    try:
        with ctx.wrap_socket(raw, server_hostname=host) as ss:
            return hashlib.sha256(ss.getpeercert(binary_form=True)).hexdigest()
    finally:
        try:
            raw.close()
        except Exception:  # noqa: BLE001
            pass


def proxy_is_safe(proxy, host, direct_fp, port=443):
    """代理是否**没有**解密 TLS。

    2026-09-11 实测教训：一批"住宅 SOCKS5"（184.178.172.*）会做 TLS 中间人——
    递给客户端的是自签证书（issuer=O=None LLC, ST=Texas），指纹与直连完全不同。
    这类代理能看到明文，签到凭证（Cookie / access token）会整个泄露给代理运营方。
    Chromium 当时报的 ERR_CERT_AUTHORITY_INVALID 其实是**正确的保护**，
    绝不能用 --ignore-certificate-errors 绕过。

    返回 (safe, reason)。拿不到直连基准指纹时保守放行（reason 说明原因），
    因为那通常意味着本机网络本身有问题，不该据此判所有代理有罪。
    """
    if not direct_fp:
        return True, "无直连基准，跳过 MITM 校验"
    try:
        fp = _peer_cert_sha256(host, port, proxy=proxy)
    except Exception as e:  # noqa: BLE001
        return False, f"TLS 探测失败: {str(e)[:80]}"
    if fp != direct_fp:
        return False, "代理在解密 TLS（证书指纹与直连不一致），凭证会泄露"
    return True, "证书指纹与直连一致"


def report_results(results):
    if not (HUB and os.environ.get("HUB_SECRET")):
        log("未配置 HUB_SECRET，跳过回传")
        return
    payload = {"secret": os.environ["HUB_SECRET"], "results": results}
    req = urllib.request.Request(
        HUB + "/api/gh/result",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            log(f"回传结果: HTTP {r.status} {r.read().decode()[:120]}")
    except Exception as e:  # noqa: BLE001
        log(f"回传失败: {e}")


# ---------------- 浏览器签到 ----------------

def quota_usd(quota, per_unit=500000):
    try:
        n = float(quota) / (float(per_unit) or 500000)
    except (TypeError, ValueError):
        return None
    return f"${n:.4f}" if 0 < abs(n) < 0.01 else f"${n:.2f}"


def checkin_message(ok, body, status):
    """拼出能自证的签到结论。

    NewAPI 成功时只回 message:"" 或 "success"，直接透传会让日志变成「渠道名：success」，
    看不出是真发了奖励还是只是请求通了。这里把奖励额度带出来。
    """
    body = body or {}
    d = body.get("data") or {}
    srv = str(body.get("message") or "").strip()
    if not ok:
        return (srv or f"HTTP {status}")[:200]
    already = "已签到" in srv or "already" in srv.lower()
    reward = d.get("quota_awarded") if isinstance(d, dict) else None
    parts = []
    if already:
        parts.append("今日已签到（未重复发放）")
    else:
        money = quota_usd(reward) if reward is not None else None
        parts.append(f"签到成功，奖励 {money}" if money else "签到成功（接口未返回奖励字段）")
    if srv and srv.lower() not in ("ok", "success", "成功") and srv not in parts[0]:
        parts.append(f"服务端：{srv}")
    return "，".join(parts)[:200]


def parse_cookie_pairs(raw):
    """'a=1; b=2' → [(name, value)]；容忍多行/JSON 导出格式。"""
    if not raw:
        return []
    out = []
    for part in re.split(r"[;\n]", str(raw)):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        name = name.strip()
        if name and not name.lower().startswith("cookie:"):
            out.append((name, value.strip()))
    return out


async def sub2api_login_checkin(channel, proxy=None) -> dict:
    """sub2api 站（百倍等）：账密登录 + 页面内真实签到。

    注意：登录本身不发奖励，必须再调 POST /api/v1/check-in（2026-09-09 修复：
    旧版只登录刷新 token 就报成功，导致百倍连续多天实际未签到）。

    流程（与 gorouter 的页面内 fetch 同构）：
      1. CloakBrowser 打开 /login，从内嵌配置读 turnstile_site_key
      2. 页面内用该 sitekey 主动挂 Turnstile，拟人点击等 token
      3. 拿到 token 后页面内 fetch /api/v1/auth/login（带 turnstile_token），
         绕开前端表单校验
      4. 带 Bearer 在页面内 fetch /api/v1/check-in 真实签到
      5. 新 accessToken/refreshToken 回传 Worker 写回 KV
    """
    from cloakbrowser import launch_async

    name = channel.get("name", "unnamed")
    base = channel["baseUrl"].rstrip("/")
    auth = channel.get("auth") or {}
    email = auth.get("email") or auth.get("username") or ""
    password = auth.get("password") or ""
    if not (email and password):
        return {"name": name, "ok": False, "message": "缺少邮箱/密码，无法走登录流程"}

    if proxy:
        log(f"  🌍 {name}: 走代理 {mask_proxy(proxy)}")
    browser = await launch_async(
        headless=HEADLESS,
        humanize=True,
        proxy=proxy or None,
        args=list(BROWSER_ARGS),
    )
    try:
        context = await browser.new_context(
            viewport={"width": 1366, "height": 768}, user_agent=UA
        )
        page = await context.new_page()
        log(f"  🌐 {name}: 打开登录页 {base}/login")
        wait_until, nav_ms = nav_opts(proxy)
        await page.goto(base + "/login", wait_until=wait_until, timeout=nav_ms)
        await page.wait_for_timeout(PROXY_SETTLE_MS if proxy else 5000)

        # 1) 先填表（关键：widget 只在表单交互后才渲染，填表必须先于等 token）
        #    SPA 冷启动时脚本加载慢，表单可能 5s 后才出现 —— 在页面内轮询等待输入框
        filled = None
        for _ in range(15):  # 最多 30s
            filled = await page.evaluate(
                """([email, password]) => {
                    const setVal = (el, v) => {
                        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
                        desc.set.call(el, v);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    };
                    const emailEl =
                        document.querySelector('input[type=email]') ||
                        document.querySelector('input[name=email]') ||
                        document.querySelector('input[name=username]') ||
                        document.querySelector('input[placeholder*=邮箱 i]') ||
                        document.querySelector('input[placeholder*=账号 i]');
                    const pwdEl = document.querySelector('input[type=password]');
                    if (!emailEl || !pwdEl) return { ok: false, hasEmail: !!emailEl, hasPwd: !!pwdEl };
                    setVal(emailEl, email);
                    setVal(pwdEl, password);
                    return { ok: true };
                }""",
                [email, password],
            )
            if filled.get("ok"):
                break
            await page.wait_for_timeout(2000)
        log(f"  🔎 {name}: 表单填写 {json.dumps(filled, ensure_ascii=False)[:120]}")
        if not filled.get("ok"):
            return {"name": name, "ok": False,
                    "message": f"登录页表单未找到（email={filled.get('hasEmail')} pwd={filled.get('hasPwd')}）"}

        # 2) 从页面内嵌配置读 sitekey
        cfg = await page.evaluate(
            """() => {
                const html = document.documentElement.innerHTML;
                const en = html.match(/"turnstile_enabled"\\s*:\\s*(true|false)/);
                const sk = html.match(/"turnstile_site_key"\\s*:\\s*"([^"]+)"/);
                return { enabled: en ? en[1] === "true" : null, key: sk ? sk[1] : null };
            }"""
        )
        log(f"  🔑 {name}: 页面配置 {json.dumps(cfg, ensure_ascii=False)}")
        sitekey = None
        if cfg.get("enabled") is False:
            sitekey = None  # 未开 Turnstile：直接页面内 fetch 登录
        elif cfg.get("key"):
            sitekey = cfg["key"]
        else:
            return {"name": name, "ok": False, "message": "登录页未找到 turnstile 配置"}

        # 3) 等原生 widget 的 token（填表后站点自动渲染，4s 内出）；
        #    40s 还没有才自己挂一个。等待期间拟人点击 challenge iframe。
        ts_token = None
        for i in range(20):
            await page.wait_for_timeout(2000)
            ts_token = await page.evaluate(
                "() => { const h = document.querySelector('[name=cf-turnstile-response]'); return h && h.value ? h.value : null; }"
            )
            if ts_token:
                log(f"  🎉 {name}: 原生 widget 第 {i*2+5}s 出 token（len {len(ts_token)}）")
                break
            for f in page.frames:
                if "challenges.cloudflare.com" in (f.url or ""):
                    try:
                        el = await f.frame_element()
                        box = await el.bounding_box()
                        if box and box["width"] > 0:
                            x, y = box["x"] + 30, box["y"] + box["height"] / 2
                            await page.mouse.move(x, y, steps=5)
                            await page.mouse.click(x, y)
                    except Exception:  # noqa: BLE001
                        pass
        if sitekey and not ts_token:
            # 原生 widget 40s 未出：自己挂一个（渲染在独立容器，不与表单冲突）
            log(f"  ⏳ {name}: 原生 widget 未出 token，自行挂载 ...")
            await page.evaluate(
                """(sitekey) => {
                    window._tsToken = null; window._tsError = null;
                    if (!document.getElementById('hub-ts-box')) {
                        const d = document.createElement('div');
                        d.id = 'hub-ts-box'; document.body.appendChild(d);
                    }
                    const render = () => {
                        try {
                            window.turnstile.render('#hub-ts-box', {
                                sitekey,
                                callback: (t) => { window._tsToken = t; },
                                'error-callback': (e) => { window._tsError = String(e); },
                            });
                        } catch (e) { window._tsError = 'render-throw: ' + (e && e.message || e); }
                    };
                    if (window.turnstile) { render(); }
                    else {
                        const s = document.createElement('script');
                        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                        s.onload = () => render();
                        document.head.appendChild(s);
                    }
                }""",
                sitekey,
            )
            log(f"  ⏳ {name}: 等 Turnstile token（拟人点击，最长 45s）...")
            for _ in range(45):
                await page.wait_for_timeout(1000)
                ts_token = await page.evaluate("() => window._tsToken")
                if ts_token:
                    break
                for f in page.frames:
                    if "challenges.cloudflare.com" in (f.url or ""):
                        try:
                            el = await f.frame_element()
                            box = await el.bounding_box()
                            if box and box["width"] > 0:
                                x, y = box["x"] + 35, box["y"] + box["height"] / 2
                                await page.mouse.move(x, y, steps=5)
                                await page.mouse.click(x, y)
                        except Exception:  # noqa: BLE001
                            pass
            if not ts_token:
                err = await page.evaluate("() => window._tsError")
                return {"name": name, "ok": False, "message": f"Turnstile 超时 err={err}"}
            log(f"  🎉 {name}: 拿到 turnstile token（len {len(ts_token)}）")

        # 3) 页面内 fetch 登录
        creds = json.dumps({"email": email, "password": password})
        res = await page.evaluate(
            """async ([creds, ts]) => {
                const body = { ...JSON.parse(creds) };
                if (ts) body.turnstile_token = ts;
                const r = await fetch('/api/v1/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                let b = null; try { b = await r.json(); } catch (e) {}
                return { status: r.status, body: b };
            }""",
            [creds, ts_token],
        )
        body = res.get("body") or {}
        if res.get("status") != 200 or body.get("code") not in (0, None) and not body.get("data"):
            return {
                "name": name,
                "ok": False,
                "message": f"登录 API HTTP {res.get('status')}: {str(body.get('message') or body)[:100]}",
            }
        d = body.get("data") or {}
        access = d.get("access_token") or d.get("accessToken")
        refresh = d.get("refresh_token") or d.get("refreshToken") or ""
        if not access:
            return {"name": name, "ok": False, "message": f"登录响应无 token: {str(body)[:120]}"}

        log(f"  🎉 {name}: 登录成功，新 token（access len {len(access)}）")

        # 4) 页面内真实签到（登录不发奖励；带 Bearer 调 /api/v1/check-in）
        checkin = await page.evaluate(
            """async (access) => {
                const r = await fetch('/api/v1/check-in', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + access,
                    },
                    body: JSON.stringify({ timezone: 'Asia/Shanghai' }),
                });
                let b = null; try { b = await r.json(); } catch (e) {}
                return { status: r.status, body: b };
            }""",
            access,
        )
        cb = checkin.get("body") or {}
        cd = cb.get("data") or {}
        cmsg = str(cb.get("message") or "")
        already = ("已签到" in cmsg) or (cd.get("already_checked_in") is True)
        cok = checkin.get("status") == 200 and (
            cb.get("code") == 0 or already or cd.get("checked_in_today") is True
        )
        if not cok:
            return {
                "name": name,
                "ok": False,
                "message": f"登录成功但签到失败 HTTP {checkin.get('status')}: {cmsg or str(cb)[:100]}",
                "newTokens": {"accessToken": access, "refreshToken": refresh},
            }
        reward = cd.get("reward_amount")
        bal = cd.get("balance_after")
        rmsg = "今日已签到" if already else "签到成功"
        if reward is not None:
            rmsg += f"，奖励 ${reward}"
        if bal is not None:
            rmsg += f"，余额 ${bal}"
        log(f"  ✅ {name}: {rmsg}")
        return {
            "name": name,
            "ok": True,
            "message": f"登录+签到：{rmsg}",
            "newTokens": {"accessToken": access, "refreshToken": refresh},
        }
    except Exception as e:  # noqa: BLE001
        return {"name": name, "ok": False, "message": f"异常: {str(e)[:120]}"}
    finally:
        try:
            await browser.close()
        except Exception:  # noqa: BLE001
            pass

async def checkin_one(channel, proxy=None) -> dict:
    """单渠道：开浏览器 → Turnstile token → 页面内 fetch 签到。

    proxy: 住宅 SOCKS5 出口（socks5://host:port，不能带凭证）。传入时整个
    浏览器的流量都走它——Turnstile 校验的是浏览器出口 IP，只有这样 CF 才肯
    签发挑战。
    """
    from cloakbrowser import launch_async

    name = channel.get("name", "unnamed")
    base = channel["baseUrl"].rstrip("/")
    sitekey = (channel.get("options") or {}).get("turnstileSiteKey") or DEFAULT_SITEKEY
    auth = channel.get("auth") or {}
    cookie_raw = auth.get("cookie") or ""
    token = auth.get("token") or ""

    if proxy:
        log(f"  🌍 {name}: 走代理 {mask_proxy(proxy)}")
    browser = await launch_async(
        headless=HEADLESS,
        humanize=True,
        proxy=proxy or None,
        args=list(BROWSER_ARGS),
    )
    try:
        context = await browser.new_context(
            viewport={"width": 1366, "height": 768}, user_agent=UA
        )
        page = await context.new_page()
        # 直接开首页（kppq66 成功行为；绕道 /login 会触发登录页自己的 Turnstile 干扰挂载）
        log(f"  🌐 {name}: 打开 {base}")
        wait_until, nav_ms = nav_opts(proxy)
        await page.goto(base + "/", wait_until=wait_until, timeout=nav_ms)
        await page.wait_for_timeout(PROXY_SETTLE_MS if proxy else 2000)
        pairs = parse_cookie_pairs(cookie_raw)
        if pairs:
            host = base.split("//", 1)[1].split("/", 1)[0]
            domain = host[4:] if host.startswith("www.") else host
            await context.add_cookies(
                [
                    {"name": n, "value": v, "domain": domain, "path": "/"}
                    for n, v in pairs
                ]
            )

        # localStorage token 鉴权（有 system access token 的站，登录态影响签到请求）
        if token:
            await page.evaluate(
                """(t) => { try {
                     localStorage.setItem('token', t);
                     localStorage.setItem('user', JSON.stringify({ token: t }));
                   } catch(e) {} }""",
                token,
            )

        # 顺序很重要：先取权威 sitekey，再挂载一次。
        # （旧写法先用 gorouter 默认 key 挂载、事后 reset —— 但 reset 引用的 box id
        #  与实际创建的不一致、widgetId 也没存，异常被吞掉，于是 SeekAi 这类站
        #  始终在用错的 key 挂载，表现为 err=300010 或静默无 token。）
        sitekey = (channel.get("options") or {}).get("turnstileSiteKey") or ""
        if not sitekey:
            try:
                st = await page.evaluate(
                    """async () => {
                        try {
                            const cached = JSON.parse(localStorage.getItem('status') || 'null');
                            if (cached && cached.data && cached.data.turnstile_site_key)
                                return { key: cached.data.turnstile_site_key, src: 'localStorage' };
                        } catch (e) {}
                        const r = await fetch('/api/status', { credentials: 'include' });
                        const j = await r.json().catch(() => null);
                        const k = j && j.data && j.data.turnstile_site_key;
                        return k ? { key: k, src: 'api' } : { key: null, src: 'none' };
                    }"""
                )
                log(f"  🔑 {name}: /api/status sitekey {json.dumps(st, ensure_ascii=False)}")
                if st.get("key"):
                    sitekey = st["key"]
            except Exception as e:  # noqa: BLE001
                log(f"  ⚠️ {name}: sitekey 获取失败 {e}")
        if not sitekey:
            sitekey = DEFAULT_SITEKEY
        log(f"  🔑 {name}: 最终 sitekey = {str(sitekey)[:24]}")

        # 挂载一次（api.js 在 GHA 上可能要几秒才就绪，注入后必须等 onload 触发 render，
        # 否则往下走时 window.turnstile 还不存在 —— 之前 gorouter 的 hasTurnstile:false）
        await page.evaluate(
            """(sitekey) => {
                window._tsToken = null; window._tsError = null;
                window._tsRendered = false; window._tsWidgetId = null;
                if (!document.getElementById('cf-turnstile-box')) {
                    const d = document.createElement('div');
                    d.id = 'cf-turnstile-box'; document.body.appendChild(d);
                }
                const render = () => {
                    try {
                        window._tsWidgetId = window.turnstile.render('#cf-turnstile-box', {
                            sitekey,
                            callback: (t) => { window._tsToken = t; },
                            'error-callback': (e) => { window._tsError = String(e); },
                            'expired-callback': () => { window._tsToken = null; },
                        });
                        window._tsRendered = true;
                    } catch (e) {
                        window._tsError = 'render-throw: ' + (e && e.message || e);
                    }
                };
                if (window.turnstile) { render(); return; }
                const existing = document.querySelector('script[src*="challenges.cloudflare.com"]');
                if (!existing) {
                    const s = document.createElement('script');
                    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                    s.onload = () => render();
                    s.onerror = () => { window._tsError = 'api.js load failed'; };
                    document.head.appendChild(s);
                } else {
                    // 页面自己在加载 api.js：等它就绪
                    const timer = setInterval(() => {
                        if (window.turnstile) { clearInterval(timer); render(); }
                    }, 200);
                    setTimeout(() => clearInterval(timer), 20000);
                }
            }""",
            sitekey,
        )
        # 等 render 真正执行（最多 20s），而不是固定 sleep 后盲目往下走
        for _ in range(40):
            mount = await page.evaluate(
                "() => ({ api: !!window.turnstile, rendered: !!window._tsRendered, err: window._tsError })"
            )
            if mount.get("rendered") or mount.get("err"):
                break
            await page.wait_for_timeout(500)
        log(f"  🧩 {name}: 挂载状态 {json.dumps(mount, ensure_ascii=False)}")
        if not mount.get("rendered"):
            return {
                "name": name,
                "ok": False,
                "message": f"Turnstile 挂载失败: {mount.get('err') or 'api.js 未就绪'}",
            }

        diag = await page.evaluate(
            """() => ({
                title: document.title,
                url: location.href,
                hasTurnstile: !!window.turnstile,
                widgetCount: document.querySelectorAll('[id*=turnstile],[class*=turnstile],.cf-turnstile').length,
                bodyHead: document.body ? document.body.innerText.slice(0, 200) : '',
            })"""
        )
        log(f"  🔍 {name}: 诊断 {json.dumps(diag, ensure_ascii=False)[:320]}")

        log(f"  ⏳ {name}: 等待 Turnstile token（拟人点击，最长 45s）...")
        ts_token = None
        for _ in range(45):
            await page.wait_for_timeout(1000)
            ts_token = await page.evaluate("() => window._tsToken")
            if ts_token:
                break
            # 拟人点击挑战 iframe 的 checkbox 区域
            for f in page.frames:
                if "challenges.cloudflare.com" in (f.url or ""):
                    try:
                        el = await f.frame_element()
                        box = await el.bounding_box()
                        if box and box["width"] > 0:
                            x, y = box["x"] + 35, box["y"] + box["height"] / 2
                            await page.mouse.move(x, y, steps=5)
                            await page.mouse.click(x, y)
                    except Exception:  # noqa: BLE001
                        pass
        if not ts_token:
            # 兜底：不带 turnstile 直接页面内 fetch 签到（探测服务端是否真强制）
            hdrs = json.dumps({"Authorization": f"Bearer {token}"} if token else {})
            direct = await page.evaluate(
                """async (h) => {
                    const res = await fetch('/api/user/checkin', {
                        method: 'POST', credentials: 'include', headers: JSON.parse(h),
                    });
                    let b = null; try { b = await res.json(); } catch (e) {}
                    return { status: res.status, body: b };
                }""",
                hdrs,
            )
            db = direct.get("body") or {}
            dmsg = str(db.get("message") or "")[:120]
            dok = direct.get("status") == 200 and (db.get("success") or "已签到" in dmsg)
            return {
                "name": name,
                "ok": dok,
                "message": f"无token直签 HTTP {direct.get('status')}: {dmsg or str(db)[:100]}",
            }

        log(f"  🎉 {name}: 拿到 token（长度 {len(ts_token)}），页面内签到...")
        headers_js = json.dumps({"Authorization": f"Bearer {token}"} if token else {})
        checkin = await page.evaluate(
            """async ([tokenQs, headersJs]) => {
                const res = await fetch('/api/user/checkin?turnstile=' + encodeURIComponent(tokenQs), {
                    method: 'POST', credentials: 'include',
                    headers: JSON.parse(headersJs || '{}'),
                });
                let body = null; try { body = await res.json(); } catch(e) {}
                return { status: res.status, body };
            }""",
            [ts_token, headers_js],
        )
        body = checkin.get("body") or {}
        ok = checkin.get("status") == 200 and (
            body.get("success") or "已签到" in str(body.get("message", ""))
        )
        result = {
            "name": name,
            "ok": ok,
            "message": checkin_message(ok, body, checkin.get("status")),
        }

        # 顺手取余额（失败不影响签到结果）
        try:
            me = await page.evaluate(
                """async (headersJs) => {
                    const res = await fetch('/api/user/self', {
                        credentials: 'include', headers: JSON.parse(headersJs || '{}'),
                    });
                    let b = null; try { b = await res.json(); } catch(e) {}
                    return b && b.data ? b.data : null;
                }""",
                headers_js,
            )
            if me and me.get("quota") is not None:
                result["quotaInfo"] = {
                    "quota": me.get("quota"),
                    "usedQuota": me.get("used_quota"),
                    "quotaPerUnit": 500000,
                    "account": me.get("display_name") or me.get("username") or "",
                }
        except Exception:  # noqa: BLE001
            pass
        return result
    finally:
        try:
            await browser.close()
        except Exception:  # noqa: BLE001
            pass


def load_api_fallback_names():
    """gha_api job 的失败渠道清单（降级链最后一级的重试对象）。"""
    path = os.environ.get("API_FALLBACK_LIST") or "api-artifact/gha-fallback.json"
    try:
        with open(path, encoding="utf-8") as f:
            names = json.load(f)
        return [str(n) for n in names if n]
    except Exception:  # noqa: BLE001
        return []


async def main():
    if not HUB:
        raise SystemExit("缺少 HUB_BASE_URL")
    channels = fetch_browser_channels()
    log(f"browser 通道渠道 {len(channels)} 个: {[c['name'] for c in channels]}")

    # 降级：gha_api 失败的渠道并入本 job 重试（去重；sub2api 走浏览器登录+签到，
    # newapi 走 Turnstile/cookie 路径），回传结果统一经 /api/gh/result 写 KV。
    fallback_names = load_api_fallback_names()
    if fallback_names:
        log(f"gha_api 降级渠道 {len(fallback_names)} 个: {fallback_names}")
    existing = {c["name"] for c in channels}
    for ch in fetch_all_channels():
        if ch["name"] in fallback_names and ch["name"] not in existing:
            channels.append(ch)
            existing.add(ch["name"])

    # 住宅代理池：GHA 机房 IP 拿不到 Turnstile token，必须借住宅出口。
    # 先直连（有的站不需要代理，直连最快也最稳），失败再依次换代理重试。
    proxies = fetch_proxies()
    if proxies:
        log(f"代理池候选 {len(proxies)} 个（按实测延迟排序）")

    # 用前必须验证 TLS 没被中间人替换。2026-09-11 实测这批公开 SOCKS5
    # （184.178.172.*）全部在解密 TLS：证书签发者从 Google Trust Services 变成
    # "None, LLC"（Dallas TX），指纹与直连完全不同。渠道 Cookie / 访问令牌
    # 一旦经这种代理发出，等于明文交给代理运营方。宁可拿不到 token 也不能用。
    safe = []
    if proxies:
        # 用第一个渠道的域名做基准：GHA 能直连目标站（只是拿不到 Turnstile token），
        # 所以直连指纹是可得的，拿它当"真证书"的标准答案。
        ref_host = ""
        for c in channels:
            try:
                ref_host = c["baseUrl"].split("//", 1)[1].split("/", 1)[0]
                break
            except Exception:  # noqa: BLE001
                continue
        direct_fp = None
        if ref_host:
            try:
                direct_fp = _peer_cert_sha256(ref_host, 443)
                log(f"TLS 基准（直连 {ref_host}）: {direct_fp[:16]}…")
            except Exception as e:  # noqa: BLE001
                log(f"⚠️ 取直连 TLS 基准失败（{str(e)[:60]}），本次跳过 MITM 校验")
        for p in proxies[: MAX_PROXY_TRIES + 2]:  # 多验两个，给筛掉的留余量
            ok, reason = proxy_is_safe(p, ref_host, direct_fp)
            if ok:
                safe.append(p)
                log(f"  ✅ {mask_proxy(p)}：{reason}")
                if len(safe) >= MAX_PROXY_TRIES:
                    break
            elif "解密 TLS" in reason:
                log(f"  🚨 拒用 {mask_proxy(p)}：{reason}——凭证会泄露给代理运营方")
            else:
                log(f"  ⏭️ 跳过 {mask_proxy(p)}：{reason}")
        if not safe:
            log("⚠️ 代理池中没有一个通过 TLS 校验，本次只能直连（Turnstile 站预期拿不到 token）")
        else:
            log(f"通过 TLS 校验的代理 {len(safe)} 个")
    else:
        log("代理池为空，仅直连（Turnstile 站可能拿不到 token）")

    attempts = [None] + safe

    results = []
    for ch in channels:
        name = ch.get("name", "?")
        r = None
        for i, proxy in enumerate(attempts):
            via = "直连" if proxy is None else f"代理 {mask_proxy(proxy)}"
            if i:
                log(f"  🔁 {name}: 换 {via} 重试（第 {i} 次）")
            try:
                if ch.get("type") == "sub2api":
                    r = await sub2api_login_checkin(ch, proxy=proxy)
                else:
                    r = await checkin_one(ch, proxy=proxy)
            except Exception as e:  # noqa: BLE001
                r = {"name": name, "ok": False, "message": f"{via}异常: {str(e)[:120]}"}
            if r.get("ok"):
                if i:
                    r["message"] = f"{r.get('message', '')}（经{via}）"
                break
            # 只有「拿不到 token / 网络层失败」才值得换出口；凭证类错误换 IP 也白搭
            if not RETRYABLE_VIA_PROXY.search(str(r.get("message", ""))):
                break
        log(f"  {'✅' if r['ok'] else '❌'} {r['name']}: {r['message']}")
        results.append(r)
    report_results(results)
    with open("gha-results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    asyncio.run(main())
