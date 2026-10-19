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
import base64
import contextlib
import contextlib
import contextlib
import datetime
import io
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
    """拟人点击 Cloudflare 挑战 iframe 的勾选框区域，返回点到的次数。

    三处等 token 的循环原本各自内联一份同样的代码，改预算时容易漏改一处。
    异常一律忽略：iframe 随时可能被 CF 换掉或移除，拿不到 bounding_box 是常态，
    下一轮重试即可。返回次数是给「多厂商同时」那条路用的 —— 它要在一轮里把
    Turnstile 与 hCaptcha 的勾选框都点一遍，日志里得看得出各点了几次。
    """
    hits = 0
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
                hits += 1
        except Exception:  # noqa: BLE001
            pass
    return hits


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
    # 「没出 token」「network-error」显式写上：多厂商那条失败文案里虽然含 "Turnstile"
    # 能侥幸命中，但缺 hCaptcha 时真正的原因是 hCaptcha 的网络错误，靠别的词匹配到
    # 属于巧合 —— 巧合一旦被文案改动打破，就会变成「不重试、当天漏签」。
    r"Turnstile|hCaptcha|token 为空|没出 token|network-error|超时|timeout|挂载失败|"
    r"ERR_|拒绝|blocked|403|\b5\d\d\b|challenge",
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

def attempt_reason(msg):
    """把一次出口尝试的失败文案压成一小段，用于「各出口：A → …；B → …」并列展示。

    多厂商那条失败文案里最有信息量的是「没出 token：缺 X（…）」，所以优先截它；
    截不到就退回前 70 字。压缩是必要的：面板只显示一条 message，四个出口的原话
    拼起来会超长，反而看不清。
    """
    s = str(msg or "")
    m = re.search(r"没出 token：([^（]*)", s)
    if m:
        return m.group(1).strip()[:50]
    m = re.search(r"组件失败[^：]*：([^（]*)", s)
    if m:
        return m.group(1).strip()[:50]
    return s[:70]



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


# 抽奖（sub2api 系：林夕 k40 / 百倍 100xlabs）。口径与 Worker 侧
# src/adapters/sub2api.js 完全一致，两处改动要一起改：
#   · 默认只花免费额度（cost_type=free）；活动分/余额是用户真实资产，
#     只有把渠道选项 lotteryCost 设成 auto / all 才会动；
#   · 每抽一次都用新的 idempotency_key（重复用同一个会被服务端去重，等于白抽）；
#   · 抽几次以服务端回的 today_remaining 为准，抽完即停；单次上限 30；
#   · 中途失败保留已抽到的结果，只把失败原因写进文案。
LOTTERY_HARD_CAP = 30

# 页内抽奖：状态查询 → 逐次 POST /api/v1/lottery → 回结构化结果（文案在 Python 侧拼）。
# 必须在页面里发请求：站点认同源 Origin/Referer，且 Bearer 与登录时是同一套。
JSFUNC_SUB2API_LOTTERY = """
async ([access, mode, cap]) => {
    const H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + access };
    const out = { ok: false, skipped: false, reason: '', failure: '', stop: '', draws: [], status: {} };
    const LABEL = { free: '免费额度', activity: '活动分', paid: '余额' };
    let st = null;
    try {
        const r = await fetch('/api/v1/lottery/status?timezone=Asia/Shanghai', { headers: H });
        const b = await r.json().catch(() => null);
        if (!b || b.code !== 0 || !b.data) {
            out.skipped = true;
            out.reason = '状态查询失败 HTTP ' + r.status;
            return out;
        }
        st = b.data;
    } catch (e) {
        out.skipped = true;
        out.reason = '状态查询异常 ' + ((e && e.message) || e);
        return out;
    }
    const costs = st.costs || {};
    const bal = { free: Number(st.free_balance), activity: Number(st.activity_score), paid: Number(st.balance) };
    out.status = {
        today_draws: st.today_draws,
        daily_draw_limit: st.daily_draw_limit,
        today_remaining: st.today_remaining,
        free_balance: st.free_balance,
        activity_score: st.activity_score,
        balance: st.balance,
    };
    if (st.enabled === false) { out.skipped = true; out.reason = '站点未开启抽奖活动'; return out; }
    if (st.window_open === false) { out.skipped = true; out.reason = '抽奖窗口未开放'; return out; }
    if (!st.can_draw) { out.skipped = true; out.reason = '站点当前不允许抽奖（can_draw=false）'; return out; }
    let remaining = Number(st.today_remaining || 0);
    if (!(remaining > 0)) {
        out.skipped = true;
        out.reason = '今日次数已用完（' + st.today_draws + '/' + (st.daily_draw_limit == null ? '?' : st.daily_draw_limit) + '）';
        return out;
    }
    const order = mode === 'all' ? ['free', 'activity', 'paid'] : (mode === 'auto' ? ['free', 'activity'] : ['free']);
    const pick = () => {
        const why = [];
        for (const k of order) {
            const c = costs[k] || {};
            const amt = Number(c.amount);
            if (!c.enabled) { why.push(LABEL[k] + '未开放'); continue; }
            if (!(amt > 0)) { why.push(LABEL[k] + '消耗额未配置'); continue; }
            if (!(bal[k] >= amt)) { why.push(LABEL[k] + '不足（需 ' + amt + '，现有 ' + bal[k] + '）'); continue; }
            return { type: k, amount: amt, why: '' };
        }
        return { type: null, amount: 0, why: why.join('；') || '没有可用的消耗方式' };
    };
    let cost = pick();
    if (!cost.type) { out.skipped = true; out.reason = cost.why; return out; }
    const budget = Math.min(remaining, cap > 0 ? cap : 30);
    for (let i = 0; i < budget; i++) {
        if (i > 0) {
            const next = pick();
            if (!next.type) { out.stop = next.why; break; }
            cost = next;
        }
        let b = null;
        let status = 0;
        try {
            const r = await fetch('/api/v1/lottery', {
                method: 'POST',
                headers: H,
                body: JSON.stringify({
                    cost_type: cost.type,
                    // 页面里 crypto 就是 window.crypto；用 typeof 兜一层，
                    // 免得在非浏览器环境（离线用例）里直接 ReferenceError
                    idempotency_key: (typeof crypto !== 'undefined' && crypto.randomUUID)
                        ? crypto.randomUUID()
                        : String(Date.now()) + '-' + String(Math.random()).slice(2),
                    boost: false,
                }),
            });
            status = r.status;
            b = await r.json().catch(() => null);
        } catch (e) {
            out.failure = '抽奖请求异常 ' + ((e && e.message) || e);
            break;
        }
        if (!b || b.code !== 0 || status >= 400) {
            out.failure = (b && (b.message || b.reason)) || ('HTTP ' + status);
            break;
        }
        const d = b.data || {};
        if (d.draw) out.draws.push(d.draw);
        if (d.today_remaining != null) remaining = Number(d.today_remaining);
        if (d.free_balance != null) bal.free = Number(d.free_balance);
        if (d.activity_score != null) bal.activity = Number(d.activity_score);
        if (d.balance != null) bal.paid = Number(d.balance);
        if (d.today_draws != null) out.status.today_draws = d.today_draws;
        out.status.today_remaining = remaining;
        out.status.free_balance = bal.free;
        out.status.activity_score = bal.activity;
        out.status.balance = bal.paid;
        if (!(remaining > 0)) break;
    }
    out.ok = out.draws.length > 0;
    return out;
}
"""


def lottery_amount_text(kind, amount) -> str:
    """抽奖额度文案：free 是站点额度、paid 是美元、activity 是活动分"""
    try:
        n = float(amount or 0)
    except (TypeError, ValueError):
        n = 0.0
    if kind == "paid":
        return f"${n:.4f}" if 0 < abs(n) < 0.01 else f"${n:.2f}"
    if kind == "activity":
        return f"活动分 {n:g}"
    if kind == "free":
        return f"免费额度 {n:g}"
    return f"{n:g}"


def lottery_note_text(res) -> str:
    """把页内抽奖结果拼成一句话（与 Worker 侧 lotterySummaryText 同一套口径）"""
    if not res:
        return ""
    if res.get("skipped"):
        return f"未抽奖：{res.get('reason') or '没有可用的消耗方式'}"
    draws = res.get("draws") or []
    if not draws:
        return f"抽奖失败：{res.get('failure') or '未知原因'}"
    wins = 0
    misses = 0
    rows = {}
    cost = {"free": 0.0, "activity": 0.0, "paid": 0.0}
    for d in draws:
        kind = str(d.get("prize_type") or "none")
        try:
            amount = float(d.get("prize_amount_actual") or d.get("prize_amount") or 0)
        except (TypeError, ValueError):
            amount = 0.0
        row = rows.setdefault((kind, amount), {"wins": 0})
        row["wins"] += 1
        if kind == "none" or amount <= 0:
            misses += 1
        else:
            wins += 1
        for k in cost:
            try:
                cost[k] += float(d.get("cost_" + k) or 0)
            except (TypeError, ValueError):
                pass
    parts = [f"抽奖 {len(draws)} 次：中奖 {wins} 次"]
    won = sorted(
        [(k, v) for k, v in rows.items() if k[0] != "none" and k[1] > 0],
        key=lambda kv: (-kv[0][1], -kv[1]["wins"]),
    )
    if won:
        parts.append("获得 " + "、".join(f"{lottery_amount_text(k, a)}×{v['wins']}" for (k, a), v in won))
    if misses:
        parts.append(f"未中奖 {misses} 次")
    spent = "、".join(lottery_amount_text(k, v) for k, v in cost.items() if v > 0)
    if spent:
        parts.append(f"消耗 {spent}")
    st = res.get("status") or {}
    if st.get("daily_draw_limit") is not None:
        parts.append(f"今日 {st.get('today_draws')}/{st.get('daily_draw_limit')}")
    if res.get("stop"):
        parts.append(f"提前结束：{res['stop']}")
    if res.get("failure"):
        parts.append(f"中途失败：{res['failure']}")
    return "，".join(parts)


