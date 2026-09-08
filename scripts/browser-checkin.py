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
HEADLESS = (os.environ.get("CHECKIN_HEADLESS") or "true") != "false"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
# gorouter 全站默认 sitekey（kppq66 内置值）；其他站用渠道 options.turnstileSiteKey 覆盖
DEFAULT_SITEKEY = "0x4AAAAAAELziOpg1Y2gFtAt"
# UA 必须与 CloakBrowser 内核版本一致（chromium-146）：报更高版本号（如 150）会造成
# UA 与真实指纹不匹配，Cloudflare 静默不签发 challenge（render 成功但永不出 token）。


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


async def sub2api_login_checkin(channel) -> dict:
    """sub2api 站（百倍等）：账密登录。签到奖励在登录时发放。

    流程（与 gorouter 的页面内 fetch 同构）：
      1. CloakBrowser 打开 /login，从内嵌配置读 turnstile_site_key
      2. 页面内用该 sitekey 主动挂 Turnstile，拟人点击等 token
      3. 拿到 token 后页面内 fetch /api/v1/auth/login（带 turnstile_token），
         绕开前端表单校验
      4. 新 accessToken/refreshToken 回传 Worker 写回 KV
    """
    from cloakbrowser import launch_async

    name = channel.get("name", "unnamed")
    base = channel["baseUrl"].rstrip("/")
    auth = channel.get("auth") or {}
    email = auth.get("email") or auth.get("username") or ""
    password = auth.get("password") or ""
    if not (email and password):
        return {"name": name, "ok": False, "message": "缺少邮箱/密码，无法走登录流程"}

    browser = await launch_async(
        headless=HEADLESS,
        humanize=True,
        args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
              "--disable-blink-features=AutomationControlled", "--window-size=1366,768"],
    )
    try:
        context = await browser.new_context(
            viewport={"width": 1366, "height": 768}, user_agent=UA
        )
        page = await context.new_page()
        log(f"  🌐 {name}: 打开登录页 {base}/login")
        await page.goto(base + "/login", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(5000)

        # 1) 先填表（关键：widget 只在表单交互后才渲染，填表必须先于等 token）
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
                    document.querySelector('input[placeholder*=邮箱 i]');
                const pwdEl = document.querySelector('input[type=password]');
                if (!emailEl || !pwdEl) return { ok: false, hasEmail: !!emailEl, hasPwd: !!pwdEl };
                setVal(emailEl, email);
                setVal(pwdEl, password);
                return { ok: true };
            }""",
            [email, password],
        )
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
        return {
            "name": name,
            "ok": True,
            "message": "登录成功，已刷新 token",
            "newTokens": {"accessToken": access, "refreshToken": refresh},
        }
    except Exception as e:  # noqa: BLE001
        return {"name": name, "ok": False, "message": f"异常: {str(e)[:120]}"}
    finally:
        try:
            await browser.close()
        except Exception:  # noqa: BLE001
            pass

async def checkin_one(channel) -> dict:
    """单渠道：开浏览器 → Turnstile token → 页面内 fetch 签到。"""
    from cloakbrowser import launch_async

    name = channel.get("name", "unnamed")
    base = channel["baseUrl"].rstrip("/")
    sitekey = (channel.get("options") or {}).get("turnstileSiteKey") or DEFAULT_SITEKEY
    auth = channel.get("auth") or {}
    cookie_raw = auth.get("cookie") or ""
    token = auth.get("token") or ""

    browser = await launch_async(
        headless=HEADLESS,
        humanize=True,
        args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--window-size=1366,768",
        ],
    )
    try:
        context = await browser.new_context(
            viewport={"width": 1366, "height": 768}, user_agent=UA
        )
        page = await context.new_page()
        # 直接开首页（kppq66 成功行为；绕道 /login 会触发登录页自己的 Turnstile 干扰挂载）
        log(f"  🌐 {name}: 打开 {base}")
        await page.goto(base + "/", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(2000)
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
            "message": str(body.get("message") or ("HTTP " + str(checkin.get("status"))))[:120],
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


async def main():
    if not HUB:
        raise SystemExit("缺少 HUB_BASE_URL")
    channels = fetch_browser_channels()
    log(f"browser 通道渠道 {len(channels)} 个: {[c['name'] for c in channels]}")
    results = []
    for ch in channels:
        try:
            if ch.get("type") == "sub2api":
                r = await sub2api_login_checkin(ch)
            else:
                r = await checkin_one(ch)
        except Exception as e:  # noqa: BLE001
            r = {"name": ch.get("name", "?"), "ok": False, "message": str(e)[:150]}
        log(f"  {'✅' if r['ok'] else '❌'} {r['name']}: {r['message']}")
        results.append(r)
    report_results(results)
    with open("gha-results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    asyncio.run(main())
