"""
图片验证码通道的离线回归测试（不联网、不开浏览器、不装 ddddocr 也能跑）。

跑法：python scripts/test-captcha.py

测的是判据与几何 —— 它们全是从线上实测反推出来的，改错一个方向就有代价：
  · 把「今日已签到」判成失败 → 重试烧光 job 预算，而且用户以为没签上；
  · 把「验证码错误」判成成功 → 用户以为签上了，实际当天漏签；
  · 把「请打开网站后再签到」判成凭证过期 → 引导用户去重新生成访问令牌（无用功，
    真正缺的是 session cookie）。
几何部分用合成图测：合成图不依赖 ddddocr，所以切分逻辑在任何环境都能回归。

线上实测语料（jianzhile.vip，2026-10-15，NewAPI local-0.0.29）：
  · 答对且未签     → {"success":true,"data":{"quota_awarded":5000000,"checkin_date":"2026-10-15"}}
  · 答对但已签     → {"message":"今日已签到","success":false}
  · 答错           → {"message":"验证码错误，请重试","success":false}
  · id 过期/复用   → {"message":"验证码已失效，请刷新后重试","success":false}
  · 没带验证码     → {"message":"请输入验证码","success":false}
  · 没有会话       → {"message":"请打开网站后再签到","success":false}
  · 访问令牌调取图 → {"message":"请打开网站后再签到","success":false}
  · 服务端区分大小写：原样提交 9/12 通过，翻转大小写 0/12 通过
"""

import importlib.util
import os
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    "browser_checkin", os.path.join(HERE, "browser-checkin.py")
)
mod = types.ModuleType("browser_checkin")
SPEC.loader.exec_module(mod)

failures = 0
checks = 0


def ok(cond, label, extra=""):
    global failures, checks
    checks += 1
    if cond:
        print(f"  \u2713 {label}")
    else:
        failures += 1
        print(f"  \u2717 {label}{' — ' + extra if extra else ''}")


print("\n[1] 签到回话判据（逐条抄线上实测）")
ok(
    mod.classify_captcha_reply(
        {"success": True, "data": {"quota_awarded": 5000000, "checkin_date": "2026-10-15"}}, 200
    )
    == "ok",
    "答对且未签 → ok",
)
ok(
    mod.classify_captcha_reply({"message": "今日已签到", "success": False}, 200) == "already",
    "答对但已签 → already（站点先校验验证码再判已签，这句是答案正确的证据）",
)
ok(
    mod.classify_captcha_reply({"message": "验证码错误，请重试", "success": False}, 200) == "wrong",
    "答错 → wrong（要换一张重试）",
)
ok(
    mod.classify_captcha_reply({"message": "验证码已失效，请刷新后重试", "success": False}, 200)
    == "expired",
    "id 过期/复用 → expired（也要换一张重试）",
)
ok(
    mod.classify_captcha_reply({"message": "请输入验证码", "success": False}, 200) == "missing",
    "没带验证码 → missing",
)
ok(
    mod.classify_captcha_reply({"message": "请打开网站后再签到", "success": False}, 200)
    == "no_session",
    "没有会话 → no_session（缺 session cookie，重试无用）",
)
ok(
    mod.classify_captcha_reply({"message": "今日已签到", "success": True}, 200) == "ok",
    "success:true 优先于文案（别把成功判成已签）",
)
ok(
    mod.classify_captcha_reply({"message": "别的错误", "success": False}, 200) == "other",
    "不认识的文案 → other（照实报，别猜）",
)
ok(mod.classify_captcha_reply(None, 200) == "other", "空响应体不抛异常")
ok(mod.classify_captcha_reply("not a dict", 200) == "other", "非 dict 响应体不抛异常")

print("\n[2] 判据顺序：已签必须排在验证码错误之前")
# 站点是「先校验验证码、再判已签」，所以「今日已签到」只会在答案正确时出现。
# 若哪天把 wrong 的判定提到 already 前面，一条成功的签到就会被当成失败重试。
body = {"message": "今日已签到", "success": False}
ok(mod.classify_captcha_reply(body, 200) == "already", "「今日已签到」不被误判成 wrong")
ok(
    not mod.CAPTCHA_WRONG_RE.search("今日已签到"),
    "验证码错误的正则不会命中「今日已签到」",
)

