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
    - 自挂组件拿不到 token 时，照站点自身流程把人的动作重放一遍：
      ① 空 token POST 一次（站点前端就是这么开头的）；② 点站点自己的签到按钮，
      让它前端去挂它自己的 widget；③ 从那个 widget 收 token 重发。
      站点对空 token 的回话固定是「Turnstile token 为空」，那是**对空 token 的话术**，
      不是「我们的 token 无效」；页面上平时看不到组件，因为它是这段流程里才惰性挂的。
    - 每次「POST 说不清」都再用 GET /api/user/checkin?month= 查一次权威状态：
      token 是一次性的，站点前端可能已经抢先用掉并领了奖励，光看 POST 回话会误报失败
     - 页面内 fetch /api/user/self 取余额
  3. 全部结果回传面板 /api/gh/result（写入 KV + TG 通知）

环境变量：
  HUB_BASE_URL / HUB_SECRET / HUB_ACCESS_PASSWORD   同 Node runner
  CHECKIN_HEADLESS   "true"/"false"（xvfb 下用 false）
"""

import asyncio
import contextlib
import json
import os
import re
import time
import urllib.error
import urllib.request

HUB = (os.environ.get("HUB_BASE_URL") or "").rstrip("/")
PASSWORD = os.environ.get("HUB_ACCESS_PASSWORD") or ""
# GHA 上没有真实显示器。Camoufox 的 headless="virtual" 会自己拉 Xvfb，
# 所以 workflow 不再需要外面套 xvfb-run；本机有头则直接开真窗口。
IN_CI = bool(os.environ.get("GITHUB_ACTIONS") or os.environ.get("CI"))
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

# 拟人光标移动的**最大**秒数。Camoufox 的 humanize=True 是「不设上限」，官方文档
# 只说「光标通常最多 1.5 秒移动完」——而等 token 的循环每轮都要对每个 Cloudflare
# iframe 做一次 mouse.move，于是 `for _ in range(45)` 根本不是 45 秒：
# 2026-09-11 首次 GHA 实测跑到 30 分钟 job 上限被 cancelled（日志停在「等待
# Turnstile token」那一行）。传具体秒数给 humanize 才有上限。
HUMANIZE_MAX_S = 0.6

# 等 token 的墙钟预算（秒）。原来按「循环轮数 ≈ 秒数」估算，那个假设在 humanize
# 下不成立，所以改成真按时间判断，循环里每轮检查 time.monotonic()。
TOKEN_WAIT_S = 45
# sub2api 站填表后站点会自己渲染 widget，通常 4s 内出 token；这段先等它，
# 超了才自行挂载一个。
NATIVE_WIDGET_BUDGET_S = 40
# 权威状态查询（GET /api/user/checkin?month=）的单次上限。它只在「POST 说不清」时才跑，
# 但悬挂会把一次很可能已经发奖的尝试拖成 ❌超时，所以和 attach_quota 一样要有上限。
STATUS_QUERY_TIMEOUT_S = 12
# 单个渠道的总墙钟预算：超了就放弃这次尝试，把时间留给换代理重试和后面的渠道，
# 而不是把整个 job 拖到 GHA 超时（那样连结果回传都不会发生）。
CHANNEL_BUDGET_S = int(os.environ.get("CHECKIN_CHANNEL_BUDGET_S") or 300)
# 整个 job 的墙钟预算，必须**明显小于** workflow 的 timeout-minutes（现为 30 分钟）。
# 留出余量是关键：被 GHA 掐死时 report_results() 不会执行，面板上渠道就永远停在
# 「已触发」；自己先停下来至少能回传一条失败原因。
JOB_BUDGET_S = int(os.environ.get("CHECKIN_JOB_BUDGET_S") or 1200)


async def click_challenge(page, x_offset=35):
    """拟人点击 Cloudflare 挑战 iframe 的勾选框区域。

    三处等 token 的循环原本各自内联一份同样的代码，改预算时容易漏改一处。
    异常一律忽略：iframe 随时可能被 CF 换掉或移除，拿不到 bounding_box 是常态，
    下一轮重试即可。
    """
    for f in page.frames:
        if "challenges.cloudflare.com" not in (f.url or ""):
            continue
        try:
            el = await f.frame_element()
            box = await el.bounding_box()
            if box and box["width"] > 0:
                x, y = box["x"] + x_offset, box["y"] + box["height"] / 2
                await page.mouse.move(x, y, steps=5)
                await page.mouse.click(x, y)
        except Exception:  # noqa: BLE001
            pass


def nav_opts(proxy):
    """返回 (wait_until, timeout)。走代理时只等 commit，否则 SPA 永远等不完。"""
    if proxy:
        return "commit", NAV_TIMEOUT_PROXY
    return "domcontentloaded", NAV_TIMEOUT_DIRECT

# CloakBrowser（Chromium）专用参数，仅在 ENGINE=cloakbrowser 时使用。
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

# ---------------- 浏览器引擎 ----------------
#
# camoufox（默认，Firefox 内核）/ cloakbrowser（Chromium，旧实现，保留可回退）。
#
# 换 Camoufox 的实际收益（2026-09-11 逐项实测，不是照搬宣传）：
#   · disable_coop —— 官方为「点击跨域 iframe 里的 Turnstile 勾选框」提供的开关，
#     正是本项目要干的事；Chromium 侧只能靠猜坐标点 iframe。
#   · headless='virtual' —— 自带 Xvfb，workflow 不再需要 xvfb-run 包一层。
#   · 指纹由 browserforge 按真实机型生成（navigator/screen/WebGL/字体一致），
#     不用再手工维护「UA 必须跟内核版本对齐」这条脆弱约束。
#
# 必须说清的一点：**换 Firefox 并没有解决 SOCKS5 认证**。这原本是我推荐换引擎的
# 主要理由，实测被推翻——拦截来自 Playwright 驱动本身而非浏览器：
#   driver/package/lib/coreBundle.js: normalizeProxySettings()
#   socks5:// + username/password → throw "Browser does not support socks5 proxy authentication"
# 这个判断对 firefox/chromium 一视同仁。所以带认证的 SOCKS5 代理两个引擎都用不了，
# 只有 http(s):// 代理的 Basic 认证能走（Playwright 自己处理）。付费住宅代理请优先
# 选 HTTP(S) 端点，或用免认证 + IP 白名单的 SOCKS5。
ENGINE = (os.environ.get("CHECKIN_ENGINE") or "camoufox").strip().lower()
# 本机装的 Camoufox 内核版本可能与 pip 包要求的不一致（会触发每次启动都去 GitHub
# 下载）。指到已装的 camoufox 可执行文件即可跳过下载；GHA 上留空走标准安装。
CAMOUFOX_EXECUTABLE = os.environ.get("CAMOUFOX_EXECUTABLE") or None
# 明知代理在解密 TLS 也照用（人工 dispatch 时显式打开，默认关）。
#
# 打开它意味着什么：MITM 代理递自签证书、能看到明文，本次签到用到的渠道 Cookie /
# 访问令牌会整个泄露给代理运营方；同时浏览器必须跟着忽略证书错误，否则页面根本打不开
# （ERR_CERT_AUTHORITY_INVALID）。用完请去站点改密码 / 换令牌。
#
# 为什么做成开关而不是直接删掉校验：每日 cron 会跑全部渠道，默认放行等于让所有渠道
# 长期裸奔。这里保持「默认拦、单次放行」，cron 不受影响。
ALLOW_MITM_PROXY = (os.environ.get("CHECKIN_ALLOW_MITM_PROXY") or "").strip().lower() in (
    "1",
    "true",
    "yes",
)


def is_camoufox():
    return ENGINE != "cloakbrowser"


def ev_script(script):
    """Camoufox 的 page.evaluate 默认跑在**隔离世界**，看不到页面主世界的变量。

    这是与 CloakBrowser 最容易踩的差异：不加前缀时 `window.turnstile` 恒为
    undefined（实测 api.js 明明 302→200 加载成功、script 也触发了 onload），
    于是 render 抛 "window.turnstile is undefined"，表现得像 api.js 没加载。
    加 "mw:" 前缀 + launch 时 main_world_eval=True 才会在主世界求值。
    实测确认：mw: 支持传参（单值/数组）、跨调用共享 window 状态、支持 async fetch。
    """
    return f"mw:{script}" if is_camoufox() else script


def patch_main_world(page):
    """让 page.evaluate / page.wait_for_function 默认在主世界求值。

    为什么用包装而不是给每个调用点手加 "mw:"：签到流程里有二十多处 evaluate，
    逐个改前缀既容易漏（漏一处就是 window.turnstile undefined，且报错长得像
    api.js 没加载，极难定位），也让同一份脚本没法在两个引擎间切换。
    这里统一在入口处补前缀，所有既有调用点保持原样。

    只包装 Camoufox；CloakBrowser 原样返回。
    """
    if not is_camoufox():
        return page

    orig_eval = page.evaluate
    orig_wait = page.wait_for_function

    def with_prefix(script):
        # 已经带前缀的不要重复加
        if isinstance(script, str) and not script.startswith("mw:"):
            return f"mw:{script}"
        return script

    async def evaluate(script, arg=None, **kw):
        return await orig_eval(with_prefix(script), arg, **kw)

    async def wait_for_function(script, arg=None, **kw):
        return await orig_wait(with_prefix(script), arg, **kw)

    page.evaluate = evaluate
    page.wait_for_function = wait_for_function
    return page


@contextlib.asynccontextmanager
async def browser_page(proxy=None, window=(1366, 768)):
    """开一个浏览器并交出一个 page，退出时保证关闭。

    proxy 传字符串（socks5://host:port 或 http://user:pass@host:port）；
    两个引擎的代理格式不同，这里统一转换：
      camoufox      Playwright dict {"server","username","password"}
      cloakbrowser  字符串，且 SOCKS 必须先剥掉凭证（Chromium 不支持 SOCKS 认证）
    """
    if is_camoufox():
        from camoufox.async_api import AsyncCamoufox

        opts = {
            # 有头才拿得到 token（见 HEADLESS 注释）。GHA 上用 'virtual'，
            # Camoufox 自己拉 Xvfb，workflow 不用再套 xvfb-run。
            "headless": "virtual" if (not HEADLESS and IN_CI) else HEADLESS,
            # 传数值而不是 True：True 时 Camoufox 对光标移动时长不设上限（文档说
            # "typically up to 1.5 seconds"）。等 token 的循环每轮都要 mouse.move，
            # 45 轮就被拉到 20 分钟以上，2026-09-11 的 GHA run 因此撞上 30 分钟
            # job 超时被 cancel。0.5s 足够保留拟人轨迹，又让单轮开销可预期。
            "humanize": HUMANIZE_MAX_S,
            # 见 ev_script()：不开这个，主世界的 window.turnstile 取不到
            "main_world_eval": True,
            # 官方文档明确写着用于「让跨域 iframe 里的 Turnstile 勾选框可点击」
            "disable_coop": True,
            "window": window,
            "i_know_what_im_doing": True,
        }
        if CAMOUFOX_EXECUTABLE:
            opts["executable_path"] = CAMOUFOX_EXECUTABLE
        if proxy:
            opts["proxy"] = camoufox_proxy(proxy)
            # 按代理出口 IP 推地理位置/时区，避免「德州 IP + 上海时区」这种矛盾指纹。
            #
            # 不能无条件用 geoip=True：Camoufox 的 public_ip() 硬编码 verify=True，
            # 经 MITM 代理时证书校验失败 → launch 直接抛 InvalidIP，浏览器都开不起来。
            # 所以放行 MITM 的场合自己查 IP（不校验证书）再把字符串传进去；
            # 实在查不到就干脆不传 geoip —— 指纹一致性打点折扣，但至少能跑起来。
            if ALLOW_MITM_PROXY:
                ip = proxy_exit_ip(proxy)
                if ip:
                    opts["geoip"] = ip
                    log(f"  🌐 代理出口 IP {ip}（自查，用于 geoip）")
                else:
                    log("  ⚠️ 查不到代理出口 IP，本次不传 geoip（时区/地理可能与出口 IP 矛盾）")
            else:
                opts["geoip"] = True
        async with AsyncCamoufox(**opts) as browser:
            # 不要显式传 viewport：beta.29 + Playwright≥1.61 会 Protocol error
            # (Browser.setDefaultViewport)，而 Camoufox 本就按指纹生成 screen。
            # ignore_https_errors 只在显式允许 MITM 代理时才开：那种代理递自签证书，
            # 不忽略就连页面都打不开（ERR_CERT_AUTHORITY_INVALID）。
            page = await browser.new_page(
                ignore_https_errors=bool(proxy and ALLOW_MITM_PROXY)
            )
            yield patch_main_world(page)
        return

    from cloakbrowser import launch_async

    browser = await launch_async(
        headless=HEADLESS,
        humanize=True,
        proxy=proxy_url_for_browser(proxy) if proxy else None,
        args=list(BROWSER_ARGS),
    )
    try:
        context = await browser.new_context(
            viewport={"width": window[0], "height": window[1]},
            user_agent=UA,
            # MITM 代理递的是自签证书，不忽略就直接 ERR_CERT_AUTHORITY_INVALID 打不开页面
            ignore_https_errors=bool(proxy and ALLOW_MITM_PROXY),
        )
        yield await context.new_page()
    finally:
        try:
            await browser.close()
        except Exception:  # noqa: BLE001
            pass


def camoufox_proxy(url):
    """字符串代理 → Playwright proxy dict。

    Playwright 驱动对 socks5+凭证是硬拦（见 ENGINE 注释），所以 SOCKS 一律只传
    server、丢掉凭证——反正带上就是 launch 直接抛错。http(s) 保留凭证走 Basic 认证。
    """
    scheme, cred, host, port = split_proxy(url)
    server = f"{scheme}://{host}:{port}" if port else f"{scheme}://{host}"
    if scheme.startswith("socks") or not cred:
        return {"server": server}
    user, _, pwd = cred.partition(":")
    return {"server": server, "username": user, "password": pwd}

# 一个渠道最多换几个代理重试。代理都是慢的（实测 2-8s RTT），每次尝试含 45s
# 等 token，试太多会把 job 拖到超时；3 个足够覆盖「个别代理临时挂掉」。
MAX_PROXY_TRIES = 3
# 只有「疑似出口 IP 导致」的失败才值得换代理重试。凭证缺失/表单找不到这类
# 换出口也一样失败，重试纯属浪费 45s。
RETRYABLE_VIA_PROXY = re.compile(
    r"Turnstile|token 为空|超时|timeout|挂载失败|ERR_|拒绝|blocked|403|\b5\d\d\b|challenge",
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


def _proxy_tunnel_socket(host, port, proxy=None, timeout=15):
    """建一条到 host:port 的裸 TCP 隧道；proxy 为 None 时直连。

    从 _peer_cert_sha256 里抽出来的公共部分：取证书指纹和查代理出口 IP 都需要
    「先按代理协议握手、再自己接管这条 socket」。两处的 CONNECT 逻辑必须完全一致，
    否则一个能连另一个连不上，就会把「代理挂了」误判成「代理在解密 TLS」。

    返回已连通的 socket（TLS 还没做，调用方自己 wrap）。
    """
    import socket as _socket
    import ssl as _ssl

    if not proxy:
        return _socket.create_connection((host, port), timeout=timeout)

    scheme, cred, phost, pport = split_proxy(proxy)
    raw = _socket.create_connection((phost, int(pport or 1080)), timeout=timeout)
    try:
        if scheme in ("http", "https"):
            # https 代理要先对代理这一跳做 TLS，否则 Basic 凭证明文过网
            if scheme == "https":
                pctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
                pctx.check_hostname = False
                pctx.verify_mode = _ssl.CERT_NONE
                raw = pctx.wrap_socket(raw, server_hostname=phost)
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
    return raw


def _peer_cert_sha256(host, port, proxy=None, timeout=15):
    """取目标站 TLS 证书的 SHA-256 指纹；proxy 为 None 时直连。

    故意用 verify_mode=NONE：我们要的是「看到对方递了什么证书」，
    而不是「证书是否可信」——不关校验就拿不到 MITM 代理伪造的那张证书。
    """
    import hashlib
    import ssl as _ssl

    ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = _ssl.CERT_NONE

    raw = _proxy_tunnel_socket(host, port, proxy=proxy, timeout=timeout)
    try:
        with ctx.wrap_socket(raw, server_hostname=host) as ss:
            return hashlib.sha256(ss.getpeercert(binary_form=True)).hexdigest()
    finally:
        try:
            raw.close()
        except Exception:  # noqa: BLE001
            pass


def proxy_exit_ip(proxy, timeout=15):
    """查代理的出口 IP；查不到返回 None。

    为什么不能用 Camoufox 自带的 geoip=True：它内部 public_ip()（camoufox/ip.py）
    对 6 个查询地址全是 HTTPS 且**硬编码 verify=True**，经 MITM 代理时证书校验必然
    失败，于是 launch 阶段直接抛 InvalidIP「Failed to get IP address」，整个渠道连
    浏览器都开不起来（2026-09-15 实测就是这么挂的）。

    这里自己查、不校验证书，再把 IP 字符串交给 geoip 参数 —— camoufox/utils.py
    只在 `geoip is True` 时才自己去查，传字符串就跳过那一步。
    """
    import re as _re
    import ssl as _ssl

    ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = _ssl.CERT_NONE
    for host in ("api.ipify.org", "checkip.amazonaws.com", "icanhazip.com"):
        raw = None
        try:
            raw = _proxy_tunnel_socket(host, 443, proxy=proxy, timeout=timeout)
            with ctx.wrap_socket(raw, server_hostname=host) as ss:
                ss.sendall(
                    f"GET / HTTP/1.1\r\nHost: {host}\r\n"
                    f"User-Agent: {UA}\r\nConnection: close\r\n\r\n".encode()
                )
                buf = b""
                while len(buf) < 8192:
                    chunk = ss.recv(2048)
                    if not chunk:
                        break
                    buf += chunk
            # 正文可能是 chunked（大小前缀是十六进制，不会被下面的正则误认成 IP）
            body = buf.split(b"\r\n\r\n", 1)[-1].decode(errors="replace")
            m = _re.search(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", body)
            if m:
                return m.group(1)
        except Exception:  # noqa: BLE001
            continue
        finally:
            if raw is not None:
                try:
                    raw.close()
                except Exception:  # noqa: BLE001
                    pass
    return None


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


ALREADY_RE = re.compile(r"已签到|重复签到|重复领取|重复打卡|already", re.I)


def is_already_checked_in(body):
    """服务端是不是在说「今天已经签过了」。

    NewAPI 变体常把它表达成 success:false +「请勿重复签到」，那不是失败。
    判据与 src/adapters/newapi.js 对齐（/already|已签到|重复/i + data.checkin_date）。
    """
    if not isinstance(body, dict):
        return False
    if ALREADY_RE.search(str(body.get("message") or "")):
        return True
    data = body.get("data")
    if isinstance(data, dict):
        return bool(data.get("checkin_date") or data.get("already_checked_in") is True)
    return False


def checkin_ok(body, status):
    """签到是否算成功：HTTP 200，且满足以下任一条：
      · success 为真；
      · data.quota_awarded 非零 / data.checkin_date 有值 —— 变体站只回这个，没有 success 键；
      · 服务端在说「今天已经签过了」。

    判据与 src/adapters/newapi.js 的 normalizeCheckin() 对齐，免得同一个站点在 worker
    通道 ✅、浏览器通道 ❌。body 不是 dict（顶层数组 / 标量 / 空）一律当失败，免得
    AttributeError 逃逸成「异常: 'list' object has no attribute 'get'」这种读不出原因的文案。
    """
    if status != 200 or not isinstance(body, dict):
        return False
    if body.get("success"):
        return True
    data = body.get("data")
    if isinstance(data, dict) and (data.get("quota_awarded") or data.get("checkin_date")):
        return True
    return is_already_checked_in(body)


def checkin_message(ok, body, status):
    """拼出能自证的签到结论。

    NewAPI 成功时只回 message:"" 或 "success"，直接透传会让日志变成「渠道名：success」，
    看不出是真发了奖励还是只是请求通了。这里把奖励额度带出来。
    """
    body = body if isinstance(body, dict) else {}
    d = body.get("data") if isinstance(body.get("data"), dict) else {}
    srv = str(body.get("message") or "").strip()
    if not ok:
        return (srv or f"HTTP {status}")[:200]
    # 判据与 checkin_ok 共用：「请勿重复签到」这类回话也是「今天签过了」，不是失败
    already = is_already_checked_in(body)
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
      1. 浏览器打开 /login，从内嵌配置读 turnstile_site_key
      2. 页面内用该 sitekey 主动挂 Turnstile，拟人点击等 token
      3. 拿到 token 后页面内 fetch /api/v1/auth/login（带 turnstile_token），
         绕开前端表单校验
      4. 带 Bearer 在页面内 fetch /api/v1/check-in 真实签到
      5. 新 accessToken/refreshToken 回传 Worker 写回 KV
    """
    name = channel.get("name", "unnamed")
    base = channel["baseUrl"].rstrip("/")
    auth = channel.get("auth") or {}
    email = auth.get("email") or auth.get("username") or ""
    password = auth.get("password") or ""
    if not (email and password):
        return {"name": name, "ok": False, "message": "缺少邮箱/密码，无法走登录流程"}

    if proxy:
        log(f"  🌍 {name}: 走代理 {mask_proxy(proxy)}")
    stack = contextlib.AsyncExitStack()
    try:
        page = await stack.enter_async_context(browser_page(proxy))
        log(f"  🌐 {name}: 打开登录页 {base}/login（引擎 {ENGINE}）")
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
        started = time.monotonic()
        while time.monotonic() - started < NATIVE_WIDGET_BUDGET_S:
            await page.wait_for_timeout(2000)
            ts_token = await page.evaluate(
                "() => { const h = document.querySelector('[name=cf-turnstile-response]'); return h && h.value ? h.value : null; }"
            )
            if ts_token:
                log(
                    f"  🎉 {name}: 原生 widget 第 {int(time.monotonic() - started)}s "
                    f"出 token（len {len(ts_token)}）"
                )
                break
            await click_challenge(page, x_offset=30)
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
            log(f"  ⏳ {name}: 等 Turnstile token（拟人点击，最长 {TOKEN_WAIT_S}s）...")
            deadline = time.monotonic() + TOKEN_WAIT_S
            while time.monotonic() < deadline:
                await page.wait_for_timeout(1000)
                ts_token = await page.evaluate("() => window._tsToken")
                if ts_token:
                    break
                await click_challenge(page)
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
            await stack.aclose()
        except Exception:  # noqa: BLE001
            pass


