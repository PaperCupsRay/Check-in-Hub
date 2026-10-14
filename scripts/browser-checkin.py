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
import contextlib
import datetime
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
# reCAPTCHA 渠道的墙钟预算：点按钮 + 等勾选框出现 + 反复点 + 轮询权威状态。
# 比 TOKEN_WAIT_S 长，因为 reCAPTCHA 要等站点前端把 widget 渲染出来（可能好几秒），
# 而且勾选框还可能被前端重建，得反复点。
RECAPTCHA_BUDGET_S = int(os.environ.get("CHECKIN_RECAPTCHA_BUDGET_S") or 90)
# 轮询等站点自己的签到按钮出现。必须给得比 SPA 首屏+状态查询宽裕：按钮在状态
# 查询返回前显示「加载中...」（见 recaptcha_site_ui_checkin 的注释）。
SITE_BTN_WAIT_S = int(os.environ.get("CHECKIN_SITE_BTN_WAIT_S") or 30)
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
async def https_proxy_relay(proxy):
    """把 https:// 上游代理包成一个本地**明文** http 代理，产出 http://127.0.0.1:<port>。

    为什么必须有这一层：这批开放 https 代理自己的证书全都不可信（证书里的名字与
    代理 IP 不匹配，或签发者未知）。而 Firefox 对**代理那一跳**的证书错误不提供任何
    绕过手段 —— ignore_https_errors 只作用于页面，代理握手失败照样 SEC_ERROR_UNKNOWN
    （2026-09-15 实测：开关开与不开，报的是同一个错）。

    于是由我们自己完成到上游的 TLS：
        浏览器 → 本地明文 http 代理（回环）→ 我们做 TLS → 上游 https 代理 → 目标站
    浏览器只看到一个普通的 http 代理，不参与上游那一跳的证书判断。

    安全性不因此打折：防 MITM 的闸门是 proxy_is_safe() 的证书指纹比对，它比的是
    **目标站**的证书，与代理这一跳自己的证书可信度是两件事。上游若在解密 TLS，
    目标站指纹照样对不上，照样会被拒用。
    """
    scheme, cred, phost, pport = split_proxy(proxy)
    pport = int(pport or 443)

    async def handle(reader, writer):
        up_w = None
        try:
            # 浏览器发来的第一行是 CONNECT host:port（https 目标）或 GET http://...
            head = await reader.readuntil(b"\r\n\r\n")
            # 上游代理的证书不可信（这正是要中继的原因），这里刻意不校验
            up_r, up_w = await asyncio.open_connection(
                phost, pport, ssl=_tls_ctx(), server_hostname=phost
            )
            if cred:
                import base64

                # 浏览器不知道上游要认证，凭证由我们补进去
                basic = base64.b64encode(cred.encode()).decode()
                head = head[:-2] + f"Proxy-Authorization: Basic {basic}\r\n\r\n".encode()
            up_w.write(head)
            await up_w.drain()

            async def pump(r, w):
                try:
                    while True:
                        chunk = await r.read(65536)
                        if not chunk:
                            break
                        w.write(chunk)
                        await w.drain()
                except Exception:  # noqa: BLE001
                    pass
                finally:
                    try:
                        w.close()
                    except Exception:  # noqa: BLE001
                        pass

            await asyncio.gather(pump(reader, up_w), pump(up_r, writer))
        except Exception:  # noqa: BLE001
            # 单条连接失败不该拖垮整个中继：浏览器开很多条连接，坏一条它会自己重试
            for w in (writer, up_w):
                if w is None:
                    continue
                try:
                    w.close()
                except Exception:  # noqa: BLE001
                    pass

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.close()
        try:
            await server.wait_closed()
        except Exception:  # noqa: BLE001
            pass


@contextlib.asynccontextmanager
async def browser_page(proxy=None, window=(1366, 768)):
    """开浏览器并交出 page；https:// 代理先经本地中继（见 https_proxy_relay）。

    中继对下游是完全透明的：出口 IP 自查、geoip、页面流量都照原样走，
    只是浏览器看到的是 http://127.0.0.1:<port> 而不是那个证书不可信的上游。
    """
    if proxy and split_proxy(proxy)[0] == "https":
        async with https_proxy_relay(proxy) as local:
            log(f"  🔀 {mask_proxy(proxy)} 经本地中继（浏览器不信任该代理自己的证书）")
            # geoip 查询要走**上游**代理，不能走中继：proxy_exit_ip() 是同步阻塞的，
            # 经中继就等于在事件循环里等自己（中继 accept 不到连接），必然超时。
            async with _browser_page_raw(local, window, geoip_proxy=proxy) as page:
                yield page
        return
    async with _browser_page_raw(proxy, window) as page:
        yield page


@contextlib.asynccontextmanager
async def _browser_page_raw(proxy=None, window=(1366, 768), geoip_proxy=None):
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
            # 出口 IP 一律自己查，不用 geoip=True。Camoufox 的 public_ip()
            # （camoufox/ip.py）用 requests 且硬编码 verify=True，对我们这两类代理
            # 都会失败，而失败是在 launch 阶段抛 InvalidIP —— 浏览器根本开不起来：
            #   MITM 代理     证书校验过不去（2026-09-15 实测 gorouter1 挂在这）
            #   https:// 代理  requests 不做 TLS-in-TLS，报 Unable to connect to proxy
            # proxy_exit_ip() 自己搬密文、不校验证书，这两类都能查（见 _TlsInTls）。
            # 实在查不到就干脆不传 geoip —— 指纹一致性打点折扣，但至少能跑起来，
            # 比 launch 直接崩掉强。
            # 必须放线程：这是同步阻塞调用，直接 await 不了。走 https 中继时事件循环
            # 正在跑那个中继 server，在循环里同步阻塞会让中继永远 accept 不到连接 ——
            # 症状是 IP 查不到（耗满重试）+ 随后导航超时（2026-09-15 实测踩过）。
            ip = await asyncio.to_thread(proxy_exit_ip, geoip_proxy or proxy)
            if ip:
                opts["geoip"] = ip
                log(f"  🌐 代理出口 IP {ip}（自查，用于 geoip）")
            else:
                log("  ⚠️ 查不到代理出口 IP，本次不传 geoip（时区/地理可能与出口 IP 矛盾）")
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
        # 面板测过的：连通的排前面，同为连通的按延迟升序；没测过的排中间。
        #
        # certUntrusted 不算「测失败」：那只是面板（Worker）校验不了代理自己的
        # TLS 证书 —— Workers 的 socket 不支持跳过校验。而我们这边自己做 TLS、
        # 根本不看那张证书（见 https_proxy_relay），所以它对我们照样可用。
        # 按「未测过」排，别让面板测一遍就把真正能用的 https 代理压到最后。
        if chk.get("ok"):
            tier = 0
        elif chk.get("ok") is None or chk.get("certUntrusted"):
            tier = 1
        else:
            tier = 2
        rank = (tier, chk.get("ms") or 9999)
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


def _tls_ctx():
    """不校验证书的 TLS 上下文。

    故意用 verify_mode=NONE：我们要的是「看到对方递了什么证书」，而不是
    「证书是否可信」——不关校验就拿不到 MITM 代理伪造的那张证书。
    """
    import ssl as _ssl

    ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = _ssl.CERT_NONE
    return ctx


class _TlsInTls:
    """在一条已经是 TLS 的连接上再套一层 TLS（https 代理的 CONNECT 隧道）。

    为什么非要这个类：ssl.SSLContext.wrap_socket **不能**套在 SSLSocket 上。
    它直接拿底层 fd 收发，会绕过外层 TLS，把内层 ClientHello 明文发给代理。
    2026-09-15 实测症状：7 个 https 代理全报 INVALID_ALERT / UNEXPECTED_MESSAGE，
    被 proxy_is_safe() 记成「TLS 探测失败」而全部跳过 —— 看起来像代理都挂了，
    其实它们的 CONNECT 全都正常返回 200 Connection Established。

    内层因此必须走 SSLObject + MemoryBIO：加解密只在内存里做，密文由我们自己
    通过外层连接搬运。
    """

    def __init__(self, transport, server_hostname, ctx):
        import ssl as _ssl

        self._t = transport
        self._incoming = _ssl.MemoryBIO()
        self._outgoing = _ssl.MemoryBIO()
        self._obj = ctx.wrap_bio(
            self._incoming, self._outgoing, server_hostname=server_hostname
        )
        self._handshake()

    def _push(self):
        """把内层攒下的密文经外层发出去。"""
        data = self._outgoing.read()
        if data:
            self._t.sendall(data)

    def _pull(self):
        """从外层读一段密文喂给内层；对端关闭时写 EOF。"""
        chunk = self._t.recv(16384)
        if chunk:
            self._incoming.write(chunk)
        else:
            self._incoming.write_eof()

    def _handshake(self):
        import ssl as _ssl

        while True:
            try:
                self._obj.do_handshake()
                self._push()
                return
            except _ssl.SSLWantReadError:
                # 握手要来回好几轮：每轮先把自己要说的发出去，再等对方的回应
                self._push()
                self._pull()

    def getpeercert(self, binary_form=False):
        return self._obj.getpeercert(binary_form)

    def sendall(self, data):
        self._obj.write(data)
        self._push()

    def recv(self, size=16384):
        import ssl as _ssl

        while True:
            try:
                return self._obj.read(size)
            except _ssl.SSLWantReadError:
                self._push()
                try:
                    self._pull()
                except OSError:
                    return b""
            except (_ssl.SSLZeroReturnError, _ssl.SSLEOFError):
                # 对端正常关闭：按「读到末尾」处理，交给调用方结束循环
                return b""

    def close(self):
        try:
            self._t.close()
        except Exception:  # noqa: BLE001
            pass


def _tls_wrap(transport, host, ctx):
    """给隧道套上**目标站**的 TLS。

    普通 socket 走 wrap_socket 快路径；https 代理交回来的是 SSLSocket，
    必须走 MemoryBIO（原因见 _TlsInTls 的说明）。
    """
    import ssl as _ssl

    if isinstance(transport, _ssl.SSLSocket):
        return _TlsInTls(transport, host, ctx)
    return ctx.wrap_socket(transport, server_hostname=host)


def _close_all(*socks):
    for sock in socks:
        if sock is None:
            continue
        try:
            sock.close()
        except Exception:  # noqa: BLE001
            pass


def _peer_cert_sha256(host, port, proxy=None, timeout=15):
    """取目标站 TLS 证书的 SHA-256 指纹；proxy 为 None 时直连。"""
    import hashlib

    raw = _proxy_tunnel_socket(host, port, proxy=proxy, timeout=timeout)
    ss = None
    try:
        ss = _tls_wrap(raw, host, _tls_ctx())
        return hashlib.sha256(ss.getpeercert(binary_form=True)).hexdigest()
    finally:
        _close_all(ss, raw)


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

    ctx = _tls_ctx()
    for host in ("api.ipify.org", "checkip.amazonaws.com", "icanhazip.com"):
        raw = None
        ss = None
        try:
            raw = _proxy_tunnel_socket(host, 443, proxy=proxy, timeout=timeout)
            ss = _tls_wrap(raw, host, ctx)
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
            _close_all(ss, raw)
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

    只认两种证据：服务端**话里**说了（ALREADY_RE，词表与 src/adapters/newapi.js 的
    normalizeCheckin 逐字一致），或明确给了 already_checked_in:true 这个布尔标志。

    绝不能把 data.checkin_date 当证据 —— 签到**成功**的回话里本来就带这个字段
    （2026-09-15 实测 gorouter：message="签到成功" + data.checkin_date 齐全）。
    旧版拿它当判据，于是全新签到也被判成「今日已签到（未重复发放）」，
    checkin_message() 走 already 分支把真实奖励额度吞掉，日志里看不出到底发没发钱。

    移掉这一条不会把成功误判成失败：checkin_ok() 自己单独看 quota_awarded /
    checkin_date，成功判定不经过本函数这一路。
    """
    if not isinstance(body, dict):
        return False
    if ALREADY_RE.search(str(body.get("message") or "")):
        return True
    data = body.get("data")
    return isinstance(data, dict) and data.get("already_checked_in") is True


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


def auth_headers_js(token):
    """页内 fetch 用的凭证头（只给 Bearer）。

    New-Api-User 故意不在这里拼：它是 NewAPI 系的强制头，而它的值就是
    localStorage.user.id —— 我们进页面时已经写好了。所以由下面各处的 JS 在
    页面里自己补（JSFUNC_MERGE_AUTH），跟站点前端发请求的方式一致，也省得给
    每个函数加 user_id 参数。
    """
    return json.dumps({"Authorization": f"Bearer {token}"} if token else {})


# 页内合并凭证头：Bearer 由 Python 侧给，New-Api-User 从 localStorage.user.id 取。
# 没有 id 就保持原样（cookie 模式的站不受影响）。
JSFUNC_MERGE_AUTH = """
            const __h = JSON.parse(headersJs || '{}');
            try {
                const __u = JSON.parse(localStorage.getItem('user') || 'null');
                if (__u && __u.id != null) __h['New-Api-User'] = String(__u.id);
            } catch (e) {}