async def auto_lottery_note(page, name, access, channel) -> str:
    """签到顺带自动抽奖（渠道选项 autoLottery，默认关）。

    整段包在 try 里：抽奖出任何问题都只追加一句说明，绝不推翻签到结论
    （与 Worker 侧 autoLotteryNote、linux.sb 的 autoGacha 同规矩）。
    """
    opt = channel.get("options") or {}
    if str(opt.get("autoLottery", "")).strip().lower() not in ("1", "true", "yes", "on"):
        return ""
    mode = str(opt.get("lotteryCost", "")).strip().lower()
    if mode not in ("free", "auto", "all"):
        mode = "free"
    try:
        cap = int(str(opt.get("lotteryMaxDraws", "")).strip() or 0)
    except ValueError:
        cap = 0
    if cap <= 0:
        cap = LOTTERY_HARD_CAP
    try:
        res = await page.evaluate(JSFUNC_SUB2API_LOTTERY, [access, mode, cap])
    except Exception as e:  # noqa: BLE001
        return f"抽奖异常：{str(e)[:120]}"
    note = lottery_note_text(res)
    if note:
        log(f"  🎰 {name}: {note}")
    return note


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
        # 5) 签到顺带自动抽奖（渠道选项 autoLottery，默认关）。
        #    与 Worker 侧同一套口径；抽奖出问题只追加说明，不推翻签到结论。
        lot_note = await auto_lottery_note(page, name, access, channel)
        if lot_note:
            rmsg += f" · {lot_note}"
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
# ---------------- NewAPI 图片验证码闸门 ----------------
#
# 站点：jianzhile.vip（NewAPI local-0.0.29 定制版）。2026-10-15 实测：
#
#   · /api/status 的 turnstile_check 是 false，但 /api/user/checkin 的回话里有
#     captcha_enabled: true —— 这是站点自己加的一层图片验证码，与 Turnstile /
#     reCAPTCHA 完全无关，所以既不能自挂组件，也不能靠点勾选框。
#   · 流程（站点前端 bundle 实测）：
#       POST /api/user/checkin/captcha → {captcha_id, captcha_image: "data:image/png;base64,…"}
#       POST /api/user/checkin         → {captcha_id, captcha_answer}
#   · **签到接口只认浏览器会话**：带访问令牌（Bearer + New-Api-User）一律回
#     「请打开网站后再签到」；同一请求换成 session cookie 立刻返回验证码图片。
#     而状态查询两种凭证都认 —— 所以「状态查得到、签到报请打开网站」正是这个闸门的
#     特征，不是凭证过期，别去引导用户重配访问令牌。
#   · 回话判据（逐条实测）：
#       答对且未签     → success:true + data.quota_awarded / checkin_date
#       答对但今天已签 → success:false +「今日已签到」
#                        （**验证码先于已签判定**，所以这句反过来证明答案是**对的**，
#                          不能当成失败，否则重试会一直烧到预算用尽）
#       答错           → 「验证码错误，请重试」
#       id 过期/复用   → 「验证码已失效，请刷新后重试」
#       没带验证码     → 「请输入验证码」
#       没有会话       → 「请打开网站后再签到」
#   · 服务端**区分大小写**：同一答案原样提交 9/12 通过、翻转大小写 0/12 通过（实测）。
#     所以 OCR 的大小写不能归一化，只能靠重试。
#
# 识别率与重试：本机实测单轮通过率约 70–75%（每次取新验证码独立重试），
# 六次尝试的失败概率约 0.3^6 ≈ 0.07%，对每日签到足够。

CAPTCHA_ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
CAPTCHA_BG = (252, 250, 248)  # 画布背景（BGR）
CAPTCHA_CELL_X0 = 16  # 第一个字形左边界
CAPTCHA_CELL_W = 26  # 字形间距
CAPTCHA_CELLS = 5  # 字形个数
CAPTCHA_ATTEMPTS = int(os.environ.get("CHECKIN_CAPTCHA_ATTEMPTS") or 6)
CAPTCHA_INK_THRESH = 320
# 单字裁剪的预处理：(pad, scale)。这三个是离线基准里唯一不拖后腿的组合 ——
# 把 colour / gray / pad20_s2 之类混进置信度竞争会让整串准确率下降
# （读错的字可以带着更高的置信度压过读对的字）。
CAPTCHA_VARIANTS = ((10, 3), (10, 1), (4, 4))

CAPTCHA_WRONG_RE = re.compile(r"验证码错误|验证码不正确|验证码有误")
CAPTCHA_EXPIRED_RE = re.compile(r"验证码已失效|请刷新后重试|验证码过期")
CAPTCHA_MISSING_RE = re.compile(r"请输入验证码")
CAPTCHA_NEEDS_SESSION_RE = re.compile(r"请打开网站后再签到|请打开网站")
# 2026-10-15 站点新增的一道闸：请求必须"从网站页面发起"。实测判据是 Origin / Referer
# 指向本域 —— 只带 Origin 或只带 Referer 都放行，两者都缺或指向别的站点则回这句。
# 与「请打开网站后再签到」分开匹配：那句是会话问题（换 cookie 能解），
# 这句是请求来源问题（换 cookie 没用，得补 Origin/Referer）。
CAPTCHA_NOT_FROM_PAGE_RE = re.compile(r"请从网站页面发起签到")


def classify_captcha_reply(body, status):
    """把签到回话归到一个动作上：ok / already / wrong / expired / missing /
    no_session / not_from_page / other。

    提成纯函数是为了能离线回归（scripts/test-captcha.py）—— 判据错一个方向就有代价：
    把「今日已签到」当成失败会无限重试烧光预算，把「验证码错误」当成成功会让用户
    以为签上了。注意「今日已签到」必须排在「验证码错误」之前判：站点是先校验验证码、
    再判是否已签，所以这句只会在答案正确时出现。
    """
    if not isinstance(body, dict):
        return "other"
    msg = str(body.get("message") or "")
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    if status == 200 and body.get("success") is True:
        return "ok"
    if ALREADY_RE.search(msg) or data.get("already_checked_in") is True:
        return "already"
    if CAPTCHA_EXPIRED_RE.search(msg):
        return "expired"
    if CAPTCHA_WRONG_RE.search(msg):
        return "wrong"
    if CAPTCHA_MISSING_RE.search(msg):
        return "missing"
    # 「请从网站页面发起签到」要排在 no_session 之前判：两句都含「签到」，
    # 而 no_session 的正则只认「请打开网站」，不会误命中这句 —— 但反过来若有人
    # 把 no_session 的正则放宽到「请打开网站|请从网站」，就会把来源问题误报成会话问题。
    if CAPTCHA_NOT_FROM_PAGE_RE.search(msg):
        return "not_from_page"
    if CAPTCHA_NEEDS_SESSION_RE.search(msg):
        return "no_session"
    return "other"


def _captcha_deps():
    """按需导入 OCR 依赖，缺了就给一句能照做的提示，而不是 ImportError 堆栈。"""
    try:
        import cv2  # noqa: PLC0415
        import ddddocr  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        return None, (
            f"缺少图片验证码识别依赖（{e}）。浏览器通道需要 ddddocr + opencv-python + "
            f"pillow + numpy：pip install ddddocr opencv-python pillow numpy"
        )
    return (cv2, ddddocr, np, Image), ""


_CAPTCHA_OCR = None


def _captcha_ocr():
    """进程内复用同一个 ddddocr 实例（模型加载要几百毫秒，别每次签到都重来）。"""
    global _CAPTCHA_OCR
    if _CAPTCHA_OCR is None:
        deps, err = _captcha_deps()
        if deps is None:
            raise RuntimeError(err)
        ocr = deps[1].DdddOcr(show_ad=False)
        # 收窄到字母数字：默认字符集含几千个汉字，本验证码只出 alnum，
        # 放开会让 ddddocr 把 'b' 读成「日」这类形近字（实测）。
        ocr.set_ranges(CAPTCHA_ALNUM)
        _CAPTCHA_OCR = ocr
    return _CAPTCHA_OCR


