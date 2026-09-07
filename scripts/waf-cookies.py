"""
浏览器通道第一步：用 CloakBrowser 解 WAF，产出 waf_cookies.json。

对每个 runner=gha_browser 的启用渠道，打开目标站点首页等待 WAF 挑战
自行完成（acw_sc__v2 / acw_tc / cf_clearance 写入 cookie），把结果写到
waf_cookies.json 供后续 Node runner（gha-checkin.mjs）合并使用。

环境变量：
  HUB_BASE_URL / HUB_SECRET / HUB_ACCESS_PASSWORD  同 Node runner
  CHECKIN_HEADLESS   "true"/"false"（xvfb 下用 false）
"""

import asyncio
import json
import os
import re
import urllib.request

HUB = (os.environ.get("HUB_BASE_URL") or "").rstrip("/")
PASSWORD = os.environ.get("HUB_ACCESS_PASSWORD") or ""
HEADLESS = (os.environ.get("CHECKIN_HEADLESS") or "true") != "false"
WAF_COOKIE_RE = re.compile(r"acw_tc|acw_sc__v2|cdn_sec_tc|cf_clearance|cf_chl", re.I)


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"


def hub_api(path, data=None, headers=None):
    """带浏览器 UA 请求面板。Cloudflare 会按 UA 拦截 Python-urllib 默认值（403）。"""
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


def fetch_channels():
    token = cookie = None
    if PASSWORD:
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
        token = body.get("token")
        cookie = setc.split(";")[0] if setc else None
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if cookie:
        headers["Cookie"] = cookie
    data = hub_api("/api/kv/channels", headers=headers)
    if not data.get("ok"):
        raise RuntimeError(f"拉取渠道失败: {data}")
    return [c for c in data.get("channels", []) if c.get("enabled", True) and c.get("baseUrl")]


async def solve(base_url: str, headless: bool):
    """打开目标站首页，等 WAF 挑战完成，返回 WAF cookie 字典。"""
    from cloakbrowser import launch_async

    browser = await launch_async(headless=headless)
    try:
        page = await browser.new_page()
        await page.goto(base_url + "/", wait_until="domcontentloaded")
        # WAF 脚本通常在 2-8 秒内写 cookie 并刷新；保守等 12s
        await page.wait_for_timeout(12000)
        cookies = await page.context.cookies()
        return {c["name"]: c["value"] for c in cookies if WAF_COOKIE_RE.search(c["name"])}
    finally:
        await browser.close()


async def main():
    if not HUB:
        raise SystemExit("缺少 HUB_BASE_URL")
    channels = [c for c in fetch_channels() if (c.get("options") or {}).get("runner") == "gha_browser"]
    print(f"browser 通道渠道 {len(channels)} 个")
    out = {}
    for ch in channels:
        name = ch.get("name", "unnamed")
        try:
            waf = await solve(ch["baseUrl"], HEADLESS)
            if waf:
                out[name] = {"baseUrl": ch["baseUrl"], "cookies": waf}
                print(f"  ✓ {name}: {'; '.join(waf.keys())}")
            else:
                print(f"  ✗ {name}: 未拿到任何 WAF cookie（可能被交互式挑战拦截）")
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {name}: {e}")
    with open("waf_cookies.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"已写出 waf_cookies.json（{len(out)} 个渠道）")


if __name__ == "__main__":
    asyncio.run(main())