"""


async def seed_localstorage_auth(page, token, user_id):
    """把凭证写进 localStorage，让 NewAPI 系的前端**渲染成已登录**。

    为什么非写不可：/console/personal 这类页面靠 localStorage 判登录态，没登录就
    把我们甩到登录页，签到控件根本不存在（2026-09-27 星见雅线上就是这么失败的，
    报「没找到签到控件」）。

    为什么必须写 **id**：前端判登录读的是 localStorage.user，而 New-Api-User 请求头
    就是从 user.id 取的（站点 bundle 实测）。旧写法只写 {token} 没有 id，前端照样
    判定未登录。注意这跟「没配 Cookie」无关：星见雅那条 server_name_session 早已
    401（实测 Unauthorized, not logged in），而 access token 一直有效，是白送的路。
    """
    if not (token or user_id):
        return
    await page.evaluate(
        """([t, uid]) => { try {
             if (t) localStorage.setItem('token', t);
             const prev = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null') || {}; } catch (e) { return {}; } })();
             const id = uid != null && uid !== '' ? Number(uid) : prev.id;
             localStorage.setItem('user', JSON.stringify({
               ...prev,
               ...(t ? { token: t } : {}),
               ...(id != null && !Number.isNaN(id) ? { id } : {}),
             }));
           } catch(e) {} }""",
        [token, user_id],
    )

async def login_for_session(page, name, base, username, password, user_id=""):
    """在页面内用账密登录，换一个真正的 NewAPI session cookie。

    为什么走**页面内 fetch** 而不是 Python 侧发请求：session 是 HttpOnly 的，
    服务端在登录响应里下发、由浏览器 cookie jar 接住。Python 侧拿到 Set-Cookie
    还要手工 add_cookies 回去，中间漏一个属性就可能又一轮 401（2026-09-27 实测：
    同一份 session 手工拼头一次 401、一次 200，差别只在 cookie 处理方式）。
    交给页面内 fetch 就没有这类差异。

    顺带取回 userId：登录响应的 data.id 就是它，而 New-Api-User 头在部分接口是
    强制的（new.xinjianya.top 实测缺头会 401）。

    返回 {"session": bool, "cookie": str, "userId": str, "why": str}。
    失败不抛异常 —— 由调用方决定继续用原 cookie 还是报错。
    """
    try:
        got = await page.evaluate(
            """async ([u, p, uid]) => {
                const hdr = uid ? { 'New-Api-User': String(uid) } : {};
                const send = async (body) => {
                    const r = await fetch('/api/user/login', {
                        method: 'POST', credentials: 'include',
                        headers: { 'Content-Type': 'application/json', ...hdr },
                        body: JSON.stringify(body),
                    });
                    let b = null; try { b = await r.json(); } catch (e) {}
                    return { status: r.status, body: b };
                };
                // 与 src/adapters/newapi.js 的 login() 同一组尝试顺序：
                // 多数分支只认 username，少数只认 email。
                let r = await send({ username: u, password: p });
                if (r.status >= 400 || !(r.body && (r.body.success === true || r.body.data))) {
                    r = await send({ email: u, password: p });
                }
                const d = (r.body && r.body.data) || {};
                return {
                    ok: r.status < 400 && !!(r.body && (r.body.success === true || r.body.data)),
                    message: (r.body && r.body.message) || ('HTTP ' + r.status),
                    id: d.id || null,
                };
            }""",
            [username, password, user_id],
        )
    except Exception as e:  # noqa: BLE001
        return {"session": False, "why": f"页面内登录异常 {str(e)[:80]}"}

    if not got.get("ok"):
        return {"session": False, "why": f"登录被拒：{got.get('message') or '未知'}"}

    try:
        jar = await page.context.cookies()
    except Exception:  # noqa: BLE001
        jar = []
    host = base.split("//", 1)[1].split("/", 1)[0].split(":", 1)[0]
    bare = host[4:] if host.startswith("www.") else host
    mine = [c for c in jar if c.get("domain", "").lstrip(".") in (host, bare)]
    names = [c["name"] for c in mine]
    session = [c for c in mine if c["name"] == "session" and c.get("value")]
    if not session:
        return {"session": False, "why": f"登录成功但未收到 session cookie（现有：{names or '无'}）"}
    cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in mine)
    log(f"  🔑 {name}: 账密登录换到 session（{len(session[0]['value'])} 字符），cookie 栏现有 {names}")
    return {
        "session": True,
        "cookie": cookie_str,
        "userId": str(got.get("id") or user_id or ""),
        "why": "",
    }



async def inpage_checkin(page, token, ts_token):
    """页面内 fetch /api/user/checkin，返回 {status, body}。

    ts_token 为 None 时不带 turnstile 参数 —— 站点两段式流程的第一枪就是这么发的，
    同时也是「服务端是否真强制 Turnstile」的探针。
    """
    auth = auth_headers_js(token)
    return await page.evaluate(
        ("""async ([ts, headersJs]) => {
            MERGE_AUTH
            const url = '/api/user/checkin' + (ts ? '?turnstile=' + encodeURIComponent(ts) : '');
            const res = await fetch(url, {
                method: 'POST', credentials: 'include', headers: __h,
            });
            let body = null; try { body = await res.json(); } catch (e) {}
            return { status: res.status, body };
        }""").replace("MERGE_AUTH", JSFUNC_MERGE_AUTH),
        [ts_token, auth],
    )


async def attach_quota(page, result, token):
    """顺手把余额写进 result["quotaInfo"]（失败不影响签到结果）。

    提成公共函数是因为「探针命中」那条成功路径也要回余额 —— 它原本直接 return，
    面板就少一项额度（src/index.js 会合并 quotaInfo）。
    """
    try:
        headers_js = auth_headers_js(token)
        # 必须设上限：/api/user/self 在慢代理上若卡住，会把一次**已经成功**的签到
        # 拖到 CHANNEL_BUDGET_S 超时，报成 ❌「超时」并再触发换代理重试。
        me = await asyncio.wait_for(
            page.evaluate(
                ("""async (headersJs) => {
                    MERGE_AUTH
                    const res = await fetch('/api/user/self', {
                        credentials: 'include', headers: __h,
                    });
                    let b = null; try { b = await res.json(); } catch(e) {}
                    return b && b.data ? b.data : null;
                }""").replace("MERGE_AUTH", JSFUNC_MERGE_AUTH),
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


async def page_diag(page, limit=400):
    """抓一份页面快照，失败时写进 message。

    没有它，「没找到签到控件」没法定位：可能是 Cookie 失效被跳登录页、可能 SPA
    还没渲染完、也可能按钮文案变了，只能靠猜。2026-09-27 线上失败就是因为这句
    日志什么信息都没有，才多绕了一轮。
    """
    try:
        d = await page.evaluate(
            """() => ({
                title: document.title,
                url: location.href,
                buttons: [...document.querySelectorAll('button,[role=button],a')]
                    .map(b => (b.innerText || b.textContent || '').trim())
                    .filter(Boolean).slice(0, 20),
                body: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 240) : '',
            })"""
        )
        return json.dumps(d, ensure_ascii=False)[:limit]
    except Exception as e:  # noqa: BLE001
        return f"诊断失败:{str(e)[:80]}"


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
    auth = auth_headers_js(token)
    # 必须设上限：状态查询悬挂会把这枪很可能已经发奖的尝试拖成 ❌「超时」，而「超时」
    # 又匹配 RETRYABLE_VIA_PROXY，接着白烧一轮代理。超时按「不知道」处理（返回 None）。
    return await asyncio.wait_for(
        page.evaluate(
            ("""async ([headersJs, tz]) => {
                MERGE_AUTH
                const fmt = new Intl.DateTimeFormat('en-CA', {
                    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
                });
                const ymd = fmt.format(new Date());
                const r = await fetch('/api/user/checkin?month=' + encodeURIComponent(ymd.slice(0, 7)), {
                    credentials: 'include', headers: __h,
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
            }""").replace("MERGE_AUTH", JSFUNC_MERGE_AUTH),
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


# ---------------------------------------------------------------------------
# Google reCAPTCHA v2 渠道（new.xinjianya.top 等）
# ---------------------------------------------------------------------------


async def detect_recaptcha(page):
    """页面上有没有 reCAPTCHA 的痕迹，返回来源标记（'' 表示没有）。

    判据刻意与 Turnstile 不同：Turnstile 拿到 sitekey 就能自挂组件解题，而
    reCAPTCHA v2 的 token 与**渲染它的那个页面**强绑定（服务端校验 origin），
    自挂 widget 拿到的 token 会被判低分。所以这里只做**识别**，真正的解法一律走
    「驱动站点自己的 UI」（recaptcha_site_ui_checkin）。

    判据必须**强**，否则会误伤既有渠道：大量站点为了登录/注册就会加载 reCAPTCHA 的
    api.js 并挂出 window.grecaptcha 全局，但它们的**签到接口根本不需要** token。
    实测踩过：早先用「有 window.grecaptcha / 有 api.js 脚本」当判据，一个完全不含
    reCAPTCHA 的普通页面也被判成 reCAPTCHA 站（window.grecaptcha 在同文档替换后
    依然残留），于是所有渠道都被带去 UI 驱动分支。

    所以只认两条硬证据：
      iframe     页面上真的**渲染出了**勾选框（reCAPTCHA 的 api2/anchor，或 hCaptcha 的
                 hcaptcha.html#frame=checkbox）—— 这也正是 click_captcha_checkbox
                 唯一能点的对象；
      api/status 服务端自己声明了对应的开关与 site_key。
    两者都拿不到就返回空串，交给后面的流程（探针回话点名验证码时仍会兜底分流）。

    2026-09-27 补 hCaptcha：星见雅当天把 checkin_recaptcha_check 关掉、
    checkin_hcaptcha_check 打开（/api/status 可证），而站点的 recaptcha_site_key 与
    /recaptcha/api.js **仍然留着**。所以判据里 hCaptcha 优先，且必须同时看开关
    （*_site_key 常年留在配置里，不能当作「该站用它」的证据）。
    """
    hit = await page.evaluate(
        """async () => {
            const frames = [...document.querySelectorAll('iframe')].map(el => el.src || '');
            if (frames.some(s => s.includes('/recaptcha/api2/'))) return 'recaptcha-iframe';
            if (frames.some(s => s.includes('hcaptcha.com') && s.includes('frame=checkbox')))
                return 'hcaptcha-iframe';
            try {
                const r = await fetch('/api/status', { credentials: 'include' });
                const j = await r.json().catch(() => null);
                const d = (j && j.data) || {};
                if (d.checkin_hcaptcha_check || d.hcaptcha_check) return 'hcaptcha';
                if (d.checkin_recaptcha_check || d.recaptcha_check) return 'recaptcha';
                if (d.recaptcha_site_key || d.recaptcha_sitekey) return 'api/status';
            } catch (e) {}
            return '';
        }"""
    )
    return hit or ""


async def click_captcha_checkbox(page):
    """点验证码勾选框（reCAPTCHA v2 与 hCaptcha v2 都支持），返回点到的次数。

    2026-09-27 之前这里只认 reCAPTCHA 的 api2/anchor。星见雅换成 hCaptcha 之后，
    它的勾选框在 newassets.hcaptcha.com/.../hcaptcha.html#frame=checkbox 里，
    于是这个循环一次都匹配不上 —— 线上表现就是「勾选框 90s 内未完成（共点了 0 次）」。

    两种勾选框都在**跨域 iframe** 内，主世界拿不到 DOM，但 frame.evaluate() 可以在
    iframe 自己的上下文里量到元素，比盲点偏移准。2026-09-27 用 hCaptcha 官方测试
    密钥实测：checkbox iframe 302x76，内部 #checkbox 元素 {x:16, y:23, w:30, h:30}。
    量不到时才退回按框尺寸估算（勾选框在左侧约 30px、垂直居中）。

    异常一律忽略：站点前端可能随时重建 widget，这一轮拿不到是常态，下一轮重试。
    """
    hits = 0
    for f in page.frames:
        url = f.url or ""
        if "/recaptcha/api2/anchor" not in url and not (
            "hcaptcha.com" in url and "frame=checkbox" in url
        ):
            continue
        try:
            inner = await f.evaluate(
                """() => {
                    const el = document.querySelector('#checkbox') || document.querySelector('.check');
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return (r.width > 0 && r.height > 0)
                        ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
                }"""
            )
            el = await f.frame_element()
            box = await el.bounding_box()
            if not box or box["width"] <= 0 or box["height"] <= 0:
                continue
            if inner:
                x, y = box["x"] + inner["x"], box["y"] + inner["y"]
            else:
                x, y = box["x"] + 30, box["y"] + box["height"] / 2
            await page.mouse.move(x, y, steps=5)
            await page.mouse.click(x, y)
            hits += 1
        except Exception:  # noqa: BLE001
            continue
    return hits


async def selfmounted_captcha_checkin(page, name, base, token, tz="Asia/Shanghai", why=""):
    """站点 UI 点不到时的回退：自己挂一个验证码组件，拿到 token 自己提交签到。

    什么时候会走到这里：站点的 /console/personal 挂了，签到按钮压根不渲染。
    2026-09-27 实测星见雅就是这个形态 —— ErrorBoundary 把正文换成
    「页面渲染出错，请刷新页面重试」（站点前端 TypeError 崩在渲染「每日签到」卡片时）。
    但**接口是好的**：GET 状态查询正常、POST 签到只差一个验证码 token。所以页面崩
    不影响我们走接口这条路 —— 这也正是不能一看到「没找到控件」就判死的原因。

    与自挂 Turnstile 的差别（踩过的坑，别改回去）：
    · sitekey 取 /api/status 的 hcaptcha_site_key / recaptcha_site_key，并按
      checkin_hcaptcha_check / checkin_recaptcha_check 判断**用哪个**。不能只看
      site_key 是否存在 —— 星见雅 recaptcha 已关但 recaptcha_site_key 仍留着。
    · 提交的参数名跟着开关走：hCaptcha 站是 ?hcaptcha=，reCAPTCHA 站是 ?recaptcha=
      （站点 bundle 拼 URLSearchParams 就是这么拼的）。
    · 勾选框点法沿用 click_captcha_checkbox（它已同时认两家的 iframe）。
    """
    # 读 /api/status 时**必须区分三种结果**：拿到配置 / 站点不可达（5xx、521、
    # 非 JSON）/ 拿到了但没有验证码字段。2026-09-27 线上报的「reCAPTCHA 站但
    # /api/status 没给出 sitekey」就是把这三种混成了第一种：当时整站 521/502，
    # fetch 回来的不是 JSON，于是 st 变成 {}，被误报成「站点没配置验证码」——
    # 而真相是站点宕机，重试和改配置都没用。
    st = None
    st_err = ""
    try:
        st = await page.evaluate(
            """async () => {
                try {
                    const r = await fetch('/api/status', { credentials: 'include' });
                    const txt = await r.text();
                    if (!r.ok) return { __err: 'HTTP ' + r.status, __head: txt.slice(0, 60) };
                    const j = JSON.parse(txt);
                    if (!j || !j.data) return { __err: '响应里没有 data 字段' };
                    return j.data;
                } catch (e) { return { __err: String(e).slice(0, 80) }; }
            }"""
        )
        if isinstance(st, dict) and st.get("__err"):
            st_err = str(st.get("__err") or "")
            st = None
    except Exception as e:  # noqa: BLE001
        st_err = str(e)[:80]

    if st is None:
        # 站点侧不可达。标成可重试 —— 宕机是暂时的，换出口/改配置都无意义。
        log(f"  ⚠️ {name}: /api/status 读不出来（{st_err}），站点可能不可达")
        return {
            "name": name,
            "ok": False,
            "retryable": True,
            "message": (
                f"站点不可达：/api/status 返回异常（{st_err}）。"
                "这是站点自身宕机或网络不通，与验证码配置无关，等站点恢复即可。"
                f"（why={why or '无'}）"
            )[:300],
        }

    use_hc = bool(st.get("checkin_hcaptcha_check") or st.get("hcaptcha_check"))
    sitekey = (st.get("hcaptcha_site_key") if use_hc else st.get("recaptcha_site_key")) or ""
    param = "hcaptcha" if use_hc else "recaptcha"
    vendor = "hCaptcha" if use_hc else "reCAPTCHA"
    if not sitekey:
        return {
            "name": name,
            "ok": False,
            "retryable": False,
            "message": (
                f"/api/status 可达但没有验证码 sitekey（{vendor} 开关="
                f"{use_hc}，why={why or '无'}）。可能站点刚关掉了该校验，"
                "或改用了别家验证码；可直接再点一次签到验证"
            )[:300],
        }
    log(f"  🔑 {name}: 自挂 {vendor} 组件，sitekey={sitekey[:16]}… 提交参数 ?{param}=")

    # 挂我们自己的 widget。#self-rc 与站点的分开，且 response-field 关掉 ——
    # 否则我们注入的隐藏域会和站点自己的同名、抢 token。
    RENDER_JS = """(sk, isHc) => {
        const api = isHc ? window.hcaptcha : window.grecaptcha;
        if (!api || typeof api.render !== 'function')
            return { ok: false, why: (isHc ? 'window.hcaptcha' : 'window.grecaptcha') + ' 不可用' };
        window.__capToken = null; window.__capErr = null;
        let box = document.getElementById('self-rc');
        if (!box) {
            box = document.createElement('div');
            box.id = 'self-rc';
            box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;width:303px;height:78px';
            document.body.appendChild(box);
        }
        try {
            api.render(box, {
                sitekey: sk,
                callback: (t) => { window.__capToken = t; },
                'error-callback': (e) => { window.__capErr = String(e); },
                'response-field': false,
            });
            return { ok: true };
        } catch (e) {
            return { ok: false, why: 'render 抛错: ' + ((e && e.message) || e) };
        }
    }"""

    # 动态注入 api.js。实测（2026-09-27）hCaptcha 对 createElement 注入的脚本**照样能用**，
    # 所以不需要改成静态 <script> 标签 —— 那样反而可能因为 async/defer 时序拿不到 render。
    INJECT_SDK_JS = """(isHc) => {
        if (isHc) {
            if (!document.querySelector('script[src*="hcaptcha.com/1/api.js"]')) {
                const s = document.createElement('script');
                s.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
                s.async = true; s.defer = true;
                document.head.appendChild(s);
            }
        } else if (!document.querySelector('script[src*="recaptcha/api.js"]')) {
            const s = document.createElement('script');
            s.src = 'https://www.google.com/recaptcha/api.js?render=explicit';
            s.async = true; s.defer = true;
            document.head.appendChild(s);
        }
    }"""

    mounted = await page.evaluate(RENDER_JS, [sitekey, use_hc])
    if not mounted.get("ok"):
        # 组件 API 还没就绪（api.js 是异步加载的）：把脚本挂上再等一轮
        await page.evaluate(INJECT_SDK_JS, [use_hc])
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            await page.wait_for_timeout(1000)
            mounted = await page.evaluate(RENDER_JS, [sitekey, use_hc])
            if mounted.get("ok"):
                break
    if not mounted.get("ok"):
        return {
            "name": name,
            "ok": False,
            "message": f"自挂 {vendor} 组件失败：{mounted.get('why') or '未知'}（why={why or '无'}）"[:300],
        }
    log(f"  🧩 {name}: 自挂组件已渲染，开始点勾选框")

    # 点勾选框 + 收 token。
    # 每轮都要**重新确认组件还在** —— 2026-09-27 实测踩过：站点页面崩在 ErrorBoundary
    # 上，SPA 会重渲染 / 换路由，我们挂上去的 div 与 script 标签**当场被清掉**（实测
    # 一轮后 window.hcaptcha 已 undefined、#self-rc 不存在、script 列表为空）。只在
    # 开头挂一次的话，后面几十秒全在点空气：点击次数照涨，token 永远不来。
    deadline = time.monotonic() + RECAPTCHA_BUDGET_S
    clicks = 0
    cap = ""
    rebuilds = 0
    while time.monotonic() < deadline:
        await page.wait_for_timeout(1500)
        cap = await page.evaluate("() => window.__capToken || ''")
        if cap:
            break
        # 判活必须用 **page.frames**（跨世界可见），不能用 evaluate 查 window.hcaptcha：
        # Camoufox 的 evaluate 默认在隔离世界跑（见 patch_main_world / ev_script），
        # 那里读不到主世界的 window.hcaptcha，也读不到我们挂的 #self-rc —— 会误判成
        # 「一直活着」，于是永远不重建（2026-09-27 实测：重建 0 次但 div 其实已被清掉）。
        alive = any(
            ("hcaptcha.com" in (f.url or "") and "frame=checkbox" in (f.url or ""))
            or "/recaptcha/api2/anchor" in (f.url or "")
            for f in page.frames
        )
        if not alive:
            rebuilds += 1
            if rebuilds <= 3:
                log(f"  ♻️ 组件被页面重渲染清掉了，重新挂（第 {rebuilds} 次）")
            mounted = await page.evaluate(RENDER_JS, [sitekey, use_hc])
            if not mounted.get("ok"):
                # api.js 标签也一起没了，先补脚本再等一轮
                await page.evaluate(INJECT_SDK_JS, [use_hc])
                await page.wait_for_timeout(2500)
                mounted = await page.evaluate(RENDER_JS, [sitekey, use_hc])
            if not mounted.get("ok"):
                continue
        if await click_captcha_checkbox(page):
            clicks += 1
    if not cap:
        cap = await page.evaluate("() => window.__capToken || ''")
    if not cap:
        err = await page.evaluate("() => window.__capErr")
        return {
            "name": name,
            "ok": False,
            "message": (
                f"自挂 {vendor} 组件 {RECAPTCHA_BUDGET_S}s 内没出 token（点了 {clicks} 次、"
                f"重建 {rebuilds} 次，组件报错={err}）。重建次数>0 多半是站点页面在"
                "重渲染（ErrorBoundary）把组件清掉了；重建 0 次仍失败则多半是弹了"
                "图片题（该出口 IP 被判高风险，需要住宅代理）"
            )[:300],
        }
    log(f"  🔑 {name}: 拿到 {vendor} token（{len(cap)} 字符），自己提交签到")

    # 我们自己带 token POST，参数名跟着站点开关走
    res = await page.evaluate(
        """async ([p, tk, headersJs]) => {
            const __h = JSON.parse(headersJs || '{}');
            try {
                const u = JSON.parse(localStorage.getItem('user') || 'null');
                if (u && u.id != null) __h['New-Api-User'] = String(u.id);
            } catch (e) {}
            const r = await fetch('/api/user/checkin?' + p + '=' + encodeURIComponent(tk), {
                method: 'POST', credentials: 'include', headers: __h,
            });
            let b = null; try { b = await r.json(); } catch (e) {}
            return { status: r.status, body: b };
        }""",
        [param, cap, auth_headers_js(token)],
    )
    body = res.get("body") if isinstance(res.get("body"), dict) else {}
    ok = checkin_ok(body, res.get("status"))
    if not ok:
        # token 一次性，可能站点前端已经抢先签了 —— 状态查询才是权威
        done = await confirm_checked_in(page, token, name, tz)
        if done:
            done["message"] = f"{done['message']}（{vendor}：自挂组件提交）"[:300]
            await attach_quota(page, done, token)
            return done
        return {
            "name": name,
            "ok": False,
            "message": f"{checkin_message(ok, body, res.get('status'))}（{vendor}：自挂组件提交）"[:300],
        }
    result = {
        "name": name,
        "ok": True,
        "message": f"{checkin_message(ok, body, res.get('status'))}（{vendor}：自挂组件提交）"[:300],
    }
    await attach_quota(page, result, token)
    return result


async def recaptcha_site_ui_checkin(page, name, base, token, tz="Asia/Shanghai"):
    """用站点自己的 UI 过**人机验证码**完成签到（reCAPTCHA v2 与 hCaptcha v2 通用）。

    为什么不照抄 Turnstile 那套「自挂组件 + 我们自己带 token POST」：这类站的
    勾选框由**它自己的前端**渲染在 /console/personal 上，token 由站点前端取走
    再放进 query 提交。实测请求形态：
        POST /api/user/checkin?recaptcha=<2574 字符 token>   content-length: 0（无 body）
        POST /api/user/checkin?hcaptcha=<token>              hCaptcha 站是这个参数名
        头：new-api-user: <id> + Cookie，无 Authorization
    我们自挂 widget 的话，token 的 origin 与站点预期不一致会被判低分，而且参数名、
    提交时机全靠猜。所以全程不接触 token：

        打开站点页面 → 点它自己的签到按钮 → 点勾选框 → 轮询权威状态

    站点前端拿到 token 就自己 POST，签到由它完成。

    2026-09-27：星见雅从 reCAPTCHA 切到了 hCaptcha（/api/status 里
    checkin_recaptcha_check=false 而 checkin_hcaptcha_check=true，recaptcha_site_key
    却仍留着）。所以这里不能把「验证码」写死成某一家 —— 探测与点击都按页面实际
    渲染出来的 iframe 走（见 detect_recaptcha / click_captcha_checkbox）。
    """
    wait_until, nav_ms = nav_opts(None)
    personal = base + "/console/personal"
    log(f"  🌐 {name}: 打开 {personal}（站点 UI 驱动流程）")
    try:
        await page.goto(personal, wait_until=wait_until, timeout=nav_ms)
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠️ {name}: 打开个人页失败 {str(e)[:120]}")
    await page.wait_for_timeout(2500)

    # 先问权威状态：可能今天早就签过了 —— 那就不该再点按钮（点了也只会回「已签到」）
    done = await confirm_checked_in(page, token, name, tz)
    if done:
        await attach_quota(page, done, token)
        return done

    # 必须**轮询**等按钮，不能固定睡一觉就去找。
    # 星见雅（2026-09-27 实测 bundle）的签到按钮是 Semi 的 <Button>：
    #     children: I ? (stats.checked_in_today ? "今日已签到" : "立即签到") : "加载中..."
    #     loading:  f || !I
    # I 是「签到状态查询」的返回，状态没回来之前 children 就是「加载中...」，
    # 而 loading 态下 Semi 连 children 都不渲染 —— 按钮里根本没有「签到」两个字，
    # click_site_checkin 必然匹配不到。旧实现固定等 2.5s 就找，在 GHA + 住宅代理
    # 下 100% 扑空（2026-09-27 线上就是这么失败的）。
    hit = {"found": False, "why": ""}
    deadline = time.monotonic() + SITE_BTN_WAIT_S
    while time.monotonic() < deadline:
        hit = await click_site_checkin(page)
        if hit.get("found"):
            break
        await page.wait_for_timeout(1500)
    if not hit.get("found"):
        # 站点自己的按钮点不到时，**不要直接判死**。2026-09-27 实测：星见雅的
        # /console/personal 被 ErrorBoundary 接管，正文只剩「页面渲染出错，请刷新页面重试」
        # （站点前端 TypeError: Cannot read properties of undefined (reading 'length')，
        #  崩在渲染「每日签到」卡片时），于是按钮压根不存在。但**签到接口本身是好的**
        # ——只要我们自己挂一个验证码组件、拿到 token 自己提交就行，页面崩不崩无所谓。
        # 所以这里回退到自挂组件那条路。
        diag = await page_diag(page)
        if "/login" in diag or "登录" in diag:
            return {
                "name": name,
                "ok": False,
                "retryable": False,
                "message": (
                    f"验证码站：{personal} 被跳到登录页 —— 渠道 session 失效。"
                    "请确认渠道配了账密（会自动换 30 天有效的 session）。页面诊断 " + diag
                )[:400],
            }
        log(f"  ↩️ {name}: 点不到站点按钮（{hit.get('why') or '无匹配控件'}），改走自挂组件")
        return await selfmounted_captcha_checkin(page, name, base, token, tz, diag)

    log(f"  🖱️ {name}: 已点站点自身签到按钮「{hit.get('text')}」")
    log(f"  🖱️ {name}: 已点站点自身签到按钮「{hit.get('text')}」")

    # 站点前端接着弹**验证码**勾选框（reCAPTCHA / hCaptcha 都可能是）。勾选框可能
    # 延迟出现、也可能被前端重建，所以整个预算内反复「找勾选框 iframe → 点一下 →
    # 问一次权威状态」。
    # 所以整个预算内反复「找 anchor iframe → 点一下 → 问一次权威状态」。
    deadline = time.monotonic() + RECAPTCHA_BUDGET_S
    clicks = 0
    while time.monotonic() < deadline:
        await page.wait_for_timeout(1500)
        if await click_captcha_checkbox(page):
            clicks += 1
            log(f"  ☑️ {name}: 已点验证码勾选框（第 {clicks} 次）")
        # 勾完框站点前端才会去 POST；先给它一点时间，别在它提交前就下结论
        await page.wait_for_timeout(1500)
        done = await confirm_checked_in(page, token, name, tz)
        if done:
            done["message"] = f"{done['message']}（验证码：点站点按钮+勾选框完成）"[:300]
            await attach_quota(page, done, token)
            return done

    diag = await page.evaluate(
        """() => ({
            grecaptcha: typeof window.grecaptcha,
            hcaptcha: typeof window.hcaptcha,
            frames: [...document.querySelectorAll('iframe')]
                .map(f => f.src)
                .filter(s => s && (s.includes('recaptcha') || s.includes('hcaptcha'))),
            body: document.body ? document.body.innerText.slice(0, 160) : '',
        })"""
    )
    return {
        "name": name,
        "ok": False,
        "message": (
            f"验证码勾选框 {RECAPTCHA_BUDGET_S}s 内未完成（共点了 {clicks} 次）；"
            f"页面诊断 {json.dumps(diag, ensure_ascii=False)[:260]}"
        )[:300],
    }


async def checkin_one(channel, proxy=None) -> dict:
    """单渠道：开浏览器 → Turnstile token → 页面内 fetch 签到。

    站点的两段式流程（gorouter / SeekAi 这类 NewAPI 变体）：前端**先不带 token POST
    一次 /api/user/checkin**，被拒（典型回话就是「Turnstile token 为空」）之后才惰性
    挂载 Turnstile widget，再带 token 重发。所以页面上平时看不到组件；也所以那句
    「为空」是站点对**空 token** 的固定话术，不能读成「我们的 token 无效」。
    同一现象在 HTTP 通道侧记录于 src/adapters/newapi.js 的 turnstileRejected()。
    星见雅这类站走的是另一条分支：页面检出 reCAPTCHA v2 / hCaptcha v2 时分流到
    recaptcha_site_ui_checkin（点站点自己的按钮 + 点勾选框），因为它的 token 与
    渲染页面绑定、不能自挂组件代劳，详见那个函数的文档字符串。

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
    username = auth.get("username") or auth.get("email") or ""
    password = auth.get("password") or ""
    # New-Api-User 是 NewAPI 系的**强制**头：只带 Bearer 会 401
    # 「Unauthorized, New-Api-User header not provided」（new.xinjianya.top 实测）。
    # 页内 fetch 的头一律从 localStorage.user.id 取，见 auth_headers_js。
    user_id = str(auth.get("userId") or auth.get("newApiUser") or "").strip()
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
        # cookie 栏里若已经有真正的 NewAPI session（有 session=），直接用；
        # 否则**用账密换一个**。这不是多余的兜底：多租户托管面板常会下发
        # server_name_session 这种**租户路由** cookie（名字里 server_name 还是
        # 未替换的模板占位符），它连匿名请求都发、每次值都一样、不携带用户身份，
        # 带着它 /console/personal 会被甩到登录页（2026-09-27 星见雅线上实测）。
        # NewAPI 登录接口不需要人机验证（实测连登三次稳定拿到 360 字符 session，
        # Max-Age 30 天；错密码会明确拒绝），所以这是可靠的自动续期路径。
        if username and password and not re.search(r"(^|;\s*)session=", cookie_raw or "", re.I):
            fresh = await login_for_session(page, name, base, username, password, user_id)
            if fresh.get("session"):
                cookie_raw = fresh["cookie"] or cookie_raw
                user_id = user_id or fresh.get("userId") or ""
                if fresh.get("userId") and not user_id:
                    user_id = str(fresh["userId"])
            else:
                log(f"  ⚠️ {name}: 账密登录未换到 session（{fresh.get('why') or '未知'}），继续用原 cookie")
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

        await seed_localstorage_auth(page, token, user_id)

        # 站点用 Google reCAPTCHA 时必须在这里分流。下面的 Turnstile 流程会先自挂
        # 组件死等 TOKEN_WAIT_S(45s) 才去探针，而 reCAPTCHA 站上 Turnstile 组件永远
        # 不出 token —— 不分流的话每次都要白烧 45s 才轮得到真正的解法。
        # 渠道显式配了 recaptchaSiteKey 时直接采信，不再探测（探测只是兜底）。
        rc_hint = (channel.get("options") or {}).get("recaptchaSiteKey") or ""
        rc_seen = ""
        if not rc_hint:
            try:
                rc_seen = await detect_recaptcha(page)
            except Exception as e:  # noqa: BLE001
                log(f"  ⚠️ {name}: reCAPTCHA 探测异常 {str(e)[:100]}")
        if rc_hint or rc_seen:
            log(f"  🧩 {name}: 判定为 reCAPTCHA 站（{rc_seen or '渠道选项 recaptchaSiteKey'}），走站点 UI 驱动")
            return await recaptcha_site_ui_checkin(page, name, base, token, tz)

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
            # 兜底：前面的 detect_recaptcha 没认出这个站（首页无组件、/api/status 也没
            # 挂 key），但空 token POST 的回话点名了 recaptcha —— 仍然按 reCAPTCHA 站
            # 处理。不加这句的话它会掉进下面「与 Turnstile 无关」的分支被判成不可重试，
            # 当天直接漏签。
            if re.search(r"recaptcha|g-recaptcha", pmsg + str(pb)[:200], re.I):
                log(f"  🧩 {name}: 探针回话点名 reCAPTCHA，改走站点 UI 驱动")
                return await recaptcha_site_ui_checkin(page, name, base, token, tz)
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


# ---------------- 社区站：NodeSeek / linux.sb ----------------
#
# 这两站（连同 cookie 鉴权）全站挂在 Cloudflare 后面，而「把 cf_clearance 拷进渠道
# Cookie」这条常规解法对它们**无效**：cf_clearance 与签发它的出口 IP + UA 绑定，
# 用户浏览器里那一份拷到 Worker / GHA 的机房出口上直接判无效。2026-10-13 线上实测
# 两条出口全灭（三条事实，别再把 gha_api 当成这两站的解法）：
#   · NodeSeek：Worker 出口 302（CF 边缘的重定向）、Azure 出口 403 Just a moment
#   · linux.sb：Worker 出口 403 拦截页、Azure 出口 403 Just a moment
# 剩下的唯一路子就是真浏览器自己过挑战，再在**页面上下文里**完成签到：同源 fetch
# 天然带上 CF 放行 cookie，站点自己那套签名头（NodeSeek 的 refract-* 由 sw.js 生成）
# 也归它自己的前端管 —— 这正是 Turnstile 站已经在用的思路。
#
# 两站签到机制不同，各一支流程：
#   nodeseek：POST /api/attendance?random=true（JSON 信封，收益单位=鸡腿）
#   linuxsb ：打开页面时服务端顺手签到，提示写在 window.__pageFlash

FORUM_TYPES = {"nodeseek", "linuxsb"}

# CF 挑战页的标题。必须多语言：2026-10-13 线上实测某条代理出口拿到的是葡萄牙语
# 「Um momento…」，而只认英文 Just a moment 时会被判成「挑战已过」，紧接着的签到
# 请求就挨一记 403 挑战页 —— 现象看起来像「站点突然翻脸」，其实是识别漏了。
CF_TITLE_RE = re.compile(
    r"just a moment|attention required|verify you are human|checking your browser"
    r"|um momento|un momento|einen moment|einen augenblick|un instant|momento"
    r"|请稍候|检查您的浏览器|安全验证|正在验证",
    re.I,
)
# 挑战页的 DOM 特征（标题语种太多，靠 markup 兜底更稳）：CF 挑战页必定加载
# challenge-platform 那套脚本。别用裸 "cdn-cgi" 当判据 —— 正常页面上的
# Rocket Loader 也走 /cdn-cgi/scripts/…，那样会把好页面误判成挑战页。
CF_MARKUP_RE = re.compile(r"challenge-platform|cf_chl_|cdn-cgi/challenge", re.I)
CF_WAIT_JS = """() => {
    const title = document.title || '';
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    return { title, url: location.href, markup: html.slice(0, 30000) };
}"""
# 与 src/adapters/forum.js 的 ALREADY_RE 同一套词（两处判据必须一致，否则同一个
# 渠道在 worker 通道说「已签到」、在浏览器通道说「失败」）
ALREADY_SIGNED_RE = re.compile(r"已经?签到|已签过|重复签到|重复领取|重复打卡|already", re.I)


def looks_challenged(st):
    """页面是不是还停在 CF 挑战页上（多语言标题 + markup 兜底）。"""
    if CF_TITLE_RE.search(str(st.get("title") or "")):
        return True
    return bool(CF_MARKUP_RE.search(str(st.get("markup") or "")))


def forum_cookie_pairs(channel):
    return parse_cookie_pairs((channel.get("auth") or {}).get("cookie") or "")


async def apply_channel_cookies(page, channel):
    """把渠道 Cookie 注入浏览器，返回注入条数。

    必须在**首次导航之前**调用：linux.sb 的签到是「打开页面时服务端顺手做掉」，
    Cookie 晚一步就等于让站点按未登录处理，白跑一趟。checkin_one 那支是在两次
    导航之间注入的，顺序不能照抄。
    """
    pairs = forum_cookie_pairs(channel)
    if not pairs:
        return 0
    host = channel["baseUrl"].split("//", 1)[1].split("/", 1)[0]
    domain = host[4:] if host.startswith("www.") else host
    await page.context.add_cookies(
        [{"name": n, "value": v, "domain": domain, "path": "/"} for n, v in pairs]
    )
    return len(pairs)


async def wait_cloudflare(page, budget_s=30):
    """等 CF 挑战自己过去，必要时拟人点一下勾选框；挑战没过返回 None。

    调用方据此报一条**可换出口重试**的失败：消息里必须带 "Cloudflare" 与
    "challenge" 字样，否则 main() 的 RETRYABLE_VIA_PROXY 匹配不上，住宅代理
    那一轮重试根本不触发。
    """
    deadline = time.monotonic() + budget_s
    st = {"title": "", "url": "", "markup": ""}
    while time.monotonic() < deadline:
        try:
            st = await page.evaluate(CF_WAIT_JS)
        except Exception:  # noqa: BLE001
            st = {"title": "", "url": "", "markup": ""}
        # 标题为空 = 页面还没起来，继续等；有标题且不像挑战页才算过了
        if st.get("title") and not looks_challenged(st):
            return st
        await click_challenge(page)
        await page.wait_for_timeout(1000)
    return None


async def page_snapshot(page):
    """页面快照：标题 / URL / 登录线索 / 正文头部。

    失败时写进 message 才有得查 —— 否则「没签到」到底是 Cookie 失效被甩到登录页、
    还是页面结构变了，只能靠猜（page_diag 的文档字符串里已经记过一次这个坑）。

    登录线索必须给**完整的标签对**，不能只查类名：linux.sb 首页的「用户榜单」里也有
    .user-name，只匹配类名会把游客页认成登录页（2026-10-13 实测踩到）。
    """
    try:
        return await page.evaluate(
            """() => {
                const body = document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '';
                const html = document.documentElement ? document.documentElement.outerHTML : '';
                return {
                    title: document.title,
                    url: location.href,
                    // linux.sb：登录态才有的「每日签到」入口 + 侧栏用户卡片（完整标签对）
                    hasDailyCheckin: !!document.querySelector('a[href="/daily_checkin"]'),
                    userCard: /class="user-avatar-big"\\s+href="\\/user\\/\\d+"/.test(html),
                    userNameLink: /class="user-name"\\s+href="\\/user\\/\\d+"/.test(html),
                    // NodeSeek：游客页的签到入口写着「登录后签到」。必须查 innerText，
                    // 不能查 outerHTML —— 站点把「登录」和「后签到」分在两个标签里，
                    // 原始 HTML 里连不成一个词（2026-10-13 实测 guestHint 因此漏报）
                    guestHint: /登录后签到|登录后可见|请先登录/.test(body),
                    hasUserName: !!document.querySelector('.user-name'),
                    body: body.slice(0, 300),
                };
            }"""
        )
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:120]}