def captcha_cell_masks(bgr, np):
    """把验证码切成 5 个字形掩码，返回长度 5 的列表（读不出字形的位为 None）。

    单独提出来是为了能离线回归（scripts/test-captcha.py 用合成图测几何）：
    ddddocr 装不上时也要能验证"切分对不对"，因为切错位是整串必错的原因。

    版面实测（jianzhile.vip，2026-10-15）：
      · 画布 160x58，背景 BGR (252,250,248)；
      · 一条浅色干扰色带横穿整幅，距背景仅 146..247 —— 阈值必须高于它；
      · 5 个字形落在 x = 16 + 26*i，每个约 12x18，笔画距背景 427..670。
    按固定网格切而不是按连通域/颜色聚类：连通域会被色带切断（一个字形裂成两三块），
    颜色聚类会把两种偏红的字形并成一簇（实测距离只有 126），两者都会少字。
    """
    bg = np.array(CAPTCHA_BG, dtype=int)
    height, width = bgr.shape[:2]
    out = []
    for i in range(CAPTCHA_CELLS):
        x0 = CAPTCHA_CELL_X0 + CAPTCHA_CELL_W * i
        sub = bgr[:, x0 : min(width, x0 + CAPTCHA_CELL_W)]
        dist = np.abs(sub.astype(int) - bg).sum(axis=2)
        mask = (dist > CAPTCHA_INK_THRESH).astype(np.uint8)
        ys, xs = np.nonzero(mask)
        # 太少的像素不是字形（多半是色带残渣）
        if len(xs) < 15:
            out.append(None)
            continue
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        xa, xb = int(xs.min()), int(xs.max()) + 1
        # 尺寸不合理时同样放弃：宁可留 '?' 让上层换一张图，也别把残渣当字读
        if not (6 <= (y1 - y0) <= 34 and 4 <= (xb - xa) <= 24):
            out.append(None)
            continue
        out.append(mask[y0:y1, xa:xb])
    return out
def solve_image_captcha(png_bytes):
    """识别 5 位图片验证码，返回字符串（读不出的位留 '?'）。

    每个字格跑 CAPTCHA_VARIANTS 里的几种预处理，取置信度最高的那个读数 ——
    比多数投票更准：变体之间经常只有 2:1 的分歧，而对的那个置信度明显更高。
    切分见 captcha_cell_masks()。
    """
    deps, err = _captcha_deps()
    if deps is None:
        raise RuntimeError(err)
    cv2, _ddddocr, np, Image = deps
    ocr = _captcha_ocr()

    img = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        return ""
    bgr = img[:, :, :3]
    chars = []
    for crop in captcha_cell_masks(bgr, np):
        if crop is None:
            chars.append("?")
            continue
        binary = np.full((*crop.shape, 3), 255, np.uint8)
        binary[crop == 1] = (0, 0, 0)

        best, best_conf = "", 0.0
        for pad, scale in CAPTCHA_VARIANTS:
            canvas = cv2.copyMakeBorder(
                binary, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(255, 255, 255)
            )
            canvas = cv2.resize(
                canvas,
                (canvas.shape[1] * scale, canvas.shape[0] * scale),
                interpolation=cv2.INTER_LANCZOS4,
            )
            buf = io.BytesIO()
            Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)).save(buf, format="PNG")
            try:
                read = ocr.classification(buf.getvalue(), probability=True)
            except Exception:  # noqa: BLE001
                continue
            text = (read or {}).get("text") or ""
            if len(text) != 1:
                continue
            conf = 1.0
            try:
                for pos in (read or {}).get("probabilities") or []:
                    conf *= float(np.asarray(pos, dtype=float).max())
            except Exception:  # noqa: BLE001
                conf = 0.5
            if conf > best_conf:
                best, best_conf = text, conf
        chars.append(best or "?")
    return "".join(chars)


async def captcha_status_enabled(page, token):
    """读 /api/user/checkin?month= 的 captcha_enabled，判断站点是否开了图片验证码。

    用状态接口而不是"先空手 POST 一枪看回话"：状态查询是只读的、不消耗验证码，
    也不会在站点留下一次失败记录。读不到时返回 None（未知），由调用方决定怎么办。
    """
    headers_js = auth_headers_js(token)
    try:
        got = await asyncio.wait_for(
            page.evaluate(
                ("""async (headersJs) => {
                    MERGE_AUTH
                    const month = new Date().toISOString().slice(0, 7);
                    const res = await fetch('/api/user/checkin?month=' + month, {
                        credentials: 'include', headers: __h,
                    });
                    let b = null; try { b = await res.json(); } catch (e) {}
                    const d = (b && b.data) || {};
                    return {
                        status: res.status,
                        enabled: !!d.enabled,
                        captcha: d.captcha_enabled === true,
                        checkedInToday: !!(d.stats && d.stats.checked_in_today),
                        message: (b && b.message) || '',
                    };
                }""").replace("MERGE_AUTH", JSFUNC_MERGE_AUTH),
                headers_js,
            ),
            timeout=STATUS_QUERY_TIMEOUT_S,
        )
        return got if isinstance(got, dict) else None
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠️ 验证码状态查询失败: {str(e)[:100]}")
        return None

async def session_alive(page):
    """只带 session cookie 问一次 /api/user/self，判断会话是否还有效。

    两个头必须这样配，缺一不可（2026-10-15 逐条实测）：
      · **带** New-Api-User：该站把它当强制头，缺了直接 401
        「Unauthorized, New-Api-User header not provided」—— 与 session 好坏无关。
        踩过这个坑：探测漏发该头时，一个**完全有效**的 session 也被判成失效，
        于是每次运行都白登录一次。所以这里用 MERGE_AUTH 从 localStorage.user.id 取它。
      · **不带** Authorization：这是探测的全部意义。该站状态查询两种凭证都认，
        带令牌的查询在会话失效时照样 200，用它判断会话等于没判；而不带 Authorization
        时只可能靠 session 通过 —— 有效 → 200，失效 → 401
        「not logged in and no access token provided」（实测：真 session 200 /
        伪造 session 401）。

    这是只读请求，不消耗验证码、不在站点留失败记录，所以可以在签到前先探一次，
    会话过期就主动换新的 —— 比"等签到接口拒绝再补救"少一次往返，也不依赖拒绝文案
    （站点当天就新增过一条「请从网站页面发起签到」，光靠文案匹配很脆）。

    返回 True/False；探测本身失败（网络异常）时返回 None，调用方按"未知"处理，
    不要因为探不通就误判成会话失效。
    """
    try:
        got = await asyncio.wait_for(
            page.evaluate(
                # headersJs 传空对象：MERGE_AUTH 只补 New-Api-User，绝不带 Authorization
                ("""async (headersJs) => {
                    MERGE_AUTH
                    const res = await fetch('/api/user/self', {
                        credentials: 'include', headers: __h,
                    });
                    let b = null; try { b = await res.json(); } catch (e) {}
                    return {
                        status: res.status,
                        success: !!(b && b.success),
                        id: (b && b.data && b.data.id) || null,
                        message: (b && b.message) || '',
                    };
                }""").replace("MERGE_AUTH", JSFUNC_MERGE_AUTH),
                "{}",
            ),
            timeout=STATUS_QUERY_TIMEOUT_S,
        )
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠️ 会话探测失败（按未知处理）: {str(e)[:100]}")
        return None
    if not isinstance(got, dict):
        return None
    if got.get("status") == 200 and got.get("success") and got.get("id"):
        return True
    return False



async def fetch_captcha(page, token):
    """页内 POST /api/user/checkin/captcha，返回 {captcha_id, captcha_image} 或 None。"""
    headers_js = auth_headers_js(token)
    try:
        got = await asyncio.wait_for(
            page.evaluate(
                ("""async (headersJs) => {
                    MERGE_AUTH
                    const res = await fetch('/api/user/checkin/captcha', {
                        method: 'POST', credentials: 'include', headers: __h,
                    });
                    let b = null; try { b = await res.json(); } catch (e) {}
                    const d = (b && b.data) || {};
                    return {
                        status: res.status,
                        success: !!(b && b.success),
                        message: (b && b.message) || '',
                        captcha_id: d.captcha_id || '',
                        captcha_image: d.captcha_image || '',
                    };
                }""").replace("MERGE_AUTH", JSFUNC_MERGE_AUTH),
                headers_js,
            ),
            timeout=STATUS_QUERY_TIMEOUT_S,
        )
        return got if isinstance(got, dict) else None
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠️ 取验证码失败: {str(e)[:100]}")
        return None


async def submit_captcha(page, token, captcha_id, answer):
    """页内 POST /api/user/checkin {captcha_id, captcha_answer}，返回 {status, body}。"""
    headers_js = auth_headers_js(token)
    return await page.evaluate(
        ("""async ([cid, ans, headersJs]) => {
            MERGE_AUTH
            const res = await fetch('/api/user/checkin', {
                method: 'POST', credentials: 'include',
                headers: { ...__h, 'Content-Type': 'application/json' },
                body: JSON.stringify({ captcha_id: cid, captcha_answer: ans }),
            });
            let body = null; try { body = await res.json(); } catch (e) {}
            return { status: res.status, body };
        }""").replace("MERGE_AUTH", JSFUNC_MERGE_AUTH),
        [captcha_id, answer, headers_js],
    )