async def inpage_checkin(page, token, ts_token):
    """页面内 fetch /api/user/checkin，返回 {status, body}。

    ts_token 为 None 时不带 turnstile 参数 —— 站点两段式流程的第一枪就是这么发的，
    同时也是「服务端是否真强制 Turnstile」的探针。
    """
    auth = json.dumps({"Authorization": f"Bearer {token}"} if token else {})
    return await page.evaluate(
        """async ([ts, headersJs]) => {
            const url = '/api/user/checkin' + (ts ? '?turnstile=' + encodeURIComponent(ts) : '');
            const res = await fetch(url, {
                method: 'POST', credentials: 'include', headers: JSON.parse(headersJs || '{}'),
            });
            let body = null; try { body = await res.json(); } catch (e) {}
            return { status: res.status, body };
        }""",
        [ts_token, auth],
    )


async def attach_quota(page, result, token):
    """顺手把余额写进 result["quotaInfo"]（失败不影响签到结果）。

    提成公共函数是因为「探针命中」那条成功路径也要回余额 —— 它原本直接 return，
    面板就少一项额度（src/index.js 会合并 quotaInfo）。
    """
    try:
        headers_js = json.dumps({"Authorization": f"Bearer {token}"} if token else {})
        # 必须设上限：/api/user/self 在慢代理上若卡住，会把一次**已经成功**的签到
        # 拖到 CHANNEL_BUDGET_S 超时，报成 ❌「超时」并再触发换代理重试。
        me = await asyncio.wait_for(
            page.evaluate(
                """async (headersJs) => {
                    const res = await fetch('/api/user/self', {
                        credentials: 'include', headers: JSON.parse(headersJs || '{}'),
                    });
                    let b = null; try { b = await res.json(); } catch(e) {}
                    return b && b.data ? b.data : null;
                }""",
                headers_js,
            ),
            timeout=15,
        )
        if isinstance(me, dict) and me.get("quota") is not None:
            result["quotaInfo"] = {
                "quota": me.get("quota"),
                "usedQuota": me.get("used_quota"),
                "quotaPerUnit": 500000,
                "account": me.get("display_name") or me.get("username") or "",
            }
    except Exception as e:  # noqa: BLE001
        # 静默会让「余额拿不到」完全无迹可查；签到结果不受影响，但日志要留一句
        log(f"  ⚠️ 取余额失败（不影响签到结果）: {str(e)[:80]}")