def forum_logged_in(snap):
    """linux.sb 的登录态判据：用户卡片或「每日签到」入口（完整标签对，见 page_snapshot）。"""
    return bool(snap.get("userCard") or snap.get("userNameLink") or snap.get("hasDailyCheckin"))


async def read_page_flash(page):
    """读 window.__pageFlash（linux.sb 的一次性提示）。主世界求值由 patch 统一处理。"""
    try:
        v = await page.evaluate(
            "() => (typeof window.__pageFlash === 'string' ? window.__pageFlash : '')"
        )
        return v if isinstance(v, str) else ""
    except Exception:  # noqa: BLE001
        return ""


def flash_points(text):
    m = re.search(r"\+?\s*(\d+(?:\.\d+)?)\s*(?:积分|分)", text or "")
    return float(m.group(1)) if m else None


def site_today(offset_hours=8):
    """站点时区的今天（YYYY-MM-DD）。linux.sb / NodeSeek 都是国内站点，按 UTC+8 算。"""
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=offset_hours)).strftime("%Y-%m-%d")


def today_patterns(ymd):
    y, m, d = ymd.split("-")
    return [ymd, f"{y}/{m}/{d}", f"{int(m)}月{int(d)}日", f"{m}-{d}", f"{m}/{d}"]


def checkin_record_evidence(html, ymd, span=200):
    """在「已签到 / 今日已签 / 已获得」附近找**今天的日期**；找到才算今日签到记录。

    不能只认关键词：2026-10-13 线上第一版就是只 match 关键词，结果从 /daily_checkin
    抓到「已签到 <div class」这么个片段 —— 页面别处也出现这个词，于是把「页面上有这
    个词」当成了「今天签过了」。要求命中处附近出现今天的日期，才有资格算证据；
    返回原文片段，写进 message 供事后核对（结论要能自证）。
    """
    for mark in re.finditer(r"(?:已签到|今日已签|签到完成|已获得)", html or ""):
        seg = html[max(0, mark.start() - span): mark.start() + span]
        if any(pat in seg for pat in today_patterns(ymd)):
            return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", seg)).strip()[:70]
    return ""