async def _captcha_checkin_run(page, name, base, token, tz, channel, attempts, state):
    """图片验证码签到：取图 → OCR → 提交，答错就换一张重来。

    为什么要重试而不是一次定生死：单轮识别率实测约 70–75%，每次都是独立的新验证码，
    六次的失败概率约 0.07%。重试的代价只有一次 HTTP 往返（~1.5s），远低于换代理重试。

    为什么要先 GET 一次状态：站点是「验证码先校验、再判是否已签」，所以已经签过的
    日子答对也会回「今日已签到」。先查状态就能在已签时直接返回，省掉取图 + OCR，
    也避免把「今日已签到」误读成需要重试。

    会话自愈（**主动**）：签到接口只认 session cookie（访问令牌无效），而 session 有
    有效期。所以进页面后先用 session_alive() 只读探一次会话：失效且渠道存了账密时，
    立刻用账密换一个新 session 再开始签到 —— 换到的 cookie 经 newTokens 回传，面板
    写回 KV，之后直接复用，用户不必手抄。探不通（网络异常）或没存账密时不预判，
    照常往下走，由服务端回话决定；真被拒了还有一轮被动补救（renew_session）。
    """
    deps, err = _captcha_deps()
    if deps is None:
        return {"name": name, "ok": False, "retryable": False, "message": err}

    auth = (channel or {}).get("auth") or {}
    username = auth.get("username") or auth.get("email") or ""
    password = auth.get("password") or ""
    user_id = str(auth.get("userId") or auth.get("newApiUser") or "").strip()
    renew_tried = False

    async def renew_session():
        nonlocal renew_tried
        if renew_tried or not (username and password):
            return False
        renew_tried = True
        got = await login_for_session(page, name, base, username, password, user_id)
        if not got.get("session"):
            log(f"  ⚠️ {name}: 会话失效且账密登录未换到 session（{got.get('why') or '未知'}）")
            return False
        state["fresh_cookie"] = got["cookie"]
        pairs = parse_cookie_pairs(got["cookie"])
        if pairs:
            host = base.split("//", 1)[1].split("/", 1)[0]
            domain = host[4:] if host.startswith("www.") else host
            await page.context.add_cookies(
                [{"name": n, "value": v, "domain": domain, "path": "/"} for n, v in pairs]
            )
        log(f"  🔑 {name}: 会话失效，已用账密换到新 session，重试")
        return True

    # 主动会话自愈：先只读探一次会话，失效就用账密换新的再开始。
    # 放在状态查询之前：会话失效时「今日已签到」也读不准（状态查询走令牌能通，
    # 但拿到的仍是站点数据，不影响判断；这里提前换新是为了让后续取图一次成功）。
    if username and password:
        alive = await session_alive(page)
        if alive is False:
            log(f"  🔑 {name}: 会话已失效，签到前先用账密换新 session")
            if not await renew_session():
                log(f"  ⚠️ {name}: 账密未能换到新 session，继续用原 cookie 试")

    st = await captcha_status_enabled(page, token)
    if st and st.get("checkedInToday"):
        return {
            "name": name,
            "ok": True,
            "message": "今日已签到（状态查询确认，未消耗验证码）",
        }

    last_msg = ""
    attempt = 0
    while attempt < attempts:
        attempt += 1
        got = await fetch_captcha(page, token)
        if not got or not got.get("captcha_id") or not got.get("captcha_image"):
            reason = (got or {}).get("message") or "接口未返回验证码"
            # 没有会话时这个接口就是这个回话：先试账密自愈，换不到再给出可照做的指引。
            # 换出口 / 重试都没用，所以标不可重试。
            # 站点新增的来源闸：请求必须"从网站页面发起"（实测认 Origin / Referer）。
            # 页内 fetch 天然带这两个头，所以走到这里说明页面上下文有问题（例如被甩到
            # 了别的 origin），换 cookie / 换出口都没用，直接说清是来源问题。
            if CAPTCHA_NOT_FROM_PAGE_RE.search(str(reason)):
                return {
                    "name": name,
                    "ok": False,
                    "retryable": False,
                    "message": (
                        f"服务端回「{reason}」：该站要求请求从站点页面发起（认 Origin / "
                        "Referer）。浏览器通道的页内 fetch 本应自带这两个头，出现这句通常"
                        "意味着页面被重定向到了别的域名。请确认站点地址填写正确，"
                        "并检查该站是否改了域名。"
                    ),
                }
            if CAPTCHA_NEEDS_SESSION_RE.search(str(reason)):
                if await renew_session():
                    attempt -= 1  # 换会话不算一次识别机会
                    continue
                return {
                    "name": name,
                    "ok": False,
                    "retryable": False,
                    "message": (
                        "签到接口要求浏览器会话，但渠道里没有可用的 session cookie，"
                        "服务端回「请打开网站后再签到」。请在该渠道的 Cookie 栏粘贴浏览器里"
                        "已登录的 session（F12 → Application → Cookies），或补上账密让脚本"
                        "自动换会话；访问令牌对签到接口无效（状态查询仍可用）。"
                    ),
                }
            return {
                "name": name,
                "ok": False,
                "retryable": False,
                "message": f"取验证码失败：{reason}",
            }

        cid = got["captcha_id"]
        raw_b64 = str(got["captcha_image"]).split(",", 1)[-1]
        try:
            png = base64.b64decode(raw_b64)
        except Exception as e:  # noqa: BLE001
            return {"name": name, "ok": False, "retryable": False, "message": f"验证码图片解码失败：{e}"}
        try:
            answer = solve_image_captcha(png)
        except Exception as e:  # noqa: BLE001
            return {
                "name": name,
                "ok": False,
                "retryable": False,
                "message": f"验证码识别失败：{str(e)[:160]}",
            }
        if "?" in answer:
            # 有字格没读出东西，这一枪必错，别浪费一次提交
            log(f"  🔁 {name}: 第 {attempt} 次识别不完整（{answer}），换一张")
            continue

        res = await submit_captcha(page, token, cid, answer)
        body = res.get("body") if isinstance(res, dict) else None
        verdict = classify_captcha_reply(body, (res or {}).get("status"))
        srv = str((body or {}).get("message") or "")[:80]
        log(f"  🧩 {name}: 第 {attempt} 次 OCR={answer} → {verdict} {srv}")

        if verdict == "ok":
            return {
                "name": name,
                "ok": True,
                "message": checkin_message(True, body, res.get("status")),
                "raw": body,
            }
        if verdict == "already":
            # 站点先校验验证码再判已签，所以这句本身就是「答案对了」的证据
            return {
                "name": name,
                "ok": True,
                "message": "今日已签到（服务端在验证码通过后回「今日已签到」）",
                "raw": body,
            }
        if verdict == "not_from_page":
            return {
                "name": name,
                "ok": False,
                "retryable": False,
                "message": (
                    f"服务端回「{srv or '请从网站页面发起签到'}」：该站要求请求从站点页面"
                    "发起（认 Origin / Referer）。页内 fetch 本应自带，出现这句通常意味着"
                    "页面被重定向到了别的域名，请确认站点地址是否正确。"
                ),
                "raw": body,
            }
        if verdict == "no_session":
            if await renew_session():
                attempt -= 1  # 换会话不算一次识别机会
                continue
            return {
                "name": name,
                "ok": False,
                "retryable": False,
                "message": (
                    f"服务端回「{srv or '请打开网站后再签到'}」：渠道里的 session cookie "
                    "无效或已过期，且没有可用的账密来自动续期。请重新从浏览器复制 session "
                    "后更新该渠道，或补上账密。"
                ),
            }
        if verdict in ("wrong", "expired", "missing"):
            last_msg = srv or verdict
            continue
        return {
            "name": name,
            "ok": False,
            "retryable": False,
            "message": f"签到未成功：{srv or verdict}",
            "raw": body,
        }

    return {
        "name": name,
        "ok": False,
        # 识别率问题换出口没用，标不可重试，免得把 job 预算烧在换代理上
        "retryable": False,
        "message": (
            f"验证码连续 {attempts} 次识别 / 提交未通过（最后一次：{last_msg or '验证码错误'}）。"
            f"单轮通过率约七成，可调大 CHECKIN_CAPTCHA_ATTEMPTS 再试。"
        ),
    }


async def captcha_checkin(page, name, base, token, tz, channel=None, attempts=CAPTCHA_ATTEMPTS):
    """图片验证码签到（对外入口）：跑一遍流程，并把换到的 session 一并回传。

    单独包一层是为了让**所有**返回路径（成功、失败、超预算）都带上新 cookie ——
    续期成功但这次签到仍失败时（例如验证码连错 6 次），新 session 依然是有效的资产：
    不回写的话下一次运行又要重新登录一遍。面板侧对 newTokens 的处理与 ok 无关
    （src/index.js 的 ghResult 分支），所以失败结果带 cookie 也会被写回 KV。
    """
    state = {"fresh_cookie": ""}
    res = await _captcha_checkin_run(page, name, base, token, tz, channel, attempts, state)
    fresh = state.get("fresh_cookie") or ""
    if fresh:
        res["message"] = f"{res.get('message', '')} · 已用账密登录刷新 Cookie"[:300]
        res["newTokens"] = {"cookie": fresh}
    return res




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


# ---------------------------------------------------------------------------
# 人机验证（多厂商**同时**）：Turnstile / hCaptcha / reCAPTCHA
# ---------------------------------------------------------------------------
#
# 站点在 /api/status 里用 checkin_<vendor>_check 声明「签到需要哪几家人机验证」。
# 2026-10-15 实测星见雅把 checkin_turnstile_check 与 checkin_hcaptcha_check **同时**
# 打开，服务端要求两个 token 都非空：
#     不带 token / 只带一家            → 「人机验证 token 为空」
#     turnstile + hcaptcha 都带假的    → 「Turnstile 校验失败，请刷新重试！」
# 即：先要求「齐」，再按 Turnstile → hCaptcha 的顺序校验。站点前端也是这么干的 ——
# 把启用的 token 全部 append 到同一个 query 上（站点 bundle 的 URLSearchParams 逻辑）：
#     POST /api/user/checkin?turnstile=<ts>&hcaptcha=<hc>
# 所以这里必须支持**多家同时**，不能像以前那样在 hCaptcha / reCAPTCHA 之间二选一
# —— 二选一必然漏一家，表现为「token 为空」而反复重试。
#
# 注入 SDK 后等它就绪的上限。api.js 是异步加载的，注入完立刻 render 会拿到
# 「xxx 不可用」—— 线上踩过（2026-10-15 首次多厂商运行就是这么误报失败的）。
CAPTCHA_SDK_WAIT_S = int(os.environ.get("CHECKIN_CAPTCHA_SDK_WAIT_S") or 25)