async def click_site_checkin(page):
    """点站点自己的签到控件，把「人点签到」这个动作原样重放一遍。

    为什么非点不可：站点那个 Turnstile widget 是**它自己的前端**在「自己那次请求被拒」
    之后才渲染的（实测流程：点签到 → 弹「Turnstile token 为空」的 toast → 才出现人机
    验证 → 通过后签到成功）。widget 的渲染挂在站点前端的组件状态上，而我们绕开前端
    直接 fetch 的那一枪，站点前端并不知道，所以它未必会挂 widget —— 光靠空 token
    POST 去"钓"它，可能等满 40s 也等不到。

    点它自己的按钮就没有这个问题：站点前端会自己走完两段式流程，顺带把它自己的
    widget 挂出来，我们再从那个 widget 收 token（见 wait_any_token 的 native 来源）。

    找不到按钮不算错误（有的站首页没有签到卡片）：返回 {"found": False}，调用方照旧往下走。
    """
    hit = await page.evaluate(
        """() => {
            const WANT = /签到|check\\s*-?\\s*in/i;
            // 只排除「显示状态」的元素（已签/已领、明日、连续、记录、历史、日历）。
            // 故意不排除「奖励」：未签到状态下的按钮常写成「签到领奖励」，排掉就永远点不到。
            const NEG = /已签|已领|签到成功|明日|明天|连续|记录|历史|日历/;
            const away = (el) => {
                if (el.tagName !== 'A') return false;
                const raw = el.getAttribute('href') || '';
                // javascript:/# 之类不是真的跳转，按本页处理；只看 http(s) 的目标路径
                if (!/^https?:/i.test(raw) && raw !== '') return false;
                try { return new URL(el.href, location.href).pathname !== location.pathname; }
                catch (e) { return false; }
            };
            const find = () => {
                const all = [...document.querySelectorAll('button,[role=button],a')];
                const ok = all.filter(el => {
                    const t = (el.innerText || el.textContent || '').trim();
                    if (!t || t.length > 12) return false;
                    if (NEG.test(t) || !WANT.test(t)) return false;
                    // 会跳到别的页面的链接直接不要：点它等于白跑一趟，还会把我们已经挂好的
                    // widget 和待收的 token 一起冲掉（页头一个叫「Check-in」的导航链接就是这种）。
                    if (away(el)) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && r.height <= 120;
                });
                // 真按钮优先于本页锚点
                const rank = el => (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') ? 0 : 1;
                ok.sort((a, b) => rank(a) - rank(b));
                return ok[0] || null;
            };
            window.__hubFindCheckin = find;
            const el = find();
            if (!el) return { found: false };
            el.scrollIntoView({ block: 'center' });
            return { found: true, text: (el.innerText || '').trim().slice(0, 20) };
        }"""
    )
    if not hit.get("found"):
        return {"found": False, "why": "页面上没有匹配的签到控件"}
    # 等滚动/布局落定后再取坐标，并做一次命中自检：elementFromPoint 必须落在候选元素
    # （或其后代）上。滚动过程中取的旧坐标在 smooth-scroll / sticky 头的站点上会点到别处，
    # 而 page.mouse.click 是裸坐标点击，不做任何 actionability 校验。
    await page.wait_for_timeout(400)
    pos = await page.evaluate(
        """() => {
            const el = window.__hubFindCheckin && window.__hubFindCheckin();
            if (!el) return { ok: false, why: 'element-gone' };
            const r = el.getBoundingClientRect();
            const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
            const at = document.elementFromPoint(cx, cy);
            if (!at || !(at === el || el.contains(at) || at.contains(el)))
                return { ok: false, why: 'hit-test:' + (at ? at.tagName : 'null') };
            return { ok: true, x: cx, y: cy };
        }"""
    )
    if not pos.get("ok"):
        return {"found": False, "why": pos.get("why") or "坐标自检失败", "text": hit.get("text")}
    # 拟人点击（Camoufox 的 humanize 会接管 mouse.move 的轨迹）
    await page.mouse.move(pos["x"], pos["y"], steps=5)
    await page.mouse.click(pos["x"], pos["y"])
    return {"found": True, "text": hit.get("text")}