def today_signed_evidence(body_text):
    """linux.sb 的「今天已签到」措辞（站点用相对日期，不写具体日期）。

    2026-10-13 线上实测的 /daily_checkin 正文片段：
        `每日签到 今天已签到 19 连续天数 46 累计签到 已完成 PaperCups 积分 1309`
    所以判据是「相对日期 + 已签到」这个词组；裸「已签到」太松（页面别处也有），
    要求附近有具体日期又太紧（这一页根本不写日期）。返回原文片段供面板展示与核对。
    """
    m = re.search(r"(?:今天|今日)已签(?:到)?[^一-龥]{0,12}", body_text or "")
    return m.group(0).strip() if m else ""


def parse_stats_cookie(raw):
    """从 document.cookie 原文里解出签到统计：__daily_checkin_stats=<uid>.<date>.<count>.<points>.<rank>。

    date 是站点侧最后一次签到的日期，比「页面里有没有那个词」硬得多：它只在服务端
    真的处理完签到之后才会被改写。抽成同步函数是为了能离线跑
    scripts/test-forum-browser.py；字段数不对时只返回 raw（少一条证据，不改判据）。
    """
    m = re.search(r"__daily_checkin_stats=([^;]+)", str(raw or ""))
    if not m:
        return {"raw": None}
    parts = [p.strip() for p in m.group(1).split(".")]
    out = {"raw": m.group(1)}
    if len(parts) >= 2:
        out["uid"] = parts[0]
        out["date"] = parts[1]
    if len(parts) >= 4:
        try:
            out["points"] = float(parts[3])
        except ValueError:
            pass
    return out


async def read_stats_cookie(page):
    """读站点自己记的签到统计 cookie（解析见 parse_stats_cookie）。"""
    try:
        raw = await page.evaluate("() => document.cookie")
    except Exception:  # noqa: BLE001
        return {"raw": None}
    return parse_stats_cookie(raw)
    if not m:
        return {"raw": None}
    parts = [p.strip() for p in m.group(1).split(".")]
    out = {"raw": m.group(1)}
    if len(parts) >= 2:
        out["uid"] = parts[0]
        out["date"] = parts[1]
    if len(parts) >= 4:
        try:
            out["points"] = float(parts[3])
        except ValueError:
            pass
    return out