CAPTCHA_VENDORS = {
    "turnstile": {
        "flag": "checkin_turnstile_check",
        "sitekey": "turnstile_site_key",
        "global": "turnstile",
        "sdk": "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
        "sdk_match": "challenges.cloudflare.com",
        "label": "Turnstile",
        # 失败时要在页面内探可达性的域名（见 CAPTCHA_REACH_JS）
        "hosts": ("challenges.cloudflare.com",),
    },
    "hcaptcha": {
        "flag": "checkin_hcaptcha_check",
        "sitekey": "hcaptcha_site_key",
        "global": "hcaptcha",
        "sdk": "https://js.hcaptcha.com/1/api.js?render=explicit",
        "sdk_match": "hcaptcha.com/1/api.js",
        "label": "hCaptcha",
        # 四个域名各有用途，缺一不可：js=SDK、newassets=勾选框/challenge iframe、
        # api=checksiteconfig/getcaptcha、api2=API 的备用域名（hCaptcha 自己也用它兜底）。
        # 只探一个会得出错误结论；api2 一起探是为了知道「换备用域名能不能绕开」。
        "hosts": (
            "js.hcaptcha.com",
            "newassets.hcaptcha.com",
            "api.hcaptcha.com",
            "api2.hcaptcha.com",
        ),
    },
    "recaptcha": {
        "flag": "checkin_recaptcha_check",
        "sitekey": "recaptcha_site_key",
        "global": "grecaptcha",
        "sdk": "https://www.google.com/recaptcha/api.js?render=explicit",
        "sdk_match": "recaptcha/api.js",
        "label": "reCAPTCHA",
        "hosts": ("www.google.com", "www.gstatic.com"),
    },
}


def captcha_vendors_from_status(st):
    """从 /api/status 算出签到需要哪几家人机验证（纯函数，便于离线回归）。

    只认 **checkin_<vendor>_check** 这个显式开关，**不回退**到全局的 turnstile_check /
    hcaptcha_check —— 那两个是登录/注册用的。星见雅就是活证据：turnstile_check=false
    而 checkin_turnstile_check=true，拿全局开关判断会得出「签到不需要 Turnstile」的
    错误结论，于是漏带 token、被服务端回「人机验证 token 为空」。

    老 fork 没有 checkin_* 键时返回空列表 —— 那种站交给既有的 Turnstile 探针流程，
    宁可漏判也不要误判（误判会给不需要验证码的站硬挂组件）。

    返回 [{"vendor", "sitekey", "label"}]，只含开关为真的项；sitekey 允许是空串，
    调用方据此给出「开关开了但没配 sitekey」的明确报错。
    """
    if not isinstance(st, dict):
        return []
    out = []
    for vendor, spec in CAPTCHA_VENDORS.items():
        if st.get(spec["flag"]) is not True:
            continue
        out.append(
            {
                "vendor": vendor,
                "sitekey": str(st.get(spec["sitekey"]) or "").strip(),
                "label": spec["label"],
            }
        )
    return out


def human_verification_missing(body):
    """服务端是不是在说「人机验证 token 不齐 / 校验失败」，返回点名的那家。

    返回 'empty'（token 没带齐）、厂商名（该家 token 被拒）或 ''（不是这类回话）。

    2026-10-15 星见雅实测的两句话都在这一组里，且都表示「只能重新取 token 再试」：
    换出口、换凭证都没用，所以调用方不要把它当成凭证问题去引导用户重配。
    """
    if not isinstance(body, dict):
        return ""
    msg = str(body.get("message") or "")
    if not msg:
        return ""
    if "人机验证" in msg and "为空" in msg:
        return "empty"
    low = msg.lower()
    for vendor, spec in CAPTCHA_VENDORS.items():
        if spec["label"].lower() in low and ("失败" in msg or "无效" in msg):
            return vendor
    return ""


async def read_site_status(page):
    """读 /api/status，**区分三种结果**：拿到配置 / 站点不可达 / 拿到了但没有 data。

    2026-09-27 线上报的「reCAPTCHA 站但 /api/status 没给出 sitekey」就是把这三种混成了
    一种：当时整站 521/502，fetch 回来的不是 JSON，于是 st 变成 {}，被误报成「站点没
    配置验证码」—— 而真相是站点宕机，重试和改配置都没用。返回 (st, err)。
    """
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
    return st, st_err


# 给每家验证码各挂一个自己的容器，token 收进 window.__capTokens[vendor]。
# 容器 id 带厂商名：以前只有一个 #self-rc，多家同时挂会互相覆盖。
CAPTCHA_MOUNT_JS = """(specs) => {
    if (!window.__capTokens) window.__capTokens = {};
    if (!window.__capErrors) window.__capErrors = {};
    if (!window.__capWidgets) window.__capWidgets = {};
    const out = { mounted: [], failed: [] };
    for (const sp of specs) {
        if (window.__capTokens[sp.vendor]) { out.mounted.push(sp.vendor); continue; }
        const api = window[sp.global];
        if (!api || typeof api.render !== 'function') {
            out.failed.push(sp.vendor + ':' + sp.global + ' 不可用');
            continue;
        }
        const id = 'self-cap-' + sp.vendor;
        let box = document.getElementById(id);
        if (!box) {
            box = document.createElement('div');
            box.id = id;
            box.style.cssText = 'position:fixed;left:8px;bottom:' + (8 + 88 * sp.idx)
                + 'px;z-index:2147483647;width:303px;height:78px';
            document.body.appendChild(box);
        }
        if (box.dataset.mounted === '1') { out.mounted.push(sp.vendor); continue; }
        try {
            // 存 widgetId：hCaptcha 的 iframe 初始化失败（challenge-error）时要 reset 后重挂，
            // 没有 id 就只能整页重来。
            window.__capWidgets[sp.vendor] = api.render(box, {
                sitekey: sp.sitekey,
                callback: (t) => { window.__capTokens[sp.vendor] = t; },
                'error-callback': (e) => { window.__capErrors[sp.vendor] = String(e); },
                'expired-callback': () => { delete window.__capTokens[sp.vendor]; },
                'response-field': false,
            });
            box.dataset.mounted = '1';
            out.mounted.push(sp.vendor);
        } catch (e) {
            out.failed.push(sp.vendor + ': render 抛错 ' + ((e && e.message) || e));
        }
    }
    return out;
}"""

# 重置并清空某几家的容器，好让下一轮 MOUNT_JS 重新 render。
# 为什么要 reset 而不是只清 DOM：hCaptcha 的 render 对同一容器重复调用会抛错，
# 而它的内部状态（已初始化的 iframe、已消耗的 challenge）也要一并丢掉。
CAPTCHA_REMOUNT_JS = """(specs) => {
    const cleared = [];
    for (const sp of specs) {
        const api = window[sp.global];
        const wid = (window.__capWidgets || {})[sp.vendor];
        try {
            if (api && typeof api.reset === 'function' && wid !== undefined && wid !== null) {
                api.reset(wid);
            }
        } catch (e) {}
        const box = document.getElementById('self-cap-' + sp.vendor);
        if (box) { box.dataset.mounted = ''; box.innerHTML = ''; }
        if (window.__capTokens) delete window.__capTokens[sp.vendor];
        if (window.__capErrors) delete window.__capErrors[sp.vendor];
        if (window.__capWidgets) delete window.__capWidgets[sp.vendor];
        cleared.push(sp.vendor);
    }
    return cleared;
}"""

# 失败时在**页面内**探一遍验证码厂商的域名可达性。
# 为什么非要在页面里探：GHA 上的失败是「iframe 初始化超时 / API 请求失败」，
# 而这类失败既可能是出口连不上，也可能是浏览器侧被拦（CSP、代理只对部分请求生效）。
# 从 Python 侧用裸 socket 探只能证明「出口能连」，不能证明「浏览器能连」——
# 2026-10-15 星见雅就是裸 socket 全通、浏览器里 hCaptcha 始终初始化失败。
CAPTCHA_REACH_JS = """async ([hosts, apiUrl]) => {
    const out = {};
    for (const h of hosts) {
        const url = 'https://' + h + '/';
        const t0 = Date.now();
        try {
            await fetch(url, { mode: 'no-cors', cache: 'no-store' });
            out[h] = 'ok ' + (Date.now() - t0) + 'ms';
        } catch (e) {
            out[h] = 'FAIL ' + String((e && e.message) || e).slice(0, 60);
        }
    }
    // 再打一次**真实接口**。上面那种「裸域名 + no-cors」的探法不可靠：hCaptcha 的
    // / 会 302，no-cors 下跟随跨域跳转可能被 ORB 拦掉，于是给出假阴性 ——
    // 2026-10-15 就差点据此下错结论。checksiteconfig 是 CORS 接口，能拿到响应
    // 才说明「浏览器里这个 API 真的可用」。
    if (apiUrl) {
        try {
            const t0 = Date.now();
            const r = await fetch(apiUrl, { cache: 'no-store' });
            const txt = await r.text();
            out['(真实接口 checksiteconfig)'] =
                'HTTP ' + r.status + ' ' + (Date.now() - t0) + 'ms len=' + txt.length;
        } catch (e) {
            out['(真实接口 checksiteconfig)'] =
                'FAIL ' + String((e && e.message) || e).slice(0, 60);
        }
    }
    return out;
}"""