async def inpage_checkin_status(page, token, tz="Asia/Shanghai"):
    """GET /api/user/checkin?month=YYYY-MM —— 签到的权威状态（照 worker 侧同一套做法）。

    为什么非有不可：Turnstile token 是**一次性**的。我们点了站点自己的签到按钮之后，
    站点前端和我们在抢同一个 token —— 它先 POST 就把 token 消费掉了，我们那一枪必然报
    「校验失败」，可奖励其实已经发下来了。光看 POST 的回话分不清这两种，只有状态查询能定论。
    """
    auth = json.dumps({"Authorization": f"Bearer {token}"} if token else {})
    # 必须设上限：状态查询悬挂会把这枪很可能已经发奖的尝试拖成 ❌「超时」，而「超时」
    # 又匹配 RETRYABLE_VIA_PROXY，接着白烧一轮代理。超时按「不知道」处理（返回 None）。
    return await asyncio.wait_for(
        page.evaluate(
            """async ([headersJs, tz]) => {
                const fmt = new Intl.DateTimeFormat('en-CA', {
                    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
                });
                const ymd = fmt.format(new Date());
                const r = await fetch('/api/user/checkin?month=' + encodeURIComponent(ymd.slice(0, 7)), {
                    credentials: 'include', headers: JSON.parse(headersJs || '{}'),
                });
                let b = null; try { b = await r.json(); } catch (e) {}
                // 与 newapi.js 的 normalizeStatus 一致：data 缺失时退回 payload 自身
                const d = (b && (b.data || b)) || {};
                const stats = d.stats || d;
                const rec = (stats.records || d.records || d.checkins || [])
                    .find(x => (x.checkin_date || x.check_in_date) === ymd);
                return {
                    httpStatus: r.status,
                    ok: r.status < 400 && !(b && b.success === false),
                    checkedInToday: !!(stats.checked_in_today ?? d.checked_in_today),
                    reward: rec ? (rec.quota_awarded ?? rec.quota ?? null) : null,
                    checkinCount: stats.checkin_count ?? stats.total_checkins ?? d.checkin_count ?? null,
                };
            }""",
            [auth, tz],
        ),
        timeout=STATUS_QUERY_TIMEOUT_S,
    )


