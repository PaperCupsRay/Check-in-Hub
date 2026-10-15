"""
多厂商人机验证（Turnstile / hCaptcha / reCAPTCHA 同时）的离线回归测试。
不联网、不开浏览器、不依赖 ddddocr。

跑法：python scripts/test-human-verify.py

为什么要有这个文件：星见雅 2026-10-15 把签到的人机验证从「一家」变成了「两家同时」
（/api/status 里 checkin_turnstile_check 与 checkin_hcaptcha_check 同时为真），
服务端要求**两个 token 都非空**。旧实现用 use_hc 在 hCaptcha / reCAPTCHA 之间二选一，
必然漏一家，于是每次都卡在「人机验证 token 为空」，重试多少次都没用。
下面的用例把这条线上事实钉住，免得以后又改回二选一。

线上实测语料（new.xinjianya.top，2026-10-15）：
  · /api/status: checkin_turnstile_check=true, checkin_hcaptcha_check=true,
                 checkin_recaptcha_check=false, turnstile_check=false（注意这个是登录用的）
                 turnstile_site_key=0x4AAAAAAERl4Y9b9p0Bvlny
                 hcaptcha_site_key=e5ee5816-f382-4802-bb7e-c1644752ae74
  · POST /api/user/checkin（不带 token）        → 200 success:false「人机验证 token 为空」
  · 只带 hcaptcha 或只带 turnstile（都是假的）   → 同上「人机验证 token 为空」
  · turnstile + hcaptcha 都带（都是假的）        → 200 success:false「Turnstile 校验失败，请刷新重试！」
  · 站点前端 bundle：把启用的 token 全部 append 到同一 query
        POST /api/user/checkin?turnstile=<ts>&hcaptcha=<hc>
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

SOURCE = open(os.path.join(HERE, "browser-checkin.py"), encoding="utf-8").read()

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


# 星见雅 2026-10-15 的真实 /api/status（只留相关字段）
XJY_STATUS = {
    "checkin_enabled": True,
    "checkin_turnstile_check": True,
    "checkin_hcaptcha_check": True,
    "checkin_recaptcha_check": False,
    "turnstile_check": False,  # 登录用的，签到**不能**拿它当判据
    "hcaptcha_check": False,
    "recaptcha_check": False,
    "turnstile_site_key": "0x4AAAAAAERl4Y9b9p0Bvlny",
    "hcaptcha_site_key": "e5ee5816-f382-4802-bb7e-c1644752ae74",
    "recaptcha_site_key": "6Le_JM4tAAAAAEjdrPVNARNI6KWocsImqLn5e12v",
    "recaptcha_version": "v2",
}

print("\n[1] captcha_vendors_from_status：星见雅两家同时")
got = mod.captcha_vendors_from_status(XJY_STATUS)
ok(len(got) == 2, f"识别出 2 家（实际 {len(got)}）", str(got))
ok([v["vendor"] for v in got] == ["turnstile", "hcaptcha"], "顺序为 turnstile → hcaptcha", str(got))
ok(
    got[0]["sitekey"] == "0x4AAAAAAERl4Y9b9p0Bvlny",
    "turnstile 取 turnstile_site_key",
    got[0]["sitekey"] if got else "",
)
ok(
    got[1]["sitekey"] == "e5ee5816-f382-4802-bb7e-c1644752ae74",
    "hcaptcha 取 hcaptcha_site_key",
    got[1]["sitekey"] if len(got) > 1 else "",
)
ok(
    all(v["label"] for v in got),
    "每家都带可读标签（日志/报错里要能点名是哪家）",
    str(got),
)
ok("recaptcha" not in [v["vendor"] for v in got], "开关为假的 reCAPTCHA 不被算进来")

print("\n[2] 只认 checkin_*_check，不回退到全局开关")
ok(
    mod.captcha_vendors_from_status({"turnstile_check": True, "turnstile_site_key": "k"}) == [],
    "只有全局 turnstile_check（登录用）时返回空 —— 否则会给不需要验证码的站硬挂组件",
)
ok(
    mod.captcha_vendors_from_status({"hcaptcha_check": True, "hcaptcha_site_key": "k"}) == [],
    "只有全局 hcaptcha_check 时返回空",
)
ok(
    [v["vendor"] for v in mod.captcha_vendors_from_status({"checkin_turnstile_check": True})]
    == ["turnstile"],
    "只有 checkin_turnstile_check 时按它走（星见雅正是 turnstile_check=false 而它=true）",
)

print("\n[3] 开关开着但没给 sitekey：要能识别出来（调用方据此报错）")
got = mod.captcha_vendors_from_status({"checkin_hcaptcha_check": True, "hcaptcha_site_key": ""})
ok(len(got) == 1 and got[0]["sitekey"] == "", "返回条目但 sitekey 为空串", str(got))
ok(
    mod.captcha_vendors_from_status({"checkin_hcaptcha_check": True, "hcaptcha_site_key": "   "})[0][
        "sitekey"
    ]
    == "",
    "纯空白的 sitekey 也按空处理（别把空白当有效 key 去挂组件）",
)

print("\n[4] 边界：全关 / 非 dict / 缺字段")
ok(mod.captcha_vendors_from_status({}) == [], "空 dict → 空列表")
ok(
    mod.captcha_vendors_from_status(
        {"checkin_turnstile_check": False, "checkin_hcaptcha_check": False}
    )
    == [],
    "三家全关 → 空列表",
)
ok(mod.captcha_vendors_from_status(None) == [], "None → 空列表（不抛异常）")
ok(mod.captcha_vendors_from_status("not a dict") == [], "非 dict → 空列表")
ok(
    mod.captcha_vendors_from_status({"checkin_turnstile_check": "true"}) == [],
    "字符串 \"true\" 不算真（只认布尔 true，免得把站点误配当成开关）",
)

print("\n[5] human_verification_missing：认得出「token 不齐」与「哪家被拒」")
ok(
    mod.human_verification_missing({"message": "人机验证 token 为空"}) == "empty",
    "「人机验证 token 为空」→ empty",
)
ok(
    mod.human_verification_missing({"message": "Turnstile 校验失败，请刷新重试！"}) == "turnstile",
    "「Turnstile 校验失败」→ turnstile",
)
ok(
    mod.human_verification_missing({"message": "hCaptcha 校验失败"}) == "hcaptcha",
    "「hCaptcha 校验失败」→ hcaptcha",
)
ok(
    mod.human_verification_missing({"message": "reCAPTCHA 校验失败，请重试"}) == "recaptcha",
    "「reCAPTCHA 校验失败」→ recaptcha",
)
ok(
    mod.human_verification_missing({"message": "Turnstile 校验失败", "success": True}) == "turnstile",
    "success:true 也照样认（这类回话必是 success:false，但不靠它判断）",
)

print("\n[6] human_verification_missing：别误伤别的回话")
for msg in (
    "今日已签到",
    "请打开网站后再签到",
    "请输入验证码",
    "验证码错误，请重试",
    "签到成功",
    "Unauthorized, not logged in and no access token provided",
):
    ok(mod.human_verification_missing({"message": msg}) == "", f"「{msg}」不误判")
ok(mod.human_verification_missing(None) == "", "None 不抛异常")
ok(mod.human_verification_missing({}) == "", "无 message 不抛异常")

print("\n[7] 提交形态：必须把每一家的 token 都 append 到同一 query")
ok("URLSearchParams" in mod.CAPTCHA_SUBMIT_JS, "用 URLSearchParams 拼 query（token 里的 +/= 不会被弄坏）")
ok(
    "qs.append(k, tokens[k])" in mod.CAPTCHA_SUBMIT_JS
    or "qs.append(k,tokens[k])" in mod.CAPTCHA_SUBMIT_JS,
    "遍历所有 token 逐个 append（不是只取一家）",
)
ok("/api/user/checkin" in mod.CAPTCHA_SUBMIT_JS, "提交到 /api/user/checkin")
ok(
    "Object.keys(tokens)" in mod.CAPTCHA_SUBMIT_JS,
    "按传入的 token 集合动态拼参数名（turnstile / hcaptcha / recaptcha 通用）",
)

print("\n[8] 挂载形态：每家一个独立容器（回归：单容器会互相覆盖）")
ok("'self-cap-' + sp.vendor" in mod.CAPTCHA_MOUNT_JS, "容器 id 带厂商名")
ok("#self-rc" not in mod.CAPTCHA_MOUNT_JS, "不再用单一 #self-rc 容器")
ok(
    "window.__capTokens[sp.vendor]" in mod.CAPTCHA_MOUNT_JS,
    "token 按厂商分别存进 __capTokens",
)
ok("for (const sp of specs)" in mod.CAPTCHA_MOUNT_JS, "遍历全部厂商挂载")
ok(
    "CAPTCHA_INJECT_JS" in SOURCE and "sdk_match" in mod.CAPTCHA_INJECT_JS,
    "按厂商补 SDK（缺哪家补哪家）",
)
ok(
    "iframes" in mod.CAPTCHA_STATE_JS and "globals" in mod.CAPTCHA_STATE_JS,
    "每轮同时取 token / 报错 / iframe 是否还在 / 全局 API 是否还在",
)

print("\n[9] 点击：两类勾选框都要点")
ok("return hits" in SOURCE.split("async def click_challenge")[1].split("def nav_opts")[0],
   "click_challenge 返回点击次数（多厂商那轮要统计）")
ok(
    "click_challenge(page)" in SOURCE and "click_captcha_checkbox(page)" in SOURCE,
    "Turnstile（click_challenge）与 hCaptcha/reCAPTCHA（click_captcha_checkbox）两套点法都在",
)

print("\n[10] 分流顺序：站点声明了签到验证码时，多厂商自挂要排在 reCAPTCHA 提示之前")
i_declared = SOURCE.find("declared = captcha_vendors_from_status(site_st)")
i_rchint = SOURCE.find('rc_hint = (channel.get("options") or {}).get("recaptchaSiteKey")')
ok(i_declared > 0, "存在「按 /api/status 声明分流」的分支")
ok(i_rchint > 0, "仍保留渠道选项 recaptchaSiteKey 的老分支")
ok(
    0 < i_declared < i_rchint,
    "声明分流在 rc_hint 之前 —— 否则星见雅渠道里那个 recaptchaSiteKey=1 的占位值"
    "会把它带进站点 UI 驱动，多厂商自挂根本没机会跑",
)
ok(
    'if "recaptcha" in kinds:' in SOURCE,
    "声明里含 reCAPTCHA 时仍走站点 UI 驱动（v2 的 token 与页面 origin 绑定，自挂会被判低分）",
)

print("\n[11] 探针兜底：空 token 被拒且点名「人机验证」时改走多厂商自挂")
i_probe = SOURCE.find("if human_verification_missing(pb):")
i_unrelated = SOURCE.find("与 Turnstile 无关的失败")
ok(i_probe > 0, "存在该兜底分支")
ok(
    0 < i_probe < i_unrelated,
    "兜底排在「与 Turnstile 无关的失败」之前 —— 否则「人机验证 token 为空」会被判成"
    "不可重试，当天直接漏签",
)

print("\n[12] 失败文案要能自证：点名是哪家、并说明可重试")
ok("token 为空" in SOURCE and "确认站点声明的每一家都带上了" in SOURCE, "empty 的文案指向「没带齐」")
ok("token 被拒" in SOURCE, "被拒的文案说明 token 一次性、重取即可")
ok(
    '"retryable": bool(which)' in SOURCE,
    "人机验证类失败标可重试（换一轮/换出口重取 token 有用）",
)

print(f"\n{'=' * 60}")
print(f"checks: {checks}, failures: {failures}")
if failures:
    raise SystemExit(1)
print("全部通过")