# 补 SDK：只补缺的那几家。hCaptcha 对 createElement 注入的脚本照样能用（2026-09-27 实测）。
CAPTCHA_INJECT_JS = """(specs) => {
    const added = [];
    for (const sp of specs) {
        if (window[sp.global] && typeof window[sp.global].render === 'function') continue;
        const sel = 'script[src*="' + sp.sdk_match + '"]';
        if (document.querySelector(sel)) continue;
        const s = document.createElement('script');
        s.src = sp.sdk;
        s.async = true; s.defer = true;
        document.head.appendChild(s);
        added.push(sp.vendor);
    }
    return added;
}"""

# 一轮探测：token / 报错 / 组件 iframe 是否还在 / 全局 API 是否还在。
# 四样一起取回来，省得每轮多次 evaluate。
CAPTCHA_STATE_JS = """(specs) => {
    const srcs = [...document.querySelectorAll('iframe')].map(el => el.src || '');
    const out = {
        tokens: window.__capTokens || {},
        errors: window.__capErrors || {},
        iframes: {
            turnstile: srcs.some(s => s.includes('challenges.cloudflare.com')),
            hcaptcha: srcs.some(s => s.includes('hcaptcha.com')),
            recaptcha: srcs.some(s => s.includes('/recaptcha/api2/')),
        },
        globals: {},
    };
    for (const sp of specs) {
        out.globals[sp.vendor] =
            !!(window[sp.global] && typeof window[sp.global].render === 'function');
    }
    return out;
}"""

# 提交：把拿到的 token 全部 append 到 query 上（与站点前端逐字同构）。
# 用 URLSearchParams 而不是自己拼字符串，编码交给浏览器，避免 token 里的 +/= 被弄坏。
CAPTCHA_SUBMIT_JS = """async ([tokens, headersJs]) => {
    const __h = JSON.parse(headersJs || '{}');
    try {
        const u = JSON.parse(localStorage.getItem('user') || 'null');
        if (u && u.id != null) __h['New-Api-User'] = String(u.id);
    } catch (e) {}
    const qs = new URLSearchParams();
    for (const k of Object.keys(tokens)) {
        if (tokens[k]) qs.append(k, tokens[k]);
    }
    const q = qs.toString();
    const url = '/api/user/checkin' + (q ? '?' + q : '');
    const r = await fetch(url, { method: 'POST', credentials: 'include', headers: __h });
    let b = null; try { b = await r.json(); } catch (e) {}
    return { status: r.status, body: b, query: q.replace(/=[^&]{12}[^&]*/g, '=<token>').slice(0, 160) };
}"""