async def linuxsb_browser_checkin(channel, proxy=None) -> dict:
    """linux.sb：真浏览器过 CF → 打开首页（服务端顺手签到）→ 读 window.__pageFlash。

    判据与 src/adapters/linuxsb.js 完全一致，别另立一套：
      · flash 含「已帮您完成自动签到」= 刚签上，能带出 +N 积分
      · flash 为空且是登录态   = 今日已签过（HAR 里两次 GET / 都是空串）
      · 页面不是登录态         = Cookie 失效，让用户重抄（换出口无用，标不可重试）
    """
    name = channel.get("name", "unnamed")
    base = channel["baseUrl"].rstrip("/")
    opt = channel.get("options") or {}
    auto_gacha = str(opt.get("autoGacha", "")).strip().lower() in ("1", "true", "yes")
    if not forum_cookie_pairs(channel):
        return {"name": name, "ok": False, "retryable": False, "message": "缺少 Cookie，浏览器通道也签不了（Cookie 是这两站唯一的鉴权方式）"}
    if proxy:
        log(f"  🌍 {name}: 走代理 {mask_proxy(proxy)}")
    async with browser_page(proxy) as page:
        got = await apply_channel_cookies(page, channel)
        log(f"  🍪 {name}: 注入 {got} 个 cookie（必须在首次导航前，签到是打开页面时做的）")
        wait_until, nav_ms = nav_opts(proxy)
        log(f"  🌐 {name}: 打开 {base}/（服务端渲染时顺手签到）")
        await page.goto(base + "/", wait_until=wait_until, timeout=nav_ms)
        st = await wait_cloudflare(page)
        snap = await page_snapshot(page)
        if st is None:
            return cf_failure(name, snap, "签到")
        log(f"  🔍 {name}: 首页 {json.dumps(snap, ensure_ascii=False)[:320]}")

        # 等 __pageFlash 落地：走代理时 goto 只等 commit，脚本可能还没跑完。
        # 它没出现也没关系 —— 下面用 /daily_checkin 定论，不靠「首页看着像登录态」猜。
        flash = ""
        for _ in range(10):
            flash = await read_page_flash(page)
            if flash:
                break
            await page.wait_for_timeout(1000)

        if "已帮您完成自动签到" in flash:
            pts = flash_points(flash)
            message = flash
            if pts is not None:
                message = f"{message} · +{pts:g} 积分"
            result = {"name": name, "ok": True, "message": message[:300]}
        else:
            # 没有 flash 时不能凭首页的线索下结论：游客页和登录页长得很像
            # （2026-10-13 线上就误判过一次 —— 首页「用户榜单」里的 .user-name
            #  骗过了判据）。去 /daily_checkin 定论：游客会被甩到登录页，
            # 登录态则能看到今日记录。
            await page.goto(base + "/daily_checkin", wait_until=wait_until, timeout=nav_ms)
            await wait_cloudflare(page)
            final_url = page.url or ""
            # 诊断：把 /daily_checkin 的真实内容抓一份下来。这一页的形态决定了
            # 「今天签没签」该怎么判 —— 2026-10-13 前几轮的猜测都太乐观（页面里
            # 出现「已签到」就当签过了，实测那个词来自别处），所以先把原文摆在日志里。
            detail = {}
            try:
                detail = await page.evaluate(
                    """() => {
                        const body = document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '';
                        const html = document.documentElement ? document.documentElement.outerHTML : '';
                        return {
                            url: location.href,
                            title: document.title,
                            body: body.slice(0, 600),
                            cookies: (document.cookie || '').split(';')
                                .map(s => s.split('=')[0].trim()).filter(Boolean),
                            hasLoginForm: !!document.querySelector('input[type=password]'),
                            hasDailyCheckin: !!document.querySelector('a[href="/daily_checkin"]'),
                            userCard: /class="user-avatar-big"\\s+href="\\/user\\/\\d+"/.test(html),
                        };
                    }"""
                )
            except Exception as e:  # noqa: BLE001
                detail = {"error": str(e)[:100]}
            log(f"  🔎 {name}: /daily_checkin 详情 {json.dumps(detail, ensure_ascii=False)[:700]}")
            html = await page.content()
            if "/login" in final_url or detail.get("hasLoginForm"):
                return {
                    "name": name,
                    "ok": False,
                    "retryable": False,
                    "message": (
                        "Cookie 已失效：/daily_checkin 拿到的是登录页"
                        f"（{final_url}）。请在浏览器里重新登录 https://linux.sb，"
                        "再重抄整站 Cookie 到渠道里（换出口解决不了会话失效）。"
                    )[:300],
                }
            # 「今天签没签」的判据（2026-10-13 第四轮线上日志定的，别再放宽/收紧）：
            #   ① __daily_checkin_stats cookie 的日期 = 今天（服务端处理完签到才会改写；
            #      实测这一页也可能没有这个 cookie，所以只能当加分项）；
            #   ② 页面正文里出现**相对日期**措辞「今天/今日已签到」——
            #      站点就是这么写的（实测原文：`今天已签到 19 连续天数 46 累计签到 已完成`），
            #      它压根不写具体日期，所以「要求附近有日期」的判据太紧；
            #   ③ 兜底：正文/HTML 里「已签到」附近出现今天的日期（有的页面会写日期）。
            # 只认裸「已签到」太松：第一版因此从 HTML 里抓到「已签到 <div class」这种
            # 片段就算签过了 —— 那个词页面别处也有，等于把「页面有这个词」当成了「签过了」。
            ymd = site_today()
            stats = await read_stats_cookie(page)
            evidence = today_signed_evidence(detail.get("body")) or checkin_record_evidence(html, ymd)
            log(
                f"  🔎 {name}: 今日 {ymd}｜__daily_checkin_stats={stats.get('raw') or '(无)'}"
                f"｜记录证据={evidence or '(无)'}"
            )
            if (stats.get("date") == ymd) or evidence:
                message = "今日已签到（linux.sb 打开页面即自动签到）"
                if evidence:
                    message = f"{message} · 站点原文：{evidence}"
                result = {"name": name, "ok": True, "message": message[:300]}
            elif not (forum_logged_in(snap) or detail.get("userCard") or detail.get("hasDailyCheckin")):
                return {
                    "name": name,
                    "ok": False,
                    "retryable": False,
                    "message": (
                        "Cookie 已失效：首页与 /daily_checkin 都拿不到登录态线索"
                        "（没有用户卡片 /「每日签到」入口）。请在浏览器里重新登录 "
                        "https://linux.sb 后重抄整站 Cookie 到渠道里。"
                        f"页面快照：{json.dumps(snap, ensure_ascii=False)[:160]}"
                    )[:300],
                }
            else:
                # 登录态正常、但两条证据都没拿到：报「未能确认」而不是「已签到」——
                # 宁可让用户去站点看一眼，也不能把「没签」说成「签了」让他漏签。
                return {
                    "name": name,
                    "ok": False,
                    "message": (
                        "未能确认今日签到：登录态正常，但 /daily_checkin 既没有今日日期附近的"
                        "签到记录，__daily_checkin_stats 也没更新到今天（服务端这次可能没完成"
                        "自动签到）。请到站点确认；若站点显示已签，把这条日志发我收紧判据。"
                        f"页面快照：{json.dumps(snap, ensure_ascii=False)[:140]}"
                    )[:300],
                }

        # 签到后自动抽称号（渠道选项 autoGacha）：失败不推翻签到结论，只追加说明
        if auto_gacha and result["ok"]:
            g = await linuxsb_browser_gacha(page, name, base, wait_until, nav_ms)
            log(f"  🎁 {name}: {g['message']}")
            result["message"] = f"{result['message']} · 抽称号：{g['message']}"[:300]
            if g.get("titles"):
                result["titles"] = g["titles"]
        # 结果由 main() 统一打印（这里再打一遍日志里会出现两条 ✅，读起来像签了两回）
        return result


async def linuxsb_browser_gacha(page, name, base, wait_until, nav_ms) -> dict:
    """免费一抽称号：点 /gacha_pull 表单里的免费按钮，再从结果页解析称号。

    与 src/adapters/linuxsb.js 的 gacha() 是同一套流程（_csrf → POST /gacha_pull →
    302 → 解析结果页），区别只在这一枪从真浏览器里发出，CF 放行 cookie 与站点自己的
    _csrf 都是现成的。

    **绝不点带价格的按钮**：站点在「今日免费一抽」用完之后会把按钮文案改成
    「抽一次 (10 积分)」，照点就是替用户花积分 —— 2026-10-13 线上实测踩到过，
    白扣 10 积分。所以这里只认「落在 /gacha_pull 表单里 + 文案不标价」的按钮，
    找不到就直接跳过并说明（宁可漏抽，不可乱花）。
    """
    try:
        await page.goto(base + "/gacha", wait_until=wait_until, timeout=nav_ms)
        await wait_cloudflare(page)
        html = ""
        clicked = await page.evaluate(
            """() => {
                const label = el => (el.innerText || el.value || el.getAttribute('value') || '').trim();
                const price = el => {
                    const m = /(\\d+(?:\\.\\d+)?)\\s*积分/.exec(label(el));
                    return m ? Number(m[1]) : null;
                };
                const desc = el => {
                    const cost = el.getAttribute ? el.getAttribute('data-cost') : null;
                    return el.tagName.toLowerCase() + '「' + label(el).slice(0, 18) + '」'
                        + (cost !== null ? '[data-cost=' + cost + ']' : '');
                };
                const all = [...document.querySelectorAll('button,input[type=submit],a,form')];
                const forms = [...document.querySelectorAll('form[action]')]
                    .map(f => f.getAttribute('action')).slice(0, 10);
                const inPullForm = el => {
                    if (el.tagName === 'FORM') return /\\/gacha_pull(\\?|$)/.test(el.getAttribute('action') || '');
                    const f = el.closest ? el.closest('form') : null;
                    return !!f && /\\/gacha_pull(\\?|$)/.test(f.getAttribute('action') || '');
                };
                // 免费一抽必须落在 /gacha_pull 表单里（或显式 data-cost="0"）且文案不标价。
                // 只按「免费」两个字找会点到导航里的「免费SSL证书」（2026-10-13 实测）。
                const free = all.filter(el => {
                    const cost = el.getAttribute ? el.getAttribute('data-cost') : null;
                    const looksFree = (cost === '0' || /免费/.test(label(el))) && price(el) === null;
                    return looksFree && inPullForm(el);
                });
                if (!free.length) {
                    return {
                        found: false,
                        forms,
                        candidates: all.filter(el => /抽/.test(label(el))).map(desc).slice(0, 8),
                    };
                }
                const el = free[0];
                const labelText = el.tagName === 'FORM' ? 'form' : label(el).slice(0, 20);
                if (el.tagName === 'FORM') { el.submit(); return {found: true, label: labelText}; }
                el.click();
                return {found: true, label: labelText};
            }"""
        )
        if clicked.get("found"):
            log(f"  🎁 {name}: 点站点自己的免费一抽按钮（{clicked.get('label')}）")
            for _ in range(15):
                await page.wait_for_timeout(1000)
                if "/gacha_pull" in page.url or "gacha-result-card" in (await page.content()):
                    break
            html = await page.content()
        else:
            cands = clicked.get("candidates") or []
            forms = clicked.get("forms") or []
            log(
                f"  🎁 {name}: 没找到免费一抽按钮｜候选 = {'、'.join(cands) or '(无)'}"
                f"｜表单 = {'、'.join(forms) or '(无)'}"
            )
            return {
                "ok": False,
                "message": (
                    "没找到「免费一抽」按钮（今日免费抽多半已用完，页面按钮都标了价格），"
                    "跳过以免消耗积分。"
                    + (f"页面候选：{'、'.join(cands)}" if cands else f"页面表单：{'、'.join(forms)}" if forms else "")
                )[:300],
            }

        titles = parse_gacha_titles(html)
        if not titles:
            return {
                "ok": False,
                "message": (
                    "提交后没解析到称号卡片（站点可能改了页面结构，或今日免费抽已用完）。"
                    f"页面头部：{await page_diag(page, limit=200)}"
                )[:300],
            }
        return {
            "ok": True,
            "titles": titles,
            "message": "抽到 " + "、".join(gacha_title_line(t) for t in titles),
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"抽称号异常: {str(e)[:120]}"}


def gacha_title_line(t):
    head = " ".join(x for x in (t.get("rarity"), t.get("icon"), t.get("name")) if x)
    return f"{head}（{t['desc']}）" if t.get("desc") else head


def parse_gacha_titles(html):
    """解析结果页的 gacha-result-card（与 src/adapters/linuxsb.js 的 parseTitles 同构）。"""
    if not html:
        return []
    out = []
    for chunk in re.split(r'(?=<div class="gacha-result-card)', html)[1:21]:

        def pick(cls):
            m = re.search(r'class="gacha-result-%s"[^>]*>([\s\S]*?)</div>' % cls, chunk)
            return re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else ""

        title_name = pick("name")
        if not title_name:
            continue
        out.append(
            {
                "rarity": pick("rarity"),
                "icon": pick("icon"),
                "name": title_name,
                "desc": pick("desc"),
                "quantity": pick("quantity"),
            }
        )
    return out


# 页面内签到请求：与 NodeSeek 前端自己发的一模一样（无请求体、Accept: */*）。
# 返回 res.url / res.redirected 是关键 —— Worker 出口那次只看到「HTTP 302」查不出
# 跳去哪，这里能看到落地地址（登录页 = Cookie 失效，挑战页 = CF 拦截）。
JS_ATTENDANCE = """async () => {
    const res = await fetch('/api/attendance?random=true', {
        method: 'POST', credentials: 'include', headers: { Accept: '*/*' },
    });
    let text = '';
    try { text = await res.text(); } catch (e) {}
    let body = null;
    try { body = JSON.parse(text); } catch (e) {}
    return { status: res.status, url: res.url, redirected: res.redirected, body, text: text.slice(0, 400) };
}"""

JS_BOARD = """async (page) => {
    const res = await fetch('/api/attendance/board?page=' + page, {
        credentials: 'include', headers: { Accept: '*/*' },
    });
    let body = null;
    try { body = await res.json(); } catch (e) {}
    return { status: res.status, url: res.url, body };
}"""


def board_hit(board, username):
    """今日签到排行榜里有没有自己（判据同 src/adapters/nodeseek.js 的 status()）。"""
    if not username or not isinstance(board, dict):
        return None
    body = board.get("body")
    rows = body.get("list") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        return None
    low = username.lower()
    for row in rows:
        if str((row or {}).get("member_name") or "").lower() == low:
            return row
    return None


def attendance_result(name, res):
    """把页面内那一枪的响应翻成结果；「判定不了」返回 None 交给调用方继续尝试。"""
    body = res.get("body") if isinstance(res.get("body"), dict) else {}
    status = res.get("status")
    msg = str(body.get("message") or "").strip()
    if status == 200 and body.get("success") is True:
        gain = body.get("gain")
        already = bool(ALREADY_SIGNED_RE.search(msg)) or (isinstance(gain, (int, float)) and not gain)
        parts = [msg or ("今日已签到" if already else "签到成功")]
        if body.get("current") is not None:
            parts.append(f"鸡腿余额 {body['current']}")
        return {"name": name, "ok": True, "message": " · ".join(parts)[:300], "already": already}
    if status == 200 and body.get("success") is False and ALREADY_SIGNED_RE.search(msg):
        return {"name": name, "ok": True, "already": True, "message": (msg or "今日已签到")[:300]}
    return None


# 登录页结构探针：站点没有公开的登录 API 文档，只能驱动它自己的表单。把 input / form /
# button 全抓下来写进日志 —— 选择器一旦对不上，这份结构就是唯一能说明「站点改成了什么」
# 的东西（比反复猜选择器省事得多）。
JS_LOGIN_FORM = """() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight);
    const inputs = [...document.querySelectorAll('input')].map(el => ({
        name: el.getAttribute('name') || '',
        type: (el.getAttribute('type') || 'text').toLowerCase(),
        id: el.getAttribute('id') || '',
        placeholder: el.getAttribute('placeholder') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        visible: vis(el),
    }));
    const forms = [...document.querySelectorAll('form')].map(f => ({
        action: f.getAttribute('action') || '',
        method: (f.getAttribute('method') || 'get').toLowerCase(),
    }));
    const buttons = [...document.querySelectorAll('button,input[type=submit]')]
        .map(b => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 10);
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    return {
        url: location.href,
        title: document.title,
        inputs, forms, buttons,
        hasTurnstile: /cf-turnstile|challenges\\.cloudflare\\.com/i.test(html),
        hasRecaptcha: /g-recaptcha|google\\.com\\/recaptcha/i.test(html),
        body: (document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '').slice(0, 240),
    };
}"""

# 挑「真正的登录按钮」：**必须锚定在密码框所属的那个表单/容器里**。
#
# 2026-10-13 线上实测（用户截图确认）：signIn.html 上除了密码表单里那个提交按钮（用户圈出来的
# 那个），页面上还有别的「登录」元素 —— 顶栏的登录入口、以及「邮箱动态验证 / 短信动态验证」
# 那一栏。旧实现只按文案找第一个匹配项，点中的不是表单提交按钮，于是站点把这次「登录」
# 当成邮箱动态验证的入口，跳到 emailSignIn.html?email=… 要验证码，看起来像「账号密码不对」。
#
# 这里只做「挑 + 打标记 + 把候选结构回报」：真正点击交给 Playwright 的真鼠标点击
# （见 nodeseek_browser_login），因为站点可能挂 mousedown/mouseup 或挡了 el.click()。
JS_PICK_LOGIN_SUBMIT = """() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight);
    const label = el => (el.innerText || el.value || el.getAttribute('value') || '').trim();
    const isLogin = el => /登录|登入|login|sign\\s*in/i.test(label(el));
    const pw = document.querySelector('input[type=password]');
    const form = pw && pw.closest ? pw.closest('form') : null;
    const scope = form || (pw && pw.closest ? pw.closest('div,section,main') : null) || document;
    // 候选清单：页面上所有「登录」元素的结构，含是否在密码表单内 —— 选择器再出问题时靠它定位
    const dump = [...document.querySelectorAll('button,input[type=submit],a')]
        .filter(isLogin)
        .map(el => ({
            tag: el.tagName.toLowerCase(),
            text: label(el).slice(0, 12),
            type: el.getAttribute('type') || '',
            visible: vis(el),
            inPasswordForm: !!(form && form.contains(el)),
            href: (el.getAttribute('href') || '').slice(0, 48),
        }))
        .slice(0, 10);
    const inScope = [...scope.querySelectorAll('button,input[type=submit]')].filter(isLogin);
    const pick = inScope.filter(vis)[0] || inScope[0] || null;
    const old = document.getElementById('__hub_login_submit');
    if (old) old.removeAttribute('id');
    if (pick) pick.id = '__hub_login_submit';
    return {
        found: !!pick,
        label: pick ? label(pick).slice(0, 16) : '',
        type: pick ? (pick.getAttribute('type') || pick.tagName.toLowerCase()) : '',
        hasForm: !!form,
        candidates: dump,
    };
}"""