async def confirm_checked_in(page, token, name, tz="Asia/Shanghai"):
    """「今天到底签没签」的权威答案：签了返回成功结果，没签返回 None（调用方照旧报失败）。"""
    try:
        st = await inpage_checkin_status(page, token, tz)
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠️ {name}: 签到状态查询失败 {str(e)[:80]}")
        return None
    # 只有「查询本身可信」才采信它：403/挑战页也会返回 checked_in_today 缺省 false，
    # 但那种情况属于查不到，绝不能拿它当结论。
    if not st.get("ok") or not st.get("checkedInToday"):
        return None
    money = quota_usd(st["reward"]) if st.get("reward") else None
    msg = "今日已签到（状态查询确认）" + (f"，今日奖励 {money}" if money else "")
    if st.get("checkinCount") is not None:
        msg += f"，本月 {st['checkinCount']} 次"
    # 这一步只做「查询到什么」，最终结论由 main() 统一打印（否则日志里 ✅ 会出现两次，
    # 读起来像签了两回）
    log(f"  🔎 {name}: 状态查询 → {msg}")
    return {"name": name, "ok": True, "message": msg[:300]}


async def wait_any_token(page, budget_s):
    """等一个可用的 Turnstile token，返回 (token, 来源)。来源是 'self' 或 'native'。

    两处都要收，只盯一处就会漏：
      self    我们自挂的组件写进 window._tsToken 的
      native  站点自身 widget 的隐藏域 [name=cf-turnstile-response]，它只在站点自己的
              两段式流程走到第二步时才出现（gorouter 就是这种）
    等待期间照旧拟人点击挑战 iframe。
    """
    deadline = time.monotonic() + budget_s
    while time.monotonic() < deadline:
        await page.wait_for_timeout(1000)
        tok = await page.evaluate(
            """() => {
                if (window._tsToken) return { t: window._tsToken, s: 'self' };
                const h = [...document.querySelectorAll('[name=cf-turnstile-response]')]
                    .find(el => el.value && !el.closest('#cf-turnstile-box'));
                return h && h.value ? { t: h.value, s: 'native' } : null;
            }"""
        )
        if tok:
            return tok.get("t"), tok.get("s")
        await click_challenge(page)
    return None, None


