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

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"


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
        log(f"  🌐 {name}: 打开 {base}/login（真实 sitekey 所在页）")
        await page.goto(base + "/login", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(4000)
        # 登录页探测：站点自带的 turnstile widget / 源码里的 sitekey
        login_probe = await page.evaluate(
            """() => {
                const html = document.documentElement.innerHTML;
                const m = html.match(/0x[A-Za-z0-9_\-]{20,}/g) || [];
                const keys = [...new Set(m)].slice(0, 5);
                const widgets = document.querySelectorAll('.cf-turnstile, [class*=turnstile]').length;
                return { keys, widgets };
            }"""
        )
        log(f"  🔑 {name}: /login 探测 {json.dumps(login_probe, ensure_ascii=False)[:300]}")
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
        page = await context.new_page()
        log(f"  🌐 {name}: 打开 {base}")
        await page.goto(base + "/", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(2000)

        # localStorage token 鉴权（有 system access token 的站）
        if token:
            await page.evaluate(
                """(t) => { try {
                     localStorage.setItem('token', t);
                     localStorage.setItem('user', JSON.stringify({ token: t }));
                   } catch(e) {} }""",
                token,
            )

        # 先探测页面自带的 Turnstile sitekey（站点自己会渲染 widget 或在源码里带 key）
        probe = await page.evaluate(
            """async () => {
                const html = document.documentElement.innerHTML;
                const m = html.match(/0x[A-Za-z0-9_-]{20,}/g) || [];
                let existing = null;
                document.querySelectorAll('.cf-turnstile').forEach(el => {
                    existing = existing || el.getAttribute('data-sitekey');
                });
                return { keys: [...new Set(m)].slice(0, 5), existing };
            }"""
        )
        log(f"  🔑 {name}: sitekey 探测 {json.dumps(probe, ensure_ascii=False)[:250]}")
        if probe.get("existing"):
            sitekey = probe["existing"]
        elif probe.get("keys") and sitekey == DEFAULT_SITEKEY:
            sitekey = probe["keys"][0]

        # 页面内挂载 Turnstile 并等待 token
        got = await page.evaluate(
            """async (sitekey) => {
                window._tsToken = null; window._tsError = null; window._tsRendered = false;
                if (!document.getElementById('cf-ts-box')) {
                    const d = document.createElement('div');
                    d.id = 'cf-ts-box'; document.body.appendChild(d);
                }
                const render = () => {
                    try {
                        window.turnstile.render('#cf-ts-box', {
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
                if (window.turnstile) { render(); }
                else {
                    const s = document.createElement('script');
                    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                    s.onload = () => render();
                    s.onerror = () => { window._tsError = 'api.js load failed'; };
                    document.head.appendChild(s);
                }
                return true;
            }""",
            sitekey,
        )
        if not got:
            return {"name": name, "ok": False, "message": "Turnstile 挂载失败"}
        await page.wait_for_timeout(1500)
        render_state = await page.evaluate(
            "() => ({ rendered: !!window._tsRendered, err: window._tsError })"
        )
        log(f"  🧩 {name}: render 状态 {json.dumps(render_state, ensure_ascii=False)}")

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