# 页面内提交兜底（真鼠标点击失败时用）：优先 requestSubmit（会触发站点自己的 submit 处理），

# 结构诊断：把页面上**所有表单**连同各自的输入/按钮/可见文本列出来，并标出「密码框属于哪个
# 表单」。2026-10-13 排查「点了登录却跳到邮箱动态验证」时靠它定位 —— 只看单个按钮的文案
# 分不清它属于哪个区块（密码登录 / 邮箱动态验证 / 短信动态验证）。
JS_LOGIN_DIAG = """() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight);
    const txt = el => (el.innerText || el.value || el.getAttribute('value') || '').trim().slice(0, 18);
    const allForms = [...document.querySelectorAll('form')];
    const pw = document.querySelector('input[type=password]');
    const pwForm = pw && pw.closest ? pw.closest('form') : null;
    const forms = allForms.slice(0, 5).map((f, i) => ({
        i,
        action: (f.getAttribute('action') || '').slice(0, 36),
        method: (f.getAttribute('method') || 'get').toLowerCase(),
        inputs: [...f.querySelectorAll('input')].slice(0, 8)
            .map(el => `${el.getAttribute('type') || 'text'}:${el.getAttribute('name') || el.id || ''}${vis(el) ? '' : '(h)'}`),
        buttons: [...f.querySelectorAll('button,input[type=submit]')].slice(0, 6)
            .map(el => `${el.tagName.toLowerCase()}:${txt(el)}${vis(el) ? '' : '(h)'}`),
        text: (f.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
    }));
    return {
        url: location.href,
        formsCount: allForms.length,
        pwFormIndex: pwForm ? allForms.indexOf(pwForm) : -1,
        pwVisible: pw ? vis(pw) : false,
        forms,
        body: (document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '').slice(0, 260),
    };
}"""


# 页面内网络钩子：抓登录接口的**响应体**（Playwright 的 response.text() 在页面导航后常读不到
# 内容，而服务端到底说了什么才是关键 —— 2026-10-13 就是靠它才看到 /api/account/signIn）。
JS_NET_HOOK = """() => {
    if (window.__hubNetHooked) return {hooked: true, already: true};
    window.__hubNetHooked = true;
    window.__hubNet = [];
    const keep = (url, status, body) => {
        try {
            if (!/signin|sign-?in|login|api\\/account|api\\/user/i.test(String(url))) return;
            window.__hubNet.push({
                url: String(url).slice(0, 90),
                status,
                body: String(body || '').slice(0, 400),
            });
        } catch (e) {}
    };
    const of = window.fetch;
    if (of) {
        window.fetch = async function (...args) {
            const res = await of.apply(this, args);
            try {
                const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
                const t = await res.clone().text();
                keep(u, res.status, t);
            } catch (e) {}
            return res;
        };
    }
    const oo = XMLHttpRequest.prototype.open;
    const os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...rest) {
        this.__hubUrl = u;
        return oo.call(this, m, u, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
            try { keep(this.__hubUrl, this.status, this.responseText); } catch (e) {}
        });
        return os.apply(this, args);
    };
    return {hooked: true};
}"""

# 读钩子攒下的响应 + 当前 Turnstile token 长度（提交时 token 是否为空，直接决定服务端怎么答）
JS_NET_READ = """() => {
    const el = document.querySelector('[name=cf-turnstile-response]');
    return {
        net: (window.__hubNet || []).slice(-4),
        tokenLen: el ? (el.value || '').length : -1,
    };
}"""



async def type_like_human(page, selector, value):
    """用**真实按键**输入，而不是直接设 value。

    为什么非这样不可：有些站点前端靠 keydown/keyup 判断「用户真的填了」，直接 fill 设值
    在它的状态里仍是空 —— 于是点提交时它按「没填」处理，走错分支（2026-10-13 NodeSeek
    的密码登录疑似如此：填了正确账密点登录，站点直接跳邮箱动态验证）。

    顺序：先聚焦并清空，再逐字输入；page.type 不可用时退到 press_sequentially，最后才 fill。
    """
    try:
        await page.click(selector, timeout=5000)
    except Exception:  # noqa: BLE001
        pass
    try:
        await page.fill(selector, "")
    except Exception:  # noqa: BLE001
        pass
    try:
        await page.type(selector, value, delay=60)
        return True
    except Exception:  # noqa: BLE001
        pass
    try:
        await page.locator(selector).press_sequentially(value, delay=60)
        return True
    except Exception:  # noqa: BLE001
        pass
    try:
        await page.fill(selector, value)
        return True
    except Exception:  # noqa: BLE001
        return False

# 站点前端 JS 里的登录判定逻辑（为什么跳到 emailSignIn）：从 performance 资源里找 JS 再 grep
JS_LOGIN_JS_PROBE = """async () => {
    const urls = performance.getEntriesByType('resource')
        .map(r => r.name)
        .filter(n => /\\.js(\\?|$)/i.test(n) && /prelogin|postlogin|signin|login|index/i.test(n))
        .slice(0, 4);
    const out = {urls, hits: []};
    for (const u of urls) {
        try {
            const r = await fetch(u, {credentials: 'include'});
            const t = await r.text();
            for (const kw of ['emailSignIn', 'needEmail', 'emailVerify', 'verifyType', 'smsSignIn', 'password']) {
                const i = t.indexOf(kw);
                if (i >= 0) out.hits.push({kw, ctx: t.slice(Math.max(0, i - 130), i + 130)});
                if (out.hits.length >= 6) break;
            }
        } catch (e) { out.hits.push({err: u.slice(-30) + ':' + String(e).slice(0, 40)}); }
        if (out.hits.length >= 6) break;
    }
    return out;
}"""

# 退到点标记元素，再退到 form.submit()。
JS_SUBMIT_LOGIN = """() => {
    const pw = document.querySelector('input[type=password]');
    const form = pw && pw.closest ? pw.closest('form') : null;
    const tagged = document.getElementById('__hub_login_submit');
    if (form && typeof form.requestSubmit === 'function') {
        try {
            form.requestSubmit(tagged && tagged.tagName !== 'A' ? tagged : undefined);
            return {clicked: true, how: 'requestSubmit', label: tagged ? (tagged.innerText || '').trim().slice(0, 16) : ''};
        } catch (e) {}
    }
    if (tagged) { tagged.click(); return {clicked: true, how: 'click', label: (tagged.innerText || '').trim().slice(0, 16)}; }
    if (form) { form.submit(); return {clicked: true, how: 'form.submit'}; }
    return {clicked: false, how: 'none'};
}"""


# 首页上的「登录」入口（/signIn.html 打不开时退回这条路）
JS_CLICK_LOGIN_ENTRY = """() => {
    const cands = [...document.querySelectorAll('a,button')].filter(el => {
        const t = (el.innerText || '').trim();
        const href = el.getAttribute('href') || '';
        return /^(登录|登入|Login|Sign in)$/i.test(t) || /\\/login/i.test(href);
    });
    if (!cands.length) return {found: false};
    const el = cands[0];
    el.click();
    return {found: true, text: ((el.innerText || '').trim() || el.getAttribute('href') || '').slice(0, 24)};
}"""

def pick_login_fields(inputs):
    """从页面的 input 列表里挑出「账号框」和「密码框」（纯函数，便于离线测试）。

    密码框：第一个可见的 password 型输入。
    账号框：name/id/placeholder/autocomplete 里带 email / user / account / login / name 的
    可见文本框；一个都没有就退到第一个可见文本框（按关键词命中优先级排序）。
    """
    pw = None
    for el in inputs or []:
        if str(el.get("type") or "").lower() == "password" and el.get("visible", True):
            pw = el
            break
    cands = [
        el
        for el in (inputs or [])
        if el is not pw
        and el.get("visible", True)
        and str(el.get("type") or "text").lower() in ("text", "email", "tel", "")
    ]

    def score(el):
        hay = " ".join(
            str(el.get(k) or "") for k in ("name", "id", "placeholder", "autocomplete")
        ).lower()
        for i, kw in enumerate(("email", "user", "account", "login", "name")):
            if kw in hay:
                return i
        return 99

    cands.sort(key=score)
    return (cands[0] if cands else None), pw


def input_selector(el):
    """给一个 input 描述挑一个稳定的 CSS 选择器（name > id > type）。"""
    if not el:
        return ""
    if el.get("name"):
        return 'input[name="%s"]' % el["name"]
    if el.get("id"):
        return "#" + str(el["id"])
    if el.get("type"):
        return 'input[type="%s"]' % el["type"]
    return ""


def cookies_to_header(cookies, host_suffix):
    """把浏览器 cookie jar 拼成 Cookie 头（只取目标站自己的域）。"""
    out = []
    for c in cookies or []:
        name = str(c.get("name") or "")
        domain = str(c.get("domain") or "").lstrip(".").lower()
        if not name or not domain:
            continue
        if host_suffix and not (domain == host_suffix or domain.endswith("." + host_suffix)):
            continue
        out.append(f"{name}={c.get('value')}")
    return "; ".join(out)


def has_session_cookie(cookie_header):
    """会话 cookie 是否已经到手（NodeSeek 登录成功会下发 session / pjwt）。"""
    return bool(re.search(r"(^|;\s*)(session|pjwt)=", cookie_header or ""))


def session_value(cookie_header):
    """从 Cookie 头里取出会话 cookie 的值（session / pjwt 各取一个），用于「换没换到新的」。"""
    out = {}
    for name in ("session", "pjwt"):
        m = re.search(r"(?:^|;\s*)" + name + r"=([^;]*)", cookie_header or "")
        if m:
            out[name] = m.group(1)
    return out