print("\n[3] 版面几何（合成图，不依赖 ddddocr）")
try:
    import numpy as np

    have_np = True
except Exception:  # noqa: BLE001
    have_np = False

if not have_np:
    print("  ⏭️ 未安装 numpy，跳过几何测试")
else:
    ok(mod.CAPTCHA_CELLS == 5, "字形个数 5")
    ok(mod.CAPTCHA_CELL_W == 26, "字形间距 26")
    ok(mod.CAPTCHA_CELL_X0 == 16, "首字左边界 16")
    ok(
        mod.CAPTCHA_INK_THRESH > 247,
        "阈值高于干扰色带距背景的最大值 247（否则色带会被当成笔画）",
    )
    ok(
        mod.CAPTCHA_INK_THRESH < 427,
        "阈值低于字形笔画距背景的最小值 427（否则浅色字形会被整字漏掉）",
    )

    def synth(band=True, glyphs=5, glyph_dark=600):
        """造一张同版面的图：背景 + 可选浅色带 + 若干深色字形块。"""
        img = np.zeros((58, 160, 3), np.uint8)
        img[:, :] = mod.CAPTCHA_BG
        if band:
            # 距背景 146..247 的浅色带，横穿整幅
            img[10:50, :] = (197, 164, 142)
        for i in range(glyphs):
            x0 = mod.CAPTCHA_CELL_X0 + mod.CAPTCHA_CELL_W * i + 4
            # 字形像素：距背景 >= glyph_dark
            img[24:42, x0 : x0 + 12] = (252 - glyph_dark // 3, 250 - glyph_dark // 3, 248 - glyph_dark // 3)
        return img

    masks = mod.captcha_cell_masks(synth(), np)
    ok(len(masks) == 5, "返回 5 个格子")
    ok(all(m is not None for m in masks), "带干扰色带时 5 个字形全部切出（色带被阈值滤掉）")
    if all(m is not None for m in masks):
        shapes = [m.shape for m in masks]
        ok(
            all(6 <= h <= 34 and 4 <= w <= 24 for h, w in shapes),
            f"字形尺寸都在合理范围：{shapes}",
        )
    # 真实字形（距背景 450，高于阈值）必须全部切出
    masks_real = mod.captcha_cell_masks(synth(glyph_dark=450), np)
    ok(all(m is not None for m in masks_real), "真实字形（距背景 450）5 个全部切出")

    # 低于阈值的笔画（距背景 249，与干扰色带同级）读不出来时，必须老实返回 None ——
    # 上层据此换一张图重试。硬把它当字读会得到必错的答案，白费一次提交。
    masks_below = mod.captcha_cell_masks(synth(glyph_dark=250), np)
    ok(
        all(m is None for m in masks_below),
        "低于阈值的笔画返回 None（换图重试，而不是硬读成错答案）",
    )

    # 缺字形时对应位必须是 None，让上层换图而不是硬读残渣
    masks_missing = mod.captcha_cell_masks(synth(glyphs=3), np)
    ok(
        masks_missing[3] is None and masks_missing[4] is None,
        "缺字形的位置返回 None（上层据此换一张图，不浪费一次提交）",
    )

    # 只有色带、没有字形时不应切出任何东西
    masks_band_only = mod.captcha_cell_masks(synth(glyphs=0), np)
    ok(all(m is None for m in masks_band_only), "只有干扰色带时不切出任何字形")

print("\n[4] 重试次数配置")
ok(mod.CAPTCHA_ATTEMPTS >= 3, f"默认重试次数 {mod.CAPTCHA_ATTEMPTS} >= 3（单轮约七成，三次≈97%）")

print("\n[5] 验证码签到流程（假 page 驱动真实 captcha_checkin）")

try:
    import asyncio

    have_ocr = mod._captcha_deps()[0] is not None
except Exception:  # noqa: BLE001
    have_ocr = False

if not have_ocr:
    print("  ⏭️ 未安装 ddddocr/cv2/numpy/pillow，跳过流程测试")
else:

    class FakePage:
        """只实现 captcha_checkin 用到的 page.evaluate，按 JS 特征分派。"""

        def __init__(self, status, captchas, submissions):
            self.status = status          # 状态查询回话
            self.captchas = list(captchas)  # 每次取图的回话
            self.submissions = list(submissions)  # 每次提交的回话
            self.fetched = 0
            self.submitted = []

        async def evaluate(self, js, arg=None):
            if "checkin/captcha" in js:
                got = self.captchas[min(self.fetched, len(self.captchas) - 1)]
                self.fetched += 1
                return got
            if "month=" in js:
                return self.status
            if "captcha_answer" in js:
                cid, ans = arg[0], arg[1]
                self.submitted.append(ans)
                return self.submissions[min(len(self.submitted) - 1, len(self.submissions) - 1)]
            raise AssertionError(f"unexpected JS: {js[:80]}")

        class _Ctx:
            async def add_cookies(self, cookies):
                self.added = list(cookies)

        @property
        def context(self):
            if not hasattr(self, "_ctx"):
                self._ctx = self._Ctx()
            return self._ctx

    # 一个最小的合法 PNG（1x1），让 base64 解码走得通；OCR 会被下面替换掉
    PNG_B64 = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
    )
    CAPTCHA_REPLY = {
        "status": 200,
        "success": True,
        "message": "",
        "captcha_id": "cid-1",
        "captcha_image": PNG_B64,
    }
    STATUS_NOT_CHECKED = {
        "status": 200,
        "enabled": True,
        "captcha": True,
        "checkedInToday": False,
        "message": "",
    }

    real_solver = mod.solve_image_captcha

    def run(coro):
        return asyncio.new_event_loop().run_until_complete(coro)

    # 5a) 第一次答错 → 换一张重试 → 第二次答对
    answers = iter(["abcde", "fghij"])
    mod.solve_image_captcha = lambda png: next(answers)
    page = FakePage(
        STATUS_NOT_CHECKED,
        [CAPTCHA_REPLY, CAPTCHA_REPLY],
        [
            {"status": 200, "body": {"success": False, "message": "验证码错误，请重试"}},
            {"status": 200, "body": {"success": True, "data": {"quota_awarded": 5000000}}},
        ],
    )
    res = run(mod.captcha_checkin(page, "t", "https://x", "tok", "Asia/Shanghai"))
    ok(res.get("ok") is True, "答错一次后重试成功", str(res)[:200])
    ok(page.fetched == 2, f"取了 2 张验证码（实际 {page.fetched}）")
    ok(page.submitted == ["abcde", "fghij"], f"提交顺序正确：{page.submitted}")

    # 5b) 识别不完整（含 '?'）→ 直接换图，不浪费一次提交
    answers = iter(["ab?de", "fghij"])
    mod.solve_image_captcha = lambda png: next(answers)
    page = FakePage(
        STATUS_NOT_CHECKED,
        [CAPTCHA_REPLY, CAPTCHA_REPLY],
        [{"status": 200, "body": {"success": True, "data": {"quota_awarded": 5000000}}}],
    )
    res = run(mod.captcha_checkin(page, "t", "https://x", "tok", "Asia/Shanghai"))
    ok(res.get("ok") is True, "识别不完整时换图后成功")
    ok(page.fetched == 2, f"取了 2 张图（实际 {page.fetched}）")
    ok(page.submitted == ["fghij"], f"只提交了完整的那次：{page.submitted}")

    # 5c) 服务端回「今日已签到」= 答案正确，必须判成功而不是失败
    mod.solve_image_captcha = lambda png: "abcde"
    page = FakePage(
        STATUS_NOT_CHECKED,
        [CAPTCHA_REPLY],
        [{"status": 200, "body": {"success": False, "message": "今日已签到"}}],
    )
    res = run(mod.captcha_checkin(page, "t", "https://x", "tok", "Asia/Shanghai"))
    ok(res.get("ok") is True, "「今日已签到」判成功（站点先校验验证码再判已签）", str(res)[:200])
    ok(page.fetched == 1, "不再重试")

    # 5d) 状态查询说已签 → 直接返回，不取图不提交
    mod.solve_image_captcha = lambda png: "abcde"
    page = FakePage(
        {**STATUS_NOT_CHECKED, "checkedInToday": True},
        [CAPTCHA_REPLY],
        [{"status": 200, "body": {"success": True}}],
    )
    res = run(mod.captcha_checkin(page, "t", "https://x", "tok", "Asia/Shanghai"))
    ok(res.get("ok") is True, "状态已签 → 直接成功")
    ok(page.fetched == 0, "未消耗验证码")

    # 5e) 没有 session cookie → 给出可照做的指引，且标不可重试
    mod.solve_image_captcha = lambda png: "abcde"
    page = FakePage(
        STATUS_NOT_CHECKED,
        [{"status": 200, "success": False, "message": "请打开网站后再签到", "captcha_id": "", "captcha_image": ""}],
        [],
    )
    res = run(mod.captcha_checkin(page, "t", "https://x", "tok", "Asia/Shanghai"))
    ok(res.get("ok") is False, "缺会话 → 失败")
    ok(res.get("retryable") is False, "标不可重试（换出口无用）")
    ok("session" in (res.get("message") or ""), "文案点名 session cookie", res.get("message"))

    # 5f) 连续答错到上限 → 报清是识别率问题，且不可重试
    mod.solve_image_captcha = lambda png: "abcde"
    page = FakePage(
        STATUS_NOT_CHECKED,
        [CAPTCHA_REPLY],
        [{"status": 200, "body": {"success": False, "message": "验证码错误，请重试"}}],
    )
    res = run(mod.captcha_checkin(page, "t", "https://x", "tok", "Asia/Shanghai", attempts=3))
    ok(res.get("ok") is False, "连续答错 → 失败")
    ok(page.fetched == 3, f"重试满 3 次（实际 {page.fetched}）")
    ok(res.get("retryable") is False, "标不可重试")
    ok("3" in (res.get("message") or ""), "文案说明尝试次数", res.get("message"))

    # 5g) 会话失效 + 渠道存了账密 → 自动换 session 后重试成功，并把新 cookie 回传
    mod.solve_image_captcha = lambda png: "abcde"
    page = FakePage(
        STATUS_NOT_CHECKED,
        [
            # 第一次取图被拒：会话已失效
            {"status": 200, "success": False, "message": "请打开网站后再签到", "captcha_id": "", "captcha_image": ""},
            CAPTCHA_REPLY,
        ],
        [{"status": 200, "body": {"success": True, "data": {"quota_awarded": 5000000}}}],
    )
    login_calls = []

    async def fake_login(pg, nm, bs, u, p, uid=""):
        login_calls.append({"user": u, "pass": p, "uid": uid})
        return {"session": True, "cookie": "session=FRESH; other=1", "userId": "25341", "why": ""}

    real_login = mod.login_for_session
    mod.login_for_session = fake_login
    res = run(
        mod.captcha_checkin(
            page,
            "t",
            "https://jianzhile.vip",
            "tok",
            "Asia/Shanghai",
            {"auth": {"username": "u", "password": "p", "userId": "25341"}},
        )
    )
    ok(res.get("ok") is True, "会话失效 → 账密换 session 后签到成功", str(res)[:200])
    ok(len(login_calls) == 1, f"只登录一次（实际 {len(login_calls)}）")
    ok(page.fetched == 2, f"换会话后重新取图（实际 {page.fetched}）")
    ok(res.get("newTokens", {}).get("cookie") == "session=FRESH; other=1", "把新 cookie 回传（面板写回 KV）")
    ok("刷新 Cookie" in (res.get("message") or ""), "文案说明已刷新 Cookie", res.get("message"))

    # 5h) 会话失效但渠道没有账密 → 不空转，直接给出可照做的指引
    mod.solve_image_captcha = lambda png: "abcde"
    page = FakePage(
        STATUS_NOT_CHECKED,
        [{"status": 200, "success": False, "message": "请打开网站后再签到", "captcha_id": "", "captcha_image": ""}],
        [],
    )
    res = run(mod.captcha_checkin(page, "t", "https://jianzhile.vip", "tok", "Asia/Shanghai", {"auth": {}}))
    ok(res.get("ok") is False, "无账密时失败")
    ok(page.fetched == 1, "不反复取图空转")
    ok("账密" in (res.get("message") or ""), "文案提示可补账密", res.get("message"))

    mod.login_for_session = real_login
    mod.solve_image_captcha = real_solver

print(f"\n{'=' * 60}")
print(f"checks: {checks}, failures: {failures}")
if failures:
    raise SystemExit(1)
print("全部通过")