async def selfmounted_captcha_checkin(
    page, name, base, token, tz="Asia/Shanghai", why="", status=None
):
    """自己挂人机验证组件、拿到 token 自己提交签到（**支持多家同时**）。

    什么时候会走到这里：
      · 站点的 /console/personal 挂了，签到按钮压根不渲染（2026-09-27 星见雅就是
        ErrorBoundary 把正文换成「页面渲染出错，请刷新页面重试」）；
      · 站点在 /api/status 里显式声明了签到需要哪些人机验证（checkin_*_check），
        此时由 checkin_one 直接分流过来，比驱动站点 UI 更确定。
    页面崩不崩无所谓：状态查询与签到接口都是好的，只差 token。

    为什么必须支持多家同时（2026-10-15 星见雅实测）：
      · /api/status 里 checkin_turnstile_check=true **且** checkin_hcaptcha_check=true；
      · 服务端要求两个 token 都非空 —— 只带一家回「人机验证 token 为空」；
      · 两家都带（即使是假的）才往下走，且先校验 Turnstile（回「Turnstile 校验失败」）。
      旧实现用 use_hc 在 hCaptcha / reCAPTCHA 之间二选一，必然漏一家，于是每次都卡在
      「token 为空」，重试多少次都没用。

    提交形态与站点前端逐字同构（站点 bundle 用 URLSearchParams 拼的）：
        POST /api/user/checkin?turnstile=<ts>&hcaptcha=<hc>

    与自挂 Turnstile 的老路（checkin_one 里的单家流程）的差别：
      · sitekey 按厂商从 /api/status 取（turnstile_site_key / hcaptcha_site_key /
        recaptcha_site_key），开关只认 checkin_<vendor>_check；
      · 勾选框点法沿用 click_captcha_checkbox（已同时认 hCaptcha 与 reCAPTCHA 的
        iframe）与 click_challenge（Turnstile 的 iframe）。
    """
    st = status
    st_err = ""
    if st is None:
        st, st_err = await read_site_status(page)

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

    vendors = captcha_vendors_from_status(st)
    if not vendors:
        return {
            "name": name,
            "ok": False,
            "retryable": False,
            "message": (
                "/api/status 可达但没有声明任何签到人机验证（checkin_turnstile_check / "
                "checkin_hcaptcha_check / checkin_recaptcha_check 全为假）。可能站点刚关掉了"
                f"该校验，或改用了别家验证码；可直接再点一次签到验证（why={why or '无'}）"
            )[:300],
        }

    no_key = [v["label"] for v in vendors if not v["sitekey"]]
    if no_key:
        return {
            "name": name,
            "ok": False,
            "retryable": False,
            "message": (
                f"/api/status 说签到需要 {'/'.join(no_key)}，但没给出对应的 sitekey。"
                "站点配置不完整（或改了字段名），自挂组件无法进行；"
                f"请把这条报给站点方（why={why or '无'}）"
            )[:300],
        }

    labels = "/".join(v["label"] for v in vendors)
    log(
        f"  🔑 {name}: 站点声明签到需要 {labels}（共 {len(vendors)} 家），"
        f"自挂组件后一起提交 ?{'&'.join(v['vendor'] + '=' for v in vendors)}"
    )
    specs = [
        {
            "vendor": v["vendor"],
            "sitekey": v["sitekey"],
            "global": CAPTCHA_VENDORS[v["vendor"]]["global"],
            "sdk": CAPTCHA_VENDORS[v["vendor"]]["sdk"],
            "sdk_match": CAPTCHA_VENDORS[v["vendor"]]["sdk_match"],
            "idx": i,
        }
        for i, v in enumerate(vendors)
    ]

    # 挂之前先把页面激活：hCaptcha 的勾选框流程会看页面是否在前台/有焦点，
    # GHA 的 Xvfb 窗口默认可能不在前台。Turnstile 不看这个（所以它一直能出 token），
    # 这正好解释「同一页面上 Turnstile 成、hCaptcha 不成」。失败也无所谓，忽略异常。
    try:
        await page.bring_to_front()
        await page.evaluate("() => { try { window.focus(); } catch (e) {} }")
    except Exception:  # noqa: BLE001
        pass

    # 注入 SDK 后**必须等它就绪再挂**：api.js 是异步加载的，注入完立刻 render 会拿到
    # 「turnstile/hcaptcha 不可用」。线上踩过（2026-10-15 星见雅首次多厂商运行）：
    # 注入后直接挂一次、失败就判死，报「自挂 Turnstile/hCaptcha 组件失败：
    # ['turnstile:turnstile 不可用', 'hcaptcha:hcaptcha 不可用']」—— 其实只是脚本还没到。
    # 旧单厂商实现有这段等待（最多 20s），改多厂商时漏掉了，这里补回来。
    await page.evaluate(CAPTCHA_INJECT_JS, specs)
    mounted = {"mounted": [], "failed": []}
    sdk_deadline = time.monotonic() + CAPTCHA_SDK_WAIT_S
    while time.monotonic() < sdk_deadline:
        mounted = await page.evaluate(CAPTCHA_MOUNT_JS, specs)
        if mounted.get("mounted"):
            break
        await page.wait_for_timeout(1200)
        # 脚本标签可能也被 SPA 清掉，每轮补一次
        await page.evaluate(CAPTCHA_INJECT_JS, specs)
    log(f"  🧩 {name}: 挂载结果 {mounted}")
    if not mounted.get("mounted"):
        return {
            "name": name,
            "ok": False,
            "message": (
                f"自挂 {labels} 组件失败（等了 {CAPTCHA_SDK_WAIT_S}s）："
                f"{mounted.get('failed') or '未知'}。多半是站点 CSP 拦了 SDK 脚本，"
                f"或出口访问不到 challenges.cloudflare.com / js.hcaptcha.com"
                f"（why={why or '无'}）"
            )[:300],
        }
    if mounted.get("failed"):
        # 部分挂上也要继续：等 token 的那一轮会按缺失的厂商重挂
        log(f"  ⚠️ {name}: 部分组件暂未挂上 {mounted.get('failed')}，等 token 时会重试")

    # 等 token。每轮都要**重新确认组件还在** —— 2026-09-27 实测踩过：站点页面崩在
    # ErrorBoundary 上，SPA 会重渲染 / 换路由，我们挂上去的 div 与 script 标签**当场被
    # 清掉**（一轮后 window.hcaptcha 已 undefined、容器不存在、script 列表为空）。
    # 只在开头挂一次的话，后面几十秒全在点空气：点击次数照涨，token 永远不来。
    deadline = time.monotonic() + RECAPTCHA_BUDGET_S
    tokens = {}
    clicks = 0
    rebuilds = 0
    error_resets = 0
    state = {}
    while time.monotonic() < deadline:
        await page.wait_for_timeout(1500)
        state = await page.evaluate(CAPTCHA_STATE_JS, specs)
        tokens = state.get("tokens") or {}
        if all(tokens.get(v["vendor"]) for v in vendors):
            break
        errs = state.get("errors") or {}
        # 哪家的全局 API 或 iframe 没了就补哪家（不整批重挂，避免把已拿到的 token 弄丢）
        need = []
        reset = []
        for sp in specs:
            if tokens.get(sp["vendor"]):
                continue
            if not (state.get("globals") or {}).get(sp["vendor"]):
                await page.evaluate(CAPTCHA_INJECT_JS, [sp])
                need.append(sp)
            elif not (state.get("iframes") or {}).get(sp["vendor"]):
                need.append(sp)
            elif errs.get(sp["vendor"]):
                # 组件自己报了错（hCaptcha 的 network-error / challenge-error 就是
                # 「iframe 初始化失败」）→ 光等不会好，reset 后重挂一次。
                # 2026-10-15 星见雅实测：不 reset 的话组件报错后一直不出 token，
                # 90s 预算全烧在空等上。
                reset.append(sp)
        if reset and error_resets < 3:
            error_resets += 1
            log(
                f"  ♻️ {name}: 组件报错（{[sp['vendor'] + '=' + str(errs.get(sp['vendor']))[:40] for sp in reset]}），"
                f"reset 后重挂（第 {error_resets} 次）"
            )
            await page.evaluate(CAPTCHA_REMOUNT_JS, reset)
            await page.wait_for_timeout(1500)
            await page.evaluate(CAPTCHA_INJECT_JS, reset)
            await page.evaluate(CAPTCHA_MOUNT_JS, reset)
            need = []
        if need:
            rebuilds += 1
            if rebuilds <= 3:
                log(
                    f"  ♻️ 组件被页面重渲染清掉了，重新挂 "
                    f"{[sp['vendor'] for sp in need]}（第 {rebuilds} 次）"
                )
            await page.wait_for_timeout(2500)
            await page.evaluate(CAPTCHA_MOUNT_JS, need)
        # 点击：Turnstile 的勾选框在它自己的 iframe 里，hCaptcha / reCAPTCHA 在
        # frame=checkbox / api2/anchor 里，两套点法都要跑（谁在页面上就点谁）。
        clicks += await click_challenge(page) or 0
        clicks += await click_captcha_checkbox(page) or 0

    state = await page.evaluate(CAPTCHA_STATE_JS, specs)
    tokens = state.get("tokens") or {}
    missing = [v["label"] for v in vendors if not tokens.get(v["vendor"])]
    if missing:
        errs = state.get("errors") or {}
        # 在**页面内**探一遍缺失厂商的域名可达性，把结果写进文案。
        # 只有这样才能区分「出口连不上」与「浏览器侧被拦」：Python 侧裸 socket 探通
        # 不代表浏览器能加载（2026-10-15 星见雅就是裸 socket 全通、浏览器里 hCaptcha
        # 始终初始化失败，光看「组件报错=network-error」无从判断）。
        reach = {}
        probe_hosts = sorted(
            {
                h
                for v in vendors
                if not tokens.get(v["vendor"])
                for h in CAPTCHA_VENDORS[v["vendor"]].get("hosts", ())
            }
        )
        # 真实接口 URL：hCaptcha 的 checksiteconfig 是 CORS 接口，用它当「API 到底通不通」
        # 的判据（见 CAPTCHA_REACH_JS 里的说明）。
        api_url = ""
        hc = next((v for v in vendors if v["vendor"] == "hcaptcha" and not tokens.get("hcaptcha")), None)
        if hc and hc.get("sitekey"):
            site_host = base.split("//", 1)[-1].split("/", 1)[0]
            api_url = (
                "https://api.hcaptcha.com/checksiteconfig"
                f"?host={site_host}&sitekey={hc['sitekey']}&sc=1&swa=1"
            )
        if probe_hosts:
            try:
                reach = await asyncio.wait_for(
                    page.evaluate(CAPTCHA_REACH_JS, [probe_hosts, api_url]), timeout=40
                )
            except Exception as e:  # noqa: BLE001
                reach = {"(探测失败)": str(e)[:60]}
        return {
            "name": name,
            "ok": False,
            "message": (
                f"自挂 {labels} 组件 {RECAPTCHA_BUDGET_S}s 内没出 token："
                f"缺 {'/'.join(missing)}（点了 {clicks} 次、重建 {rebuilds} 次、"
                f"报错重置 {error_resets} 次，组件报错={errs}）。"
                f"页面内可达性={reach}。"
                "若可达性全 FAIL 则是出口/浏览器拦了验证码域名（换住宅出口）；"
                "若可达性 ok 但组件仍报 challenge-error，说明 iframe 能连上却没初始化，"
                "多半是该出口被 hCaptcha 判为高风险（换出口再试）"
            )[:700],
        }

    got = {v["vendor"]: tokens[v["vendor"]] for v in vendors}
    log(
        f"  🔑 {name}: 拿到 "
        + "、".join(f"{v['label']} {len(tokens[v['vendor']])} 字符" for v in vendors)
        + "，自己提交签到"
    )

    res = await page.evaluate(CAPTCHA_SUBMIT_JS, [got, auth_headers_js(token)])
    body = res.get("body") if isinstance(res.get("body"), dict) else {}
    ok = checkin_ok(body, res.get("status"))
    if not ok:
        # token 一次性，可能站点前端已经抢先签了 —— 状态查询才是权威
        done = await confirm_checked_in(page, token, name, tz)
        if done:
            done["message"] = f"{done['message']}（{labels}：自挂组件提交）"[:300]
            await attach_quota(page, done, token)
            return done
        # 「人机验证 token 为空 / Turnstile 校验失败」是**可重试**的：token 一次性、
        # 也可能这一轮恰好被判低分，换一轮/换出口重取即可。标清楚是哪一家，别让人
        # 以为是凭证问题。
        which = human_verification_missing(body)
        note = ""
        if which == "empty":
            note = "（服务端说 token 为空：确认站点声明的每一家都带上了）"
        elif which:
            label = CAPTCHA_VENDORS.get(which, {}).get("label", which)
            note = f"（{label} token 被拒：token 一次性，重取即可；机房 IP 常被判低分）"
        return {
            "name": name,
            "ok": False,
            "retryable": bool(which),
            "message": (
                f"{checkin_message(ok, body, res.get('status'))}"
                f"（{labels}：自挂组件提交，参数 {res.get('query') or '无'}）{note}"
            )[:300],
        }
    result = {
        "name": name,
        "ok": True,
        "message": f"{checkin_message(ok, body, res.get('status'))}（{labels}：自挂组件提交）"[:300],
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
        # 图片验证码闸门（jianzhile.vip 这类 NewAPI 定制站）必须排在 Turnstile 前面：
        # 它们的 /api/status 里 turnstile_check 是 false，下面那套自挂组件 + 空 token
        # 探针在它们身上只会白等 45s，最后把「请打开网站后再签到」当成不可重试的失败。
        # 判据取 /api/user/checkin 状态里的 captcha_enabled —— 只读、不消耗验证码。
        # 渠道可用 options.captchaCheckin 显式覆盖（true 强制走、false 强制跳过）。
        captcha_hint = (channel.get("options") or {}).get("captchaCheckin")
        if captcha_hint is not True:
            cst = await captcha_status_enabled(page, token)
            want_captcha = bool(cst and cst.get("captcha"))
            if captcha_hint is False:
                want_captcha = False
            if want_captcha:
                log(f"  🔐 {name}: 站点启用了签到图片验证码，走验证码通道（最多 {CAPTCHA_ATTEMPTS} 次）")
                res = await captcha_checkin(page, name, base, token, tz, channel)
                if res.get("ok"):
                    await attach_quota(page, res, token)
                return res


        # 站点在 /api/status 里显式声明了签到需要哪几家人机验证时，直接走「多厂商自挂」。
        # 这条路比驱动站点 UI 确定：站点页面可能崩在 ErrorBoundary 上（按钮压根不渲染），
        # 而签到接口本身是好的，只差 token。
        # 2026-10-15 星见雅实测 checkin_turnstile_check 与 checkin_hcaptcha_check 同时为真，
        # 服务端要求两个 token 都非空 —— 必须一次把两家都拿到（见 selfmounted_captcha_checkin）。
        # 例外：声明了 reCAPTCHA 时仍走站点 UI 驱动，因为 reCAPTCHA v2 的 token 与渲染它的
        # 那个页面 origin 强绑定，自挂组件拿到的 token 会被判低分（这条实测结论别改回去）。
        site_st = None
        try:
            site_st, site_st_err = await read_site_status(page)
        except Exception as e:  # noqa: BLE001
            site_st, site_st_err = None, str(e)[:80]
            log(f"  ⚠️ {name}: /api/status 读取异常 {site_st_err}")
        declared = captcha_vendors_from_status(site_st) if site_st else []
        if declared:
            kinds = [v["vendor"] for v in declared]
            if "recaptcha" in kinds:
                log(f"  🧩 {name}: 站点声明签到需要 {kinds}，含 reCAPTCHA → 走站点 UI 驱动")
            else:
                log(f"  🧩 {name}: 站点声明签到需要 {kinds} → 走多厂商自挂组件")
                return await selfmounted_captcha_checkin(
                    page, name, base, token, tz, "站点声明的签到人机验证", site_st
                )

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
            # 兜底：空 token POST 的回话点名「人机验证 token 为空 / 校验失败」时，按
            # **多厂商自挂**处理。这条要排在下面「与 Turnstile 无关」的分支之前，否则
            # 会被判成不可重试、当天直接漏签。
            # 2026-10-15 星见雅实测：它同时要 Turnstile 与 hCaptcha，缺任一只回
            # 「人机验证 token 为空」；这句不含「Turnstile」字样，靠下面的正则匹配不到。
            if human_verification_missing(pb):
                log(f"  🧩 {name}: 探针回话点名人机验证（{pmsg}），改走多厂商自挂组件")
                res = await selfmounted_captcha_checkin(
                    page, name, base, token, tz, f"探针回话：{pmsg}", site_st
                )
                if res.get("ok"):
                    await attach_quota(page, res, token)
                return res

            # 兜底：状态查询没看出 captcha_enabled（例如渠道缺 session，状态接口直接
            # 401），但空 token POST 的回话点名了验证码 —— 仍然按图片验证码站处理。
            # 「请打开网站后再签到」也要认：它就是本站缺会话时签到接口的固定话术，
            # 而它不含「验证码」二字，不显式匹配就会掉进下面「与 Turnstile 无关」的
            # 分支被判成不可重试，当天直接漏签。
            if (
                re.search(r"验证码", pmsg)
                or CAPTCHA_NEEDS_SESSION_RE.search(pmsg)
                or CAPTCHA_WRONG_RE.search(pmsg)
                or CAPTCHA_EXPIRED_RE.search(pmsg)
            ):
                log(f"  🔐 {name}: 探针回话点名图片验证码，改走验证码通道")
                res = await captcha_checkin(page, name, base, token, tz, channel)
                if res.get("ok"):
                    await attach_quota(page, res, token)
                return res

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
# 「已签到」词表。2026-10-14 补：站点对重复签到回的是「今天已完成签到，请勿重复操作」
# —— 旧词表里只有「已签到 / 已签过」，认不出「已完成签到」，于是把一次成功（或已签）
# 当成 unknown，白跑一趟浏览器流程。
# 注意别写成裸「请勿重复」：那会命中「请勿重复提交」这类**限流**措辞，把没签到误报成已签
# （与 src/adapters/forum.js 的 ALREADY_RE 同一个坑）。
ALREADY_SIGNED_RE = re.compile(
    r"已经?签到|已签过|已完成签到|今天已签|今日已签|请勿重复操作|重复签到|重复领取|重复打卡|already",
    re.I,
)

def looks_challenged(st):
    """页面是不是还停在 CF 挑战页上（多语言标题 + markup 兜底）。"""
    if CF_TITLE_RE.search(str(st.get("title") or "")):
        return True
    return bool(CF_MARKUP_RE.search(str(st.get("markup") or "")))


def forum_cookie_pairs(channel):
    return parse_cookie_pairs((channel.get("auth") or {}).get("cookie") or "")


def cookie_injection_url(channel):
    """注入 Cookie 时用哪个 URL（纯函数，便于离线测试）。

    **必须用站点自己的 URL，不能用「去掉 www 的 domain」**：Playwright 的 add_cookies
    传 domain="nodeseek.com" 时，Chromium 存的是 **host-only** cookie（只发给 nodeseek.com
    本身，不发给 www.nodeseek.com）—— 于是 NodeSeek 的会话 Cookie 一直没被带上，
    浏览器流程永远看到游客页（表现为 USER NOT FOUND /「登录后签到」）。
    2026-10-14 线上实测踩到：同一份 Cookie 用 cloudscraper 直连能签到成功，
    浏览器流程却报会话失效，差别就在这里。
    传 url 则按站点自己的 host 存 host-only cookie —— 与浏览器手动登录后的形态一致。
    """
    base = str(channel.get("baseUrl") or "").rstrip("/")
    return f"{base}/"


async def apply_channel_cookies(page, channel):
    """把渠道 Cookie 注入浏览器，返回注入条数。

    必须在**首次导航之前**调用：linux.sb 的签到是「打开页面时服务端顺手做掉」，
    Cookie 晚一步就等于让站点按未登录处理，白跑一趟。checkin_one 那支是在两次
    导航之间注入的，顺序不能照抄。
    """
    pairs = forum_cookie_pairs(channel)
    if not pairs:
        return 0
    url = cookie_injection_url(channel)
    await page.context.add_cookies(
        [{"name": n, "value": v, "url": url} for n, v in pairs]
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
    # 「今天已完成签到，请勿重复操作」这类回话站点是配 **HTTP 500** 发的（2026-10-14 实测），
    # 所以这里不能要求 status==200 —— 否则把「今天已经签过了」当成失败，还白跑代理重试。
    if ALREADY_SIGNED_RE.search(msg):
        return {"name": name, "ok": True, "already": True, "message": (msg or "今日已签到")[:300]}
    return None


def page_checkin_status(body_text):
    """从页面正文里读「今日签到获得鸡腿 N 个」—— 登录态 + 今天已签的**权威信号**。

    为什么需要它：签到接口对重复签到回 500 +「今天已完成签到」，而排行榜按 member_name
    匹配（渠道里填的可能是邮箱，与论坛显示名不同 → 匹配不上）。页面自己那行状态不受这两点
    影响，2026-10-14 实测原文：`今日签到获得鸡腿5个，当前排名第7122`。
    返回 gain（int）或 None。
    """
    m = re.search(r"今日签到获得鸡腿\s*(\d+)\s*个", str(body_text or ""))
    return int(m.group(1)) if m else None


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
            """页面内跑一遍：页面状态行/排行榜确认 → POST 签到 → 点站点按钮 → 再 POST。

            返回 (结果 or None, 最后一枪的响应)。None 表示「判定不了」，由调用方决定
            是去登录换 Cookie 还是如实报失败。

            先看**页面自己那行状态**（「今日签到获得鸡腿 N 个」）：它不受「渠道里填的是邮箱、
            排行榜按论坛显示名匹配」这类不一致影响，是登录态 + 今日已签最硬的信号
            （2026-10-14 实测：签到接口对重复签到回 500，靠排行榜又匹配不上邮箱）。
            """
            snap_now = await page_snapshot(page)
            page_gain = page_checkin_status(snap_now.get("body"))
            if page_gain is not None:
                return {
                    "name": name,
                    "ok": True,
                    "message": f"今日已签到（页面状态行确认）· 获得 {page_gain} 鸡腿"[:300],
                }, None
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
    # 诊断开关：渠道 options.skipFastPath=true 时强制走真浏览器流程
    # （用来单独验证浏览器那条路，例如排查「Cookie 到底有没有注入成功」）
    if str((channel.get("options") or {}).get("skipFastPath", "")).strip().lower() in ("1", "true", "yes"):
        log(f"  ⚡ {name}: 渠道要求跳过快路径（options.skipFastPath）→ 走真浏览器")
        return None
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
        # 每次出口的结果都留一份：全部失败时拼进文案。没有它，面板上只能看到
        # 「最后一次尝试」的失败原因，看不出到底试过哪些出口、各自卡在哪 ——
        # 2026-10-15 星见雅多厂商那次就是这样，hCaptcha 报 network-error 但
        # 无从判断是直连还是某个代理，只能靠猜。
        attempt_log = []
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
                if i:
                    r["message"] = f"{r.get('message', '')}（经{via}）"
                attempt_log.append((via, True, ""))
                break
            attempt_log.append((via, False, attempt_reason(r.get("message"))))
            # 结果里显式标了不可重试的直接停：这类失败换出口也解决不了，而每次尝试要烧
            # 45s+40s，重试三次足以把 JOB_BUDGET_S 吃光，尾部渠道当天就漏签了。
            if r.get("retryable") is False:
                log(f"  ⏹️ {name}: 该失败换出口无效，不再重试")
                break
            # 只有「拿不到 token / 网络层失败」才值得换出口；凭证类错误换 IP 也白搭
            if not RETRYABLE_VIA_PROXY.search(str(r.get("message", ""))):
                break
        # 试过多个出口且最终失败时，把每个出口的结果并列出来（面板只看得到最后一条）
        if not r.get("ok") and len(attempt_log) > 1:
            tried = "；".join(f"{v} → {m}" for v, ok, m in attempt_log if not ok)
            r["message"] = f"{r.get('message', '')} ｜ 各出口：{tried}"[:700]
        log(f"  {'✅' if r['ok'] else '❌'} {r['name']}: {r['message']}")
        results.append(r)
    report_results(results)
    with open("gha-results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    asyncio.run(main())