async def checkin_one(channel, proxy=None) -> dict:
    """单渠道：开浏览器 → Turnstile token → 页面内 fetch 签到。

    站点的两段式流程（gorouter / SeekAi 这类 NewAPI 变体）：前端**先不带 token POST
    一次 /api/user/checkin**，被拒（典型回话就是「Turnstile token 为空」）之后才惰性
    挂载 Turnstile widget，再带 token 重发。所以页面上平时看不到组件；也所以那句
    「为空」是站点对**空 token** 的固定话术，不能读成「我们的 token 无效」。
    同一现象在 HTTP 通道侧记录于 src/adapters/newapi.js 的 turnstileRejected()。

    proxy: 住宅 SOCKS5 出口（socks5://host:port，不能带凭证）。传入时整个
    浏览器的流量都走它——Turnstile 校验的是浏览器出口 IP，只有这样 CF 才肯
    签发挑战。
    """
    name = channel.get("name", "unnamed")
    base = channel["baseUrl"].rstrip("/")
    sitekey = (channel.get("options") or {}).get("turnstileSiteKey") or DEFAULT_SITEKEY
    auth = channel.get("auth") or {}
    cookie_raw = auth.get("cookie") or ""
    token = auth.get("token") or ""
    # 时区只影响状态查询里的 month= 与「当天奖励」的匹配（是否已签到由服务端标志决定），
    # 但跨月/跨日时按站点自己的时区算才不会串天。与 worker 侧取同一个选项。
    tz = (channel.get("options") or {}).get("timezone") or "Asia/Shanghai"
    if proxy:
        log(f"  🌍 {name}: 走代理 {mask_proxy(proxy)}")
    stack = contextlib.AsyncExitStack()
    try:
        page = await stack.enter_async_context(browser_page(proxy))
        # 直接开首页（kppq66 成功行为；绕道 /login 会触发登录页自己的 Turnstile 干扰挂载）
        log(f"  🌐 {name}: 打开 {base}（引擎 {ENGINE}）")
        wait_until, nav_ms = nav_opts(proxy)
        await page.goto(base + "/", wait_until=wait_until, timeout=nav_ms)
        await page.wait_for_timeout(PROXY_SETTLE_MS if proxy else 2000)
        pairs = parse_cookie_pairs(cookie_raw)
        if pairs:
            host = base.split("//", 1)[1].split("/", 1)[0]
            domain = host[4:] if host.startswith("www.") else host
            await page.context.add_cookies(
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
                            // 别让自挂组件往 DOM 注入同名的隐藏域：站点自身 widget 用的是
                            // 同一个字段名，混在一起就分不清 token 是谁的（native 来源会认错）。
                            'response-field': false,
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

        # 是否点过站点自己的签到按钮（两段式兜底里才会置 True），末尾据此标注来源
        clicked_site_button = False
        log(f"  ⏳ {name}: 等待 Turnstile token（拟人点击，最长 {TOKEN_WAIT_S}s）...")
        ts_token, ts_src = await wait_any_token(page, TOKEN_WAIT_S)
        if not ts_token:
            # 站点两段式流程的第一段：先不带 token POST 一次。这就是站点前端自己干的事
            # （见 checkin_one 文档字符串与 src/adapters/newapi.js 的 turnstileRejected）。
            # 一枪两用：① 站点若其实没强制 Turnstile，这一枪就是真签到；
            #          ② gorouter 这类站的前端正是**被这一枪拒掉之后**才惰性挂载 widget，
            #             所以自挂组件不出 token 时，可以借它这一挂拿站点自己的原生 token。
            log(f"  🧪 {name}: 自挂组件未出 token，按站点自身流程先空 token POST 一次 ...")
            pre = await inpage_checkin(page, token, None)
            pb = pre.get("body") if isinstance(pre.get("body"), dict) else {}
            pmsg = str(pb.get("message") or "")[:120]
            if checkin_ok(pb, pre.get("status")):
                # 站点其实没强制 Turnstile：这一枪就是真签到
                res = {
                    "name": name,
                    "ok": True,
                    "message": checkin_message(True, pb, pre.get("status")),
                }
                await attach_quota(page, res, token)
                return res
            log(f"  🧪 {name}: 空 token POST 被拒（{pmsg or str(pb)[:100]}）")
            if not re.search(r"turnstile|challenge|人机|校验|验证", pmsg + str(pb)[:200], re.I):
                # 与 Turnstile 无关的失败：站点不会因此挂 widget，别再白等几十秒。
                # 也显式标不可重试 —— 额度/凭证/风控类拒绝换出口没用，而每次尝试要烧
                # 45s+，重试三次会把 JOB_BUDGET_S 吃光（尾部渠道当天直接漏签）。
                # 文案仍写明「未取到 Turnstile token」，人读日志时知道卡在哪一步。
                return {
                    "name": name,
                    "ok": False,
                    "retryable": False,
                    "message": (
                        f"未取到 Turnstile token（自挂组件 {TOKEN_WAIT_S}s 无）；"
                        f"空 token 直签 HTTP {pre.get('status')}：{pmsg or str(pb)[:100]}"
                    )[:300],
                }
            # 先问一次权威状态再去折腾 widget：站点可能今天早就签过了（那它不会再挂
            # widget、按钮文案也变成「已签到」），光等 40s 只会白等并报一条假失败。
            done = await confirm_checked_in(page, token, name, tz)
            if done:
                await attach_quota(page, done, token)
                return done
            # 站点自己的 widget 是它前端在「自己那次请求被拒」之后才挂的，我们绕开前端
            # 发的那一枪站点前端并不知道 —— 所以把人的动作重放一遍：点它自己的签到按钮，
            # 让站点前端自己走完两段式流程并把 widget 挂出来。
            hit = await click_site_checkin(page)
            if hit.get("found"):
                clicked_site_button = True
                log(f"  🖱️ {name}: 已点站点自身签到按钮「{hit.get('text')}」，等它的前端挂 widget")
            else:
                log(f"  🖱️ {name}: 没点到签到按钮（{hit.get('why') or '页面上没有'}），只能继续等自挂组件的 token")
            # 给站点前端一点时间跑它自己那次请求 + 弹 toast + 渲染 widget
            await page.wait_for_timeout(2500)
            log(f"  ⏳ {name}: 等站点自己挂载的 widget 出 token（最长 {NATIVE_WIDGET_BUDGET_S}s）...")
            ts_token, ts_src = await wait_any_token(page, NATIVE_WIDGET_BUDGET_S)
            if not ts_token:
                # 两处都拿不到 token 时，先问权威状态再下结论：我们点过站点自己的按钮，
                # 站点前端很可能已经把签到做完了（它拿到 token 就自己 POST 了）。
                done = await confirm_checked_in(page, token, name, tz)
                if done:
                    await attach_quota(page, done, token)
                    return done
                # 写清这条失败的性质：空 token POST 的回话是**站点对空 token 的固定话术**，
                # 不是「我们的 token 被拒」。旧日志把这句话原样透传，读起来像是盾没过或
                # token 无效，很容易把人带去查 token / 换代理。带上 _tsError 保留 CF 错误码。
                err = await page.evaluate("() => window._tsError")
                return {
                    "name": name,
                    "ok": False,
                    "message": (
                        f"未取到 Turnstile token（自挂组件 {TOKEN_WAIT_S}s + 站点自身 widget "
                        f"{NATIVE_WIDGET_BUDGET_S}s 均无，_tsError={err}）；"
                        f"空 token POST 回话为站点固定话术：{pmsg or str(pb)[:80]}"
                    )[:300],
                }

        log(f"  🎉 {name}: 拿到 token（来源 {ts_src}，长度 {len(ts_token)}），页面内签到...")
        checkin = await inpage_checkin(page, token, ts_token)
        body = checkin.get("body") if isinstance(checkin.get("body"), dict) else {}
        ok = checkin_ok(body, checkin.get("status"))
        result = {
            "name": name,
            "ok": ok,
            "message": checkin_message(ok, body, checkin.get("status")),
        }
        if ts_src == "native":
            result["message"] = f"{result['message']}（token 来自站点自身 widget）"[:300]
        if clicked_site_button and "已签到" in result["message"]:
            # 我们点过它自己的按钮：站点前端很可能已经自己把签到做了，服务端于是回「已签到」。
            # 不标出来的话这条会读成「今天早就签过了、没发奖励」，正好与事实相反。
            result["message"] = f"{result['message']}（本次由站点自身按钮触发）"[:300]
        if not ok:
            st_code = checkin.get("status")
            raw = json.dumps(body, ensure_ascii=False)
            # 与上面探针那一枪用同一套词：站点把拒绝写成「人机验证失败」这类时也算
            turnstile_said = bool(re.search(r"turnstile|challenge|人机|校验|验证", raw, re.I))
            # POST 可能压根没到应用层：CF 直接拦成 HTML/403，此时 body 是空的
            cf_blocked = st_code in (403, 429) or (isinstance(st_code, int) and st_code >= 500)
            if turnstile_said or cf_blocked or clicked_site_button:
                # token 是一次性的，而站点前端和我们在抢同一个：点过它自己的按钮之后，
                # 它先 POST 就把 token 消费掉了，我们这一枪必然报校验失败 —— 奖励其实已经发了。
                # 所以先问权威状态，能定论就按成功算，别报一条「站点已经签到成功」的假失败。
                done = await confirm_checked_in(page, token, name, tz)
                if done:
                    await attach_quota(page, done, token)
                    return done
            if turnstile_said and st_code == 200:
                # 服务端在**应用层**拒了这次 token（不是 CF 层拦截），才写这句说明
                result["message"] = (
                    f"{result['message']} · 注：本次已带 turnstile token（来源 {ts_src}，"
                    f"长度 {len(ts_token)}），服务端仍报 Turnstile 问题 → 是这次 token 未被接受"
                )[:300]
                # token 已经发出去了，换出口解决不了；标不可重试，别把 job 预算烧在重试上
                result["retryable"] = False
            elif cf_blocked:
                # CF 层拦截是出口 IP 的问题，换代理**可能**有效，所以不标不可重试
                result["message"] = (
                    f"{result['message']} · 注：HTTP {st_code}，疑似 Cloudflare 层拦截"
                    f"（本次已带 turnstile token，来源 {ts_src}）"
                )[:300]

        await attach_quota(page, result, token)
        return result
    finally:
        await stack.aclose()


def load_api_fallback_names():
    """gha_api job 的失败渠道清单（降级链最后一级的重试对象）。"""
    path = os.environ.get("API_FALLBACK_LIST") or "api-artifact/gha-fallback.json"
    try:
        with open(path, encoding="utf-8") as f:
            names = json.load(f)
        return [str(n) for n in names if n]
    except Exception:  # noqa: BLE001
        return []


def requested_names():
    """本次 dispatch 指定的渠道名（Worker 的 client_payload.names）。

    api job（gha-checkin.mjs）早就按 names 精确执行了，browser job 之前一直漏掉
    这一层，只按 runner 过滤 —— 于是「只重试 A」的 dispatch 会把该通道所有渠道
    全跑一遍。这正是 commit 0785599 在 api 侧修掉的同一个 bug。
    """
    raw = (os.environ.get("CHECKIN_NAMES") or "").strip()
    if not raw:
        return None
    try:
        names = json.loads(raw) if raw.startswith("[") else raw.split(",")
    except Exception:  # noqa: BLE001
        names = raw.split(",")
    out = [str(n).strip() for n in names if str(n).strip()]
    return out or None


async def main():
    if not HUB:
        raise SystemExit("缺少 HUB_BASE_URL")
    channels = fetch_browser_channels()
    # 指定了 names 就精确选渠道：既避免「重试一个渠道却全通道重跑」，
    # 也让降级链把非 gha_browser 的渠道显式交给本 job 处理。
    only = requested_names()
    if only:
        wanted = set(only)
        picked = [c for c in channels if c["name"] in wanted]
        missing = wanted - {c["name"] for c in picked}
        if missing:
            # 降级链场景：渠道本身配的是 worker/gha_api，但被指名要浏览器兜底
            for ch in fetch_all_channels():
                if ch["name"] in missing:
                    picked.append(ch)
        channels = picked
        log(f"指定渠道 {len(only)} 个: {only} → 匹配 {len(channels)} 个")
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
                if ALLOW_MITM_PROXY:
                    # 显式开关下照用。日志写足：事后要能查出「哪个渠道的凭证在哪个
                    # 出口上暴露过」，否则这个开关就成了无痕的后门。
                    safe.append(p)
                    log(
                        f"  ⚠️ 仍使用 {mask_proxy(p)}：{reason}"
                        "——CHECKIN_ALLOW_MITM_PROXY 已开启，本次凭证会明文经过代理"
                        "运营方，跑完请更换该渠道的密码/访问令牌"
                    )
                    if len(safe) >= MAX_PROXY_TRIES:
                        break
                else:
                    log(f"  🚨 拒用 {mask_proxy(p)}：{reason}——凭证会泄露给代理运营方")
            else:
                # 连不上/探测失败的代理，开关也救不了，照旧跳过
                log(f"  ⏭️ 跳过 {mask_proxy(p)}：{reason}")
        if not safe:
            log("⚠️ 代理池中没有一个可用，本次只能直连（Turnstile 站预期拿不到 token）")
        else:
            log(
                f"可用代理 {len(safe)} 个"
                + ("（含解密 TLS 的，已按开关放行）" if ALLOW_MITM_PROXY else "（均通过 TLS 校验）")
            )
    else:
        log("代理池为空，仅直连（Turnstile 站可能拿不到 token）")

    attempts = [None] + safe

    results = []
    # 整个 job 的墙钟预算。超了就不再开新渠道，直接把已有结果回传 ——
    # 被 GHA 按 timeout-minutes 掐死的话 report_results() 根本不会执行，
    # 面板上那个渠道会一直停在「已触发」，比拿到一条失败记录更难排查。
    job_deadline = time.monotonic() + JOB_BUDGET_S
    for ch in channels:
        name = ch.get("name", "?")
        r = None
        if time.monotonic() > job_deadline:
            log(f"  ⏭️ {name}: job 时间预算用尽，跳过（未执行）")
            results.append({"name": name, "ok": False, "message": "job 时间预算用尽，本次未执行"})
            continue
        for i, proxy in enumerate(attempts):
            via = "直连" if proxy is None else f"代理 {mask_proxy(proxy)}"
            if i:
                if time.monotonic() > job_deadline:
                    log(f"  ⏹️ {name}: job 预算用尽，停止重试")
                    break
                log(f"  🔁 {name}: 换 {via} 重试（第 {i} 次）")
            try:
                # 单次尝试也要有硬上限：里面每一步都各自有超时，但「每步都刚好不超时」
                # 累加起来仍能拖很久（首次 GHA 跑就是这样撞上 30 分钟 job 上限被
                # cancelled）。这里兜一层，超时就当失败换下一个出口。
                coro = (
                    sub2api_login_checkin(ch, proxy=proxy)
                    if ch.get("type") == "sub2api"
                    else checkin_one(ch, proxy=proxy)
                )
                r = await asyncio.wait_for(coro, timeout=CHANNEL_BUDGET_S)
            except asyncio.TimeoutError:
                r = {
                    "name": name,
                    "ok": False,
                    "message": f"{via}超时（单次尝试超过 {CHANNEL_BUDGET_S}s 预算）",
                }
            except Exception as e:  # noqa: BLE001
                r = {"name": name, "ok": False, "message": f"{via}异常: {str(e)[:120]}"}
            if r.get("ok"):
                if i:
                    r["message"] = f"{r.get('message', '')}（经{via}）"
                break
            # 结果里显式标了不可重试的直接停：这类失败换出口也解决不了，而每次尝试要烧
            # 45s+40s，重试三次足以把 JOB_BUDGET_S 吃光，尾部渠道当天就漏签了。
            if r.get("retryable") is False:
                log(f"  ⏹️ {name}: 该失败换出口无效，不再重试")
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