async def nodeseek_browser_login(page, name, base, wait_until, nav_ms, username, password):
    """用渠道里的账密登录 NodeSeek，换一份新会话 Cookie。

    站点没有公开的登录 API，所以这里**驱动它自己的登录页**：依次试 /signIn.html（线上实测
    的真实登录页）与 /login，都不行就回首页点「登录」入口，然后把账密填进它自己的表单提交
    —— 与「人手动登录」等价，CF 放行 cookie、站点自己那套前端逻辑都在场。

    **登录是分步的**：signIn.html 是密码表单（账号 + 密码 + 它自己的 Turnstile），
    提交后站点可能跳到 `emailSignIn.html?email=…`（邮箱动态验证：发送验证码 → 填验证码）。
    所以下面是一个最多三步的循环：每步读表单 → 填空（只填空框，别覆盖站点预填的邮箱）→
    提交 → 等会话变化或离开登录流程。邮箱动态验证那一步需要收邮件，脚本做不到，会如实报出来。

    **登录页同样有 CF 挑战**（用户确认，实测 /signIn.html 上挂着 Turnstile）：每一步都先过
    挑战；表单里的 Turnstile 等它签发 token（机房直连出口拿不到，住宅代理 7s 就拿到）；
    提交后又被挑战继续解。

    「登录成功」的判据必须**排掉注入的那份旧 Cookie**：渠道里的旧 session 本来就在 jar 里，
    只查「有没有 session」会把一次注定失败的登录判成成功（2026-10-13 实测踩过：错密码提交后
    1 秒就报「登录成功」，随后签到仍 USER NOT FOUND）。所以要求会话值**变了**，或已离开登录
    流程；而「到底有没有真的登上」由调用方用签到接口定论（USER NOT FOUND 会再报回来）。

    返回 {ok, cookie?, message}。失败时 message 里带上站点提示与页面结构，并带上
    Turnstile/challenge 字样 —— 后者是 main() 换住宅代理重试的触发词。
    """

    async def settle():
        """把当前页的 CF 挑战处理掉（等待 + 拟人点勾选框）。"""
        return await wait_cloudflare(page)

    # 抓登录相关的网络响应：站点把「为什么不让登」写在接口回话里（例如要邮箱动态验证、
    # 密码错误），只靠页面跳转猜不出来 —— 2026-10-13 就是靠这份日志定位到点错按钮的。
    net = []

    async def on_response(resp):
        try:
            u = resp.url or ""
            if not re.search(r"signin|sign-in|login|/api/|auth", u, re.I):
                return
            if len(net) >= 12:
                return
            body = ""
            try:
                body = (await resp.text())[:300]
            except Exception:  # noqa: BLE001
                body = "(读取响应体失败)"
            net.append({"status": resp.status, "method": resp.request.method, "url": u[:90], "body": body})
        except Exception:  # noqa: BLE001
            pass

    page.on("response", lambda r: asyncio.ensure_future(on_response(r)))

    async def form_with_password(budget_s=12):
        """等登录页把表单渲染出来，返回结构。

        必须等：线上实测 /signIn.html 的账号/密码框是**前端 JS 后渲染**的，刚导航完
        页面上只有顶部搜索框（一个 name="q" 的输入），立刻判定「没有密码框」会误判，
        接着白跑一趟 /login（Express 回 Cannot GET /login）。
        """
        deadline = time.monotonic() + budget_s
        f = {}
        while time.monotonic() < deadline:
            f = await page.evaluate(JS_LOGIN_FORM)
            if any(str(i.get("type")) == "password" for i in f.get("inputs") or []):
                return f
            await page.wait_for_timeout(1000)
        return f

    form = {}
    for path in ("/signIn.html", "/login"):
        await page.goto(base + path, wait_until=wait_until, timeout=nav_ms)
        await settle()
        form = await form_with_password()
        log(f"  🔑 {name}: {path} 结构 {json.dumps(form, ensure_ascii=False)[:520]}")
        if any(str(i.get("type")) == "password" for i in form.get("inputs") or []):
            break
        log(f"  🔑 {name}: {path} 上没有密码框，换下一个入口")
    if not any(str(i.get("type")) == "password" for i in form.get("inputs") or []):
        log(f"  🔑 {name}: 两个登录地址都没有密码框，回首页找登录入口")
        await page.goto(base + "/", wait_until=wait_until, timeout=nav_ms)
        await settle()
        clicked = await page.evaluate(JS_CLICK_LOGIN_ENTRY)
        log(f"  🔑 {name}: 点登录入口 {json.dumps(clicked, ensure_ascii=False)[:120]}")
        if clicked.get("found"):
            await page.wait_for_timeout(2500)
            await settle()
        form = await form_with_password()
        log(f"  🔑 {name}: 登录页结构 {json.dumps(form, ensure_ascii=False)[:520]}")

    host = base.split("//", 1)[1].split("/", 1)[0]
    suffix = host[4:] if host.startswith("www.") else host
    # 提交前先记下 jar 里的会话值：判「登录成功」要拿它做对比（见函数文档字符串）
    before = session_value(cookies_to_header(await page.context.cookies(), suffix))

    async def fill_if_empty(selector, value, label):
        """只填空框：站点会把邮箱预填进第二步的表单，覆盖掉反而破坏流程。"""
        if not selector:
            return False
        try:
            cur = (await page.input_value(selector)) or ""
        except Exception:  # noqa: BLE001
            cur = ""
        if cur.strip():
            log(f"  🔑 {name}: {label}框已有值（{cur[:3]}…），不覆盖")
            return False
        await page.fill(selector, value)
        return True

    def in_login_flow(s):
        url = str(s.get("url") or "").lower()
        return "signin" in url or "/login" in url or "signup" in url

    token_ready = True
    cookie = ""
    snap = {}
    use_enter = False
    # NodeSeek 的登录是**分步**的：signIn.html 是密码表单，提交后站点可能跳到
    # emailSignIn.html?email=…（邮箱动态验证：发送验证码 → 填验证码）。所以这里最多走三步：
    # 每步读表单 → 填空 → 提交 → 等会话变化或离开登录流程。
    steps = 0
    # 最多两轮：第一次点按钮，被甩到邮箱动态验证后回登录页换 Enter 再试一次。
    # 别再多试 —— 站点对密码登录有**账号维度的每日限流**（RATE_LIMITED，2026-10-13 实测），
    # 我们自己反复重试就会把用户当天的密码登录额度耗光。
    while steps < 2:
        steps += 1
        if use_enter:
            # 上一轮点按钮被甩到邮箱验证：回登录页，换「在密码框按 Enter」再提交一次
            log(f"  🔑 {name}: 回 /signIn.html 改用 Enter 提交再试一次")
            await page.goto(base + "/signIn.html", wait_until=wait_until, timeout=nav_ms)
            await settle()
        form = await form_with_password(budget_s=8)
        log(f"  🔑 {name}: 第 {steps} 步表单 {json.dumps(form, ensure_ascii=False)[:700]}")
        user_el, pw_el = pick_login_fields(form.get("inputs"))
        if not (user_el or pw_el):
            return {
                "ok": False,
                "message": (
                    f"登录第 {steps} 步没找到可填的输入框（站点可能改了登录页）。"
                    f"页面结构：{json.dumps(form, ensure_ascii=False)[:200]}"
                )[:300],
            }
        # 验证码：Turnstile 只在第一步等一次（每步都等会白烧 45s）；reCAPTCHA 每步点一下
        if steps == 1 and form.get("hasTurnstile"):
            log(f"  🔑 {name}: 登录页带 Turnstile，等它签发 token（拟人点勾选框）")
            tok, src = await wait_any_token(page, TOKEN_WAIT_S)
            token_ready = bool(tok)
            log(f"  🔑 {name}: Turnstile token {'已就绪（' + str(src) + '）' if tok else '没等到，仍尝试提交'}")
        if form.get("hasRecaptcha"):
            log(f"  🔑 {name}: 登录页带 reCAPTCHA，点勾选框")
            await click_captcha_checkbox(page)
        # 装页面内网络钩子（抓登录接口响应体）：每步都装一次，页面导航后 window 会重置
        try:
            hook = await page.evaluate(JS_NET_HOOK)
            log(f"  🛰️ {name}: 网络钩子 {json.dumps(hook, ensure_ascii=False)}")
        except Exception as e:  # noqa: BLE001
            log(f"  🛰️ {name}: 网络钩子安装失败 {str(e)[:60]}")
        filled = []
        if user_el:
            sel = input_selector(user_el)
            try:
                cur = (await page.input_value(sel)) or ""
            except Exception:  # noqa: BLE001
                cur = ""
            if cur.strip():
                log(f"  🔑 {name}: 账号框已有值（{cur[:3]}…），不覆盖")
            elif await type_like_human(page, sel, username):
                filled.append("账号（真实按键）")
        if pw_el:
            sel = input_selector(pw_el)
            try:
                cur = (await page.input_value(sel)) or ""
            except Exception:  # noqa: BLE001
                cur = ""
            if cur.strip():
                log(f"  🔑 {name}: 密码框已有值，不覆盖")
            elif await type_like_human(page, sel, password):
                filled.append("密码（真实按键）")
        log(f"  🔑 {name}: 第 {steps} 步填写 {('、'.join(filled) or '（无，沿用站点已有值）')}")
        # 输入后回读一次：确认站点前端真的收到了这两个值（直接设 value 时它可能仍是空）
        try:
            echo = await page.evaluate(
                """() => {
                    const pw = document.querySelector('input[type=password]');
                    const em = document.querySelector('#stacked-email')
                        || document.querySelector('input[type=email]')
                        || document.querySelector('input[placeholder=Email]');
                    return {
                        emailLen: em ? (em.value || '').length : -1,
                        pwLen: pw ? (pw.value || '').length : -1,
                    };
                }"""
            )
            log(f"  🔑 {name}: 第 {steps} 步输入回读 {json.dumps(echo, ensure_ascii=False)}")
        except Exception:  # noqa: BLE001
            pass
        # 提交前把页面所有表单结构打出来：站点把「密码登录」与「邮箱/短信动态验证」放在同一页，
        # 只看按钮文案分不清归属（2026-10-13 排查点错入口时就卡在这里）。
        diag = await page.evaluate(JS_LOGIN_DIAG)
        log(f"  🔎 {name}: 第 {steps} 步表单结构 {json.dumps(diag, ensure_ascii=False)[:800]}")

        # 提交：先挑「密码框那个表单里的提交按钮」（页面别处也有「登录」元素，见
        # JS_PICK_LOGIN_SUBMIT 的说明），再用**真鼠标**点它；点不到才退回页面内提交。
        # use_enter 为真时改用「在密码框按 Enter」——被站点甩到邮箱动态验证后换一种提交方式再试。
        if use_enter and pw_el:
            await page.press(input_selector(pw_el), "Enter")
            submitted = {"clicked": True, "how": "Enter"}
        else:
            picked = await page.evaluate(JS_PICK_LOGIN_SUBMIT)
            log(f"  🔑 {name}: 第 {steps} 步登录按钮候选 {json.dumps(picked, ensure_ascii=False)[:420]}")
            submitted = None
            if picked.get("found"):
                try:
                    await page.click("#__hub_login_submit", timeout=6000)
                    submitted = {"clicked": True, "how": "mouse", "label": picked.get("label")}
                except Exception as e:  # noqa: BLE001
                    log(f"  🔑 {name}: 真鼠标点击失败（{str(e)[:70]}），改用页面内提交")
            if not submitted:
                submitted = await page.evaluate(JS_SUBMIT_LOGIN)
            if not submitted.get("clicked"):
                target = input_selector(pw_el) or input_selector(user_el)
                if target:
                    await page.press(target, "Enter")
                submitted = {"clicked": True, "how": "Enter"}
        log(f"  🔑 {name}: 第 {steps} 步提交方式 {json.dumps(submitted, ensure_ascii=False)}")
        # 等一小会儿让登录接口的响应落地，再把**页面内钩子**抓到的响应体打出来（含服务端回话）
        await page.wait_for_timeout(1500)
        hooked = {}
        try:
            hooked = await page.evaluate(JS_NET_READ)
            log(f"  🛰️ {name}: 第 {steps} 步登录接口回话 {json.dumps(hooked, ensure_ascii=False)[:700]}")
        except Exception as e:  # noqa: BLE001
            log(f"  🛰️ {name}: 读登录接口回话失败 {str(e)[:60]}")
        if net:
            log(f"  🛰️ {name}: 第 {steps} 步页面级响应 {json.dumps(net[-3:], ensure_ascii=False)[:500]}")
            net.clear()

        # 服务端回话要透出来 —— 2026-10-13 线上实测：账号被限流时 /api/account/signIn 回
        # {"success":false,"error":"RATE_LIMITED","message":"该账户操作过于频繁，请明天再尝试
        # 密码登录，或者改用邮箱验证登录"}。这正是「填了正确账密也登不上、还被甩去邮箱验证」
        # 的原因，而旧文案只会说「会话 Cookie 没变」，把用户引向「密码错了」。
        # 限流是**账号维度、按天**的，继续重试只会更糟 —— 立刻停并标不可重试。
        for item in (hooked or {}).get("net") or []:
            body = str(item.get("body") or "")
            if "RATE_LIMITED" in body or "过于频繁" in body:
                server_msg = ""
                try:
                    server_msg = str(json.loads(body).get("message") or "")
                except Exception:  # noqa: BLE001
                    server_msg = body[:120]
                return {
                    "ok": False,
                    "retryable": False,
                    "message": (
                        f"站点限流（RATE_LIMITED）：{server_msg or '该账户操作过于频繁'}"
                        "。这是账号维度的每日限制，今天再试也不会成功：明天再试密码登录，"
                        "或改用 Cookie 方式（浏览器里手动登录一次即可）。"
                    )[:300],
                }

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            await page.wait_for_timeout(1000)
            # 提交后又被挑战（登录接口本身也在 CF 后面）：继续解，别当成失败
            await settle()
            cookie = cookies_to_header(await page.context.cookies(), suffix)
            snap = await page_snapshot(page)
            after = session_value(cookie)
            if after and after != before:
                log(
                    f"  🔑 {name}: 登录成功（会话值已更新，落地 {snap.get('url')}，"
                    f"Cookie {len(cookie)} 字符）"
                )
                return {"ok": True, "cookie": cookie, "message": "已用账密登录换取新会话 Cookie"}
            if not in_login_flow(snap):
                # 已离开登录流程但会话值没变：站点可能沿用同一份 session 放行。
                # 真伪由调用方用签到接口验证（USER NOT FOUND 会再报回来），这里不拦。
                log(f"  🔑 {name}: 已离开登录流程（落地 {snap.get('url')}），按成功处理")
                return {"ok": True, "cookie": cookie, "message": "已用账密登录（站点未换会话 Cookie）"}
            # 被转到「邮箱动态验证」页（emailSignIn.html）：先换一种提交方式再试一次
            # （在密码框按 Enter —— 有些站点对「点按钮」与「回车提交」走不同分支），
            # 仍不行就把这一页的结构与站点前端 JS 判定逻辑抓下来如实报出。
            if "emailsignin" in str(snap.get("url") or "").lower():
                diag = await page.evaluate(JS_LOGIN_DIAG)
                log(f"  🔎 {name}: emailSignIn 表单结构 {json.dumps(diag, ensure_ascii=False)[:700]}")
                if not use_enter:
                    use_enter = True
                    log(f"  🔑 {name}: 改用 Enter 提交再试一次")
                    continue
                probe = await page.evaluate(JS_LOGIN_JS_PROBE)
                log(f"  🔎 {name}: 前端 JS 判定逻辑 {json.dumps(probe, ensure_ascii=False)[:500]}")
                return {
                    "ok": False,
                    "retryable": False,
                    "message": (
                        "站点把这次登录转到了「邮箱动态验证」（emailSignIn.html）："
                        "要往账号邮箱发验证码再填回来，脚本代收不了邮件。"
                        "请在浏览器里手动登录一次并重抄整站 Cookie（或继续用 Cookie 方式）。"
                    )[:300],
                }
        log(f"  🔑 {name}: 第 {steps} 步提交后仍在登录流程（{snap.get('url')}），继续下一步")

    snap = await page_snapshot(page)
    why = []
    if not token_ready:
        why.append("登录页的 Turnstile 没签发 token（challenge 没过，机房出口常见）")
    if session_value(cookie) == before:
        why.append("会话 Cookie 没变")
    # 服务端最后一次回话（可能点明限流 / 密码错 / 需要邮箱验证）优先展示，别让用户只看
    # 「会话 Cookie 没变」去猜。
    server_said = ""
    for item in (hooked or {}).get("net") or []:
        body = str(item.get("body") or "")
        if not body:
            continue
        try:
            server_said = str(json.loads(body).get("message") or body)[:120]
        except Exception:  # noqa: BLE001
            server_said = body[:120]
    return {
        "ok": False,
        "cookie": cookie,
        # 只有「Turnstile 没签发 token」这一类才值得换住宅代理重试（换出口正是它的解法）；
        # 账密不对 / 账号限流换出口白搭，标不可重试，别把 job 预算和账号配额都烧掉。
        "retryable": not token_ready,
        "message": (
            "账密登录没成功"
            + ("：" + "；".join(why) if why else "")
            + (f"。服务端回话：{server_said}" if server_said else "")
            + (f"。页面提示：{str(snap.get('body') or '')[:90]}" if not server_said else "")
        )[:300],
    }


async def nodeseek_browser_checkin(channel, proxy=None) -> dict:
    """NodeSeek：真浏览器过 CF → 页面内 POST /api/attendance?random=true。

    为什么非得在页面里发：这一枪要同时带上 CF 放行 cookie 与站点前端自己生成的签名头
    （HAR 里的 refract-key / refract-sign / refract-version 来自 sw.js）。机房出口直连
    连 CF 那关都过不去（实测 302 / 403），拷 cf_clearance 也没用 —— 它与出口 IP 绑定。

    会话来源两条路：
      ① 渠道里的 Cookie（用户手抄）；
      ② 渠道里填了账密时由本函数登录换一份新 Cookie（2026-10-13 起，省掉手抄；换到的
         Cookie 随结果回传面板写回 KV，下次直接用）。
    """
    name = channel.get("name", "unnamed")
    base = channel["baseUrl"].rstrip("/")
    auth = channel.get("auth") or {}
    username = str(auth.get("username") or auth.get("email") or "").strip()
    password = str(auth.get("password") or "")
    has_creds = bool(username and password)
    has_cookie = bool(forum_cookie_pairs(channel))
    if not has_cookie and not has_creds:
        return {
            "name": name,
            "ok": False,
            "retryable": False,
            "message": (
                "NodeSeek 只认浏览器会话，而本渠道既没有 Cookie 也没有账密。"
                "填「论坛用户名 + 密码」（浏览器通道自动登录换 Cookie），或手抄一份整站 Cookie。"
            )[:300],
        }
    if proxy:
        log(f"  🌍 {name}: 走代理 {mask_proxy(proxy)}")
    async with browser_page(proxy) as page:
        got = await apply_channel_cookies(page, channel)
        log(f"  🍪 {name}: 注入 {got} 个 cookie")
        wait_until, nav_ms = nav_opts(proxy)

        async def open_board():
            """打开 /board 并等 CF 过、等站点前端脚本起来（签名头由它生成）。"""
            await page.goto(base + "/board", wait_until=wait_until, timeout=nav_ms)
            await wait_cloudflare(page)
            await page.wait_for_timeout(2500)
            return await page_snapshot(page)

        async def attempt():
            """页面内跑一遍：排行榜确认 → POST 签到 → 点站点按钮 → 再 POST。

            返回 (结果 or None, 最后一枪的响应)。None 表示「判定不了」，由调用方决定
            是去登录换 Cookie 还是如实报失败。
            """
            hit = board_hit(await page.evaluate(JS_BOARD, 1), username)
            if hit:
                return {
                    "name": name,
                    "ok": True,
                    "message": f"今日已签到（签到排行榜确认）· 获得 {hit.get('gain')} 鸡腿"[:300],
                }, None
            res = await page.evaluate(JS_ATTENDANCE)
            done = attendance_result(name, res)
            if done:
                return done, res
            log(f"  🧪 {name}: 页面内签到未成功 {json.dumps(res, ensure_ascii=False)[:300]}")
            # 点站点自己的签到控件：站点前端会带上它自己那套签名头重发。它自己的请求可能
            # 先成功（两条独立请求），所以点完先查排行榜定论，再补一枪页面内 POST，
            # 免得把「已经签上了」误报成失败。
            clicked = await click_site_checkin(page)
            log(f"  🖱️ {name}: 点站点签到控件 {json.dumps(clicked, ensure_ascii=False)[:120]}")
            if clicked.get("found"):
                await page.wait_for_timeout(4000)
                hit2 = board_hit(await page.evaluate(JS_BOARD, 1), username)
                if hit2:
                    return {
                        "name": name,
                        "ok": True,
                        "message": f"今日已签到（点站点自身按钮后由排行榜确认）· 获得 {hit2.get('gain')} 鸡腿"[:300],
                    }, None
                res2 = await page.evaluate(JS_ATTENDANCE)
                done2 = attendance_result(name, res2)
                if done2:
                    return done2, res2
                res = res2
            return None, res

        log(f"  🌐 {name}: 打开 {base}/board")
        snap = await open_board()
        if not snap.get("title"):
            return cf_failure(name, snap, "签到")
        log(f"  🔍 {name}: 页面 {json.dumps(snap, ensure_ascii=False)[:320]}")

        fresh = ""
        login_rounds = 0

        def session_dead(res, snap):
            """这一枪是不是「会话失效」形态（USER NOT FOUND / 游客页 / 被甩到登录页）。"""
            body = (res or {}).get("body") if isinstance((res or {}).get("body"), dict) else {}
            probe = str(body.get("message") or "") + str((res or {}).get("text") or "")
            url = str((res or {}).get("url") or "")
            return (
                "user not found" in probe.lower()
                or bool(snap.get("guestHint"))
                or "/login" in url
                or "signin" in url.lower()
            )

        async def do_login(reason):
            """登录一次并把新 Cookie 记进 fresh；失败返回要直接回给面板的结果。"""
            nonlocal fresh, login_rounds, snap
            login_rounds += 1
            log(f"  🔑 {name}: {reason} → 用账密登录（第 {login_rounds} 次）")
            login = await nodeseek_browser_login(page, name, base, wait_until, nav_ms, username, password)
            log(f"  🔑 {name}: 登录结果 {login.get('message')}")
            if not login.get("ok"):
                out = {
                    "name": name,
                    "ok": False,
                    "message": f"账密登录失败：{login.get('message')}"[:300],
                }
                # 登录失败是否值得换出口重试，由登录函数判断（Turnstile 没签发 token 才值得）
                if login.get("retryable") is not None:
                    out["retryable"] = bool(login["retryable"])
                return out
            fresh = login.get("cookie") or ""
            snap = await open_board()
            return None

        # 没 Cookie、或页面明显是游客态（签到入口写着「登录后签到」）时先登录再谈签到：
        # 否则那一枪必然 USER NOT FOUND，白等一轮。
        if has_creds and (not has_cookie or snap.get("guestHint")):
            failed = await do_login("没有 Cookie" if not has_cookie else "页面是游客态")
            if failed:
                return failed

        result, res = await attempt()

        # 会话失效（USER NOT FOUND / 被甩到登录页 / 页面转成游客态）且填了账密：登录换新的
        # 再跑一遍 —— 这就是「填账密不用手抄 Cookie」的兑现点。
        #
        # 这里**不信任**登录自报的成功：2026-10-13 线上实测，错密码提交后 1 秒就被判成
        # 「登录成功」（旧 jar 里的 session 还在），于是重试一次仍是 USER NOT FOUND。
        # 所以循环条件看的是「签到这一枪仍然说会话失效」，最多两轮，避免死循环。
        while result is None and has_creds and login_rounds < 2 and session_dead(res, snap):
            failed = await do_login("会话已失效")
            if failed:
                return failed
            result, res = await attempt()

        if result is not None:
            if fresh:
                result["message"] = f"{result['message']} · 已用账密登录刷新 Cookie"[:300]
                # 面板（/api/gh/result）会把它写回 KV，省掉手抄；cf_clearance 之类会被剔除
                result["newTokens"] = {"cookie": fresh}
            return result

        # 登录过、签到这一枪却仍说会话失效：说明登录没真正换到有效会话（密码不对 /
        # 登录页 Turnstile 没过）。这句要单独说清楚，否则用户会以为「填了账密也没用」。
        if login_rounds and session_dead(res, snap):
            return {
                "name": name,
                "ok": False,
                "retryable": False,
                "message": (
                    f"账密登录没能换到有效会话（已试 {login_rounds} 次）：签到接口仍回 "
                    "USER NOT FOUND。常见原因：账号/密码不对，或登录页的 Cloudflare "
                    "Turnstile challenge 没通过（机房出口常见，可换住宅代理再试）。"
                )[:300],
            }

        # 判定不了：把几种真实原因分开说，别笼统报「签到失败」
        body = res.get("body") if isinstance(res.get("body"), dict) else {}
        msg = str(body.get("message") or "").strip()
        text = str(res.get("text") or "")
        status = res.get("status")
        where = str(res.get("url") or "")
        if "high risk action" in (msg + text).lower():
            return {
                "name": name,
                "ok": False,
                "message": (
                    f"站点风控回话 high risk action（HTTP {status}，浏览器通道同样被拦）。"
                    f"这不是接口写错：多为会话失效或站点要求浏览器指纹签名。"
                    f"{'账密登录已试过；' if login_rounds else ''}"
                    f"页面：{json.dumps(snap, ensure_ascii=False)[:160]}"
                )[:300],
            }
        # 「USER NOT FOUND」= 站点按这份 Cookie 查不到用户：会话已失效（2026-10-13 实测形态：
        # HTTP 500 + {"message":"USER NOT FOUND","status":404}）。走到这里说明没填账密
        # （填了的话上面已经登录重试过），所以只能让用户补凭证。
        if session_dead(res, snap):
            return {
                "name": name,
                "ok": False,
                "retryable": False,
                "message": (
                    f"会话已失效：站点回 USER NOT FOUND（HTTP {status}）"
                    f"{'，页面上的签到入口也是「登录后签到」' if snap.get('guestHint') else ''}。"
                    "在渠道里填「论坛用户名 + 密码」即可自动登录换 Cookie（推荐），"
                    "或重新登录后重抄整站 Cookie。"
                )[:300],
            }
        if "/login" in where or ("登录" in text and not msg):
            return {
                "name": name,
                "ok": False,
                "retryable": False,
                "message": (
                    f"签到请求被重定向到登录页（{where or 'HTTP ' + str(status)}），会话已失效："
                    "在渠道里填「论坛用户名 + 密码」即可自动登录换 Cookie（推荐），"
                    "或重新登录后重抄整站 Cookie。"
                )[:300],
            }
        return {
            "name": name,
            "ok": False,
            "message": (
                f"浏览器通道没能完成签到：HTTP {status}"
                f"{f'，站点回话：{msg}' if msg else ''}，落地 {where or '未知'}。"
                f"页面快照：{json.dumps(snap, ensure_ascii=False)[:160]}"
            )[:300],
        }


# ---------------------------------------------------------------------------
# NodeSeek 快路径：cloudscraper 直连 POST（参考 xinycai/nodeseek_signin）
# ---------------------------------------------------------------------------
#
# 参考项目（https://github.com/xinycai/nodeseek_signin）的做法很直接：
#   cloudscraper（自动解 Cloudflare JS 挑战的库）+ POST /api/attendance?random=false，
#   带上整站 Cookie，不启浏览器。
# 2026-10-13 按它原样在机房出口实测：HTTP 200 + {"success":true,"message":"今天的签到收益是5个鸡腿",
# "gain":5,"current":656} —— 说明这条路对 NodeSeek 是通的，比开 Camoufox 快得多（秒级 vs 一分钟）。
#
# 所以浏览器通道对 NodeSeek 改成**两段**：先走这条快路径；解不了挑战 / 网络层失败才退回
# 真浏览器流程（nodeseek_browser_checkin）。两条路共用同一份渠道 Cookie 与结果文案规则。

NODESEEK_ATTEND_PATH = "/api/attendance"
NODESEEK_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
)


def nodeseek_cookie_dict(channel):
    """渠道 Cookie → dict（cloudscraper / requests 要的形式）。纯函数，便于离线测试。"""
    out = {}
    for name, value in forum_cookie_pairs(channel):
        if name:
            out[name] = value
    return out


def nodeseek_http_verdict(status, body_text):
    """把快路径那一枪的响应翻成结论（纯函数，便于离线测试）。

    返回 (verdict, message, gain, current)：
      ok            签到成功（gain/current 可能为 None）
      already       今日已签（站点明说，或收益为 0）
      session_dead  会话失效（USER NOT FOUND / 未登录）—— 换出口无解，直接报给用户
      challenge     CF 挑战没过 / 被拦 —— 交给真浏览器流程
      unknown       其他（同样交给浏览器流程，但日志里保留原文）
    """
    text = str(body_text or "")
    low = text.lower()
    if "user not found" in low or "请先登录" in text or "未登录" in text:
        return ("session_dead", "站点按这份 Cookie 查不到用户（USER NOT FOUND）：会话已失效", None, None)
    if "high risk action" in low:
        return ("challenge", "站点风控回话 high risk action", None, None)
    if re.search(r"just a moment|challenge-platform|cf_chl_|cdn-cgi/challenge", text, re.I):
        return ("challenge", "被 Cloudflare 挑战页拦住", None, None)
    body = None
    try:
        body = json.loads(text)
    except Exception:  # noqa: BLE001
        body = None
    if isinstance(body, dict):
        msg = str(body.get("message") or "").strip()
        gain = body.get("gain")
        current = body.get("current")
        if body.get("success") is True:
            already = bool(ALREADY_SIGNED_RE.search(msg)) or (
                isinstance(gain, (int, float)) and not gain
            )
            return ("already" if already else "ok", msg, gain, current)
        if body.get("success") is False and ALREADY_SIGNED_RE.search(msg):
            return ("already", msg, gain, current)
        if body.get("success") is False and msg:
            return ("unknown", msg, gain, current)
    if status in (403, 429, 503):
        return ("challenge", f"HTTP {status}（疑似 Cloudflare 层拦截）", None, None)
    return ("unknown", text[:120], None, None)


def nodeseek_http_checkin_sync(channel, proxy=None, random_flag="false", timeout=30):
    """同步跑快路径（cloudscraper 是阻塞库，调用方用 asyncio.to_thread 包起来）。

    返回 (verdict, message, gain, current, cookie_header)。cookie_header 是站点在响应里
    下发的 Cookie（若有），供写回渠道。
    """
    import cloudscraper  # 延迟导入：没装这个库时整条链路照常退回浏览器流程

    base = channel["baseUrl"].rstrip("/")
    cookie_dict = nodeseek_cookie_dict(channel)
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "desktop": True}
    )
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Content-Length": "0",
        "Origin": base,
        "Referer": f"{base}/board",
        "User-Agent": NODESEEK_UA,
    }
    # 代理：只喂 http(s) 给 cloudscraper（SOCKS 需要 PySocks，池子里不一定有）
    proxies = None
    if proxy and not str(proxy).startswith("socks"):
        proxies = {"http": proxy, "https": proxy}
    url = f"{base}{NODESEEK_ATTEND_PATH}?random={random_flag}"
    resp = scraper.post(
        url, headers=headers, cookies=cookie_dict, proxies=proxies, timeout=timeout
    )
    verdict, message, gain, current = nodeseek_http_verdict(resp.status_code, resp.text)
    return verdict, message, gain, current, (resp.headers.get("set-cookie") or "")


async def nodeseek_http_checkin(channel, proxy=None) -> dict:
    """快路径入口：返回结果 dict；返回 None 表示「这条路走不通，交给真浏览器」。

    判定为 session_dead 时**直接返回失败**（不再开浏览器）：会话失效换出口无解，
    开一次 Camoufox 只是白烧一分钟。
    """
    name = channel.get("name", "unnamed")
    if not forum_cookie_pairs(channel):
        return None  # 没 Cookie 就没什么可发的，交给浏览器流程（它可能用账密登录）
    try:
        verdict, message, gain, current, set_cookie = await asyncio.to_thread(
            nodeseek_http_checkin_sync, channel, proxy
        )
    except ImportError:
        log(f"  ⚡ {name}: 未安装 cloudscraper，跳过快路径（走真浏览器）")
        return None
    except Exception as e:  # noqa: BLE001
        log(f"  ⚡ {name}: 快路径失败（{str(e)[:90]}），交给真浏览器")
        return None

    where = "直连" if not proxy else f"代理 {mask_proxy(proxy)}"
    if verdict in ("ok", "already"):
        parts = [message or ("今日已签到" if verdict == "already" else "签到成功")]
        if current is not None:
            parts.append(f"鸡腿余额 {current}")
        log(f"  ⚡ {name}: 快路径命中（{where}，cloudscraper）→ {parts[0]}")
        out = {
            "name": name,
            "ok": True,
            "message": " · ".join(parts)[:300],
            "result": {
                "success": True,
                "alreadyCheckedIn": verdict == "already",
                "rewardPoints": gain if isinstance(gain, (int, float)) else None,
                "balance": current,
                "via": f"{NODESEEK_ATTEND_PATH}?random=false（cloudscraper）",
            },
        }
        if set_cookie:
            merged = merge_cookie_header(forum_cookie_pairs(channel), set_cookie)
            if merged:
                out["newTokens"] = {"cookie": merged}
        return out
    if verdict == "session_dead":
        log(f"  ⚡ {name}: 快路径判定会话失效（{where}）")
        return {
            "name": name,
            "ok": False,
            "retryable": False,
            "message": (
                f"{message}。请在浏览器里重新登录 https://www.nodeseek.com 后重抄整站 Cookie"
                "（或填「用户名 + 密码」让脚本登录换 Cookie）。"
            )[:300],
        }
    log(f"  ⚡ {name}: 快路径没成功（{where}）：{message}")
    return None


def merge_cookie_header(pairs, set_cookie_raw):
    """把响应里的 Set-Cookie 合并进渠道 Cookie（同名覆盖）。纯函数，便于离线测试。"""
    out = {}
    for name, value in pairs or []:
        if name:
            out[name] = value
    for chunk in str(set_cookie_raw or "").split(","):
        first = chunk.split(";")[0].strip()
        if "=" not in first:
            continue
        name, _, value = first.partition("=")
        name = name.strip()
        if name and not name.lower().startswith(("expires", "path", "domain", "max-age", "samesite")):
            out[name] = value.strip()
    return "; ".join(f"{k}={v}" for k, v in out.items())


async def forum_browser_checkin(channel, proxy=None) -> dict:
    """社区站的浏览器通道入口（按类型分流）。

    NodeSeek 先走 cloudscraper 快路径（参考 xinycai/nodeseek_signin：直接 POST
    /api/attendance?random=false，秒级完成）；只有它「走不通」时才退回真浏览器流程。
    """
    if channel.get("type") == "linuxsb":
        return await linuxsb_browser_checkin(channel, proxy=proxy)
    fast = await nodeseek_http_checkin(channel, proxy=proxy)
    if fast is not None:
        return fast
    return await nodeseek_browser_checkin(channel, proxy=proxy)



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
                ctype = ch.get("type")
                if ctype == "sub2api":
                    coro = sub2api_login_checkin(ch, proxy=proxy)
                elif ctype in FORUM_TYPES:
                    # 社区站（NodeSeek / linux.sb）：机制与 NewAPI 那套完全不同，
                    # 各有自己的流程（见 forum_browser_checkin）
                    coro = forum_browser_checkin(ch, proxy=proxy)
                else:
                    coro = checkin_one(ch, proxy=proxy)
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
