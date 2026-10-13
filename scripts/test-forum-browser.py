"""
浏览器通道「社区站」流程的离线回归测试（不联网、不开浏览器）。

跑法：python scripts/test-forum-browser.py

只测纯函数与判据 —— 它们全是从线上日志里反推出来的，改错一个方向就有代价：
判松了把「没签」说成「已签」→ 用户当天漏签；判紧了把「已签」说成失败 → 白跑一轮。
所以下面每个用例都直接抄线上/实测片段：

  · linux.sb 的 /daily_checkin 正文（2026-10-13 线上日志）：
      `每日签到 今天已签到 19 连续天数 46 累计签到 已完成 PaperCups 积分 1309`
  · linux.sb 的签到统计 cookie：__daily_checkin_stats=3596.2026-10-04.1.10.37
  · NodeSeek 会话失效：HTTP 500 + {"message":"USER NOT FOUND","status":404}
  · NodeSeek 游客页签到入口：`登录后签到`（innerText 里才连得起来）
  · CF 挑战页：Just a moment... / 葡萄牙语 Um momento…（代理出口实测）
  · linux.sb 抽称号结果页片段：gacha-result-card（HAR）
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


print("\n[1] CF 挑战页识别（标题多语言 + markup 兜底）")
ok(mod.looks_challenged({"title": "Just a moment...", "markup": ""}), "英文挑战页")
ok(mod.looks_challenged({"title": "Um momento…", "markup": ""}), "葡萄牙语挑战页（代理出口实测形态）")
ok(mod.looks_challenged({"title": "请稍候…", "markup": ""}), "中文挑战页")
ok(
    mod.looks_challenged({"title": "", "markup": "<script src='/cdn-cgi/challenge-platform/h/g/orchestrate.js'>"}),
    "标题为空时靠 challenge-platform markup 兜底",
)
ok(
    not mod.looks_challenged(
        {
            "title": "烧饼社区 - 人人都有饼吃的AI社区！LINUX SB",
            "markup": "<script src=\"/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js\"></script>",
        }
    ),
    "Rocket Loader 的 /cdn-cgi/scripts/… 不算挑战页（别用裸 cdn-cgi 当判据）",
)
ok(not mod.looks_challenged({"title": "", "markup": ""}), "标题为空且无 markup 时不算挑战页（还没起来）")

print("\n[2] linux.sb「今天已签到」判据（站点用相对日期，不写具体日期）")
BODY = (
    "LINUX SB - 人人都有饼吃的AI社区！ 用户榜单 邀请中心 每日签到 "
    "今天已签到 19 连续天数 46 累计签到 已完成 PaperCups 积分 1309"
)
ev = mod.today_signed_evidence(BODY)
ok(bool(ev), "识别出「今天已签到」", ev)
ok(ev.startswith("今天已签到 19"), "证据片段带上后面的数字，供面板展示与核对", ev)
ok(mod.today_signed_evidence("今日已签到 5 连续天数 1") != "", "认「今日已签到」")
ok(mod.today_signed_evidence("每日签到 连续天数 46 累计签到 46") == "", "没有相对日期措辞时不乱报")
ok(mod.today_signed_evidence("") == "", "空正文不报")

print("\n[3] 明天的日期不会被当成今天（判据带日期时的兜底路径）")
html_with_today = "<div>2026-10-13 已签到 +19 积分</div>"
ok(
    mod.checkin_record_evidence(html_with_today, "2026-10-13").startswith("2026-10-13"),
    "「已签到」附近出现今天日期 = 证据",
)
ok(mod.checkin_record_evidence(html_with_today, "2026-10-14") == "", "日期不是今天则不认")
ok(
    mod.checkin_record_evidence("<div>已签到 <div class=\"x\"></div></div>", "2026-10-13") == "",
    "只有「已签到」没有日期 = 不算证据（第一版就是被这个骗过）",
)

print("\n[4] 签到统计 cookie 解析（__daily_checkin_stats）")
stats = mod.parse_stats_cookie("a=1; __daily_checkin_stats=3596.2026-10-13.1.10.37; b=2")
ok(stats.get("uid") == "3596", "取到 uid", str(stats))
ok(stats.get("date") == "2026-10-13", "取到日期")
ok(stats.get("points") == 10.0, "取到积分")
ok(mod.parse_stats_cookie("a=1").get("date") is None, "没有这个 cookie 时不编造日期")

print("\n[5] __pageFlash 里的积分")
ok(mod.flash_points("您是今天第 42 位签到的用户，已帮您完成自动签到，获得 19 积分") == 19.0, "取到 19 积分")
ok(mod.flash_points("今天的签到收益是6个鸡腿") is None, "没有积分数字时返回 None（不是 0）")

print("\n[6] NodeSeek 签到响应判定")
ok(
    mod.attendance_result(
        "NodeSeek", {"status": 200, "body": {"success": True, "message": "今天的签到收益是6个鸡腿", "gain": 6, "current": 599}}
    ).get("ok")
    is True,
    "success:true 判定成功",
)
ok(
    mod.attendance_result(
        "NodeSeek", {"status": 200, "body": {"success": True, "message": "今天的签到收益是0个鸡腿", "gain": 0, "current": 599}}
    ).get("already")
    is True,
    "gain=0 = 今日已签（判据与 worker 侧一致）",
)

print("\n[9b] 真实登录页结构（线上实测 /signIn.html：搜索框是陷阱，账号框是 #stacked-email）")
SIGNIN_INPUTS = [
    {"name": "q", "type": "text", "id": "search-site", "placeholder": "", "autocomplete": "", "visible": False},
    {"name": "q", "type": "text", "id": "search-site2", "placeholder": "Search", "autocomplete": "", "visible": True},
    {"name": "", "type": "submit", "id": "", "placeholder": "", "autocomplete": "", "visible": False},
    {"name": "", "type": "text", "id": "stacked-email", "placeholder": "Email", "autocomplete": "", "visible": True},
    {"name": "", "type": "password", "id": "stacked-password", "placeholder": "Password", "autocomplete": "", "visible": True},
]
su, sp = mod.pick_login_fields(SIGNIN_INPUTS)
ok(su and su["id"] == "stacked-email", "账号框挑的是 Email 那个，不是顶部搜索框", str(su))
ok(sp and sp["id"] == "stacked-password", "密码框挑对", str(sp))
ok(mod.input_selector(su) == "#stacked-email", "没有 name 时用 id 选择器", mod.input_selector(su))

ok(
    mod.attendance_result(
        "NodeSeek", {"status": 500, "body": {"message": "USER NOT FOUND", "status": 404, "success": False}}
    )
    is None,
    "USER NOT FOUND 不判定成功（交给上层报 Cookie 失效）",
)
ok(
    mod.attendance_result("NodeSeek", {"status": 403, "body": None, "text": "<html>Just a moment...</html>"}) is None,
    "挑战页不判定成功",
)

print("\n[7] 排行榜命中（NodeSeek 只读状态源）")
board = {"status": 200, "body": {"list": [{"member_name": "NoxBug", "gain": 13}, {"member_name": "papercups", "gain": 6}]}}
ok(mod.board_hit(board, "PaperCups") is not None, "用户名大小写不敏感地命中")
ok(mod.board_hit(board, "someone") is None, "别人不命中")
ok(mod.board_hit(board, "") is None, "没填用户名时不给结论")

print("\n[8] 抽称号结果页解析（HAR 片段）")
RESULT_HTML = """<div class="gacha-result-card gacha-result-r">
  <div class="gacha-result-rarity">R</div>
  <div class="gacha-result-icon">📨</div>
  <div class="gacha-result-name">回复达人</div>
  <div class="gacha-result-desc">秒回小能手</div>
  <div class="gacha-result-quantity">获得 × 1（已累计）</div>
</div>"""
titles = mod.parse_gacha_titles(RESULT_HTML)
ok(len(titles) == 1, "解析出 1 个称号", str(titles))
ok(titles[0]["name"] == "回复达人" and titles[0]["rarity"] == "R", "称号名与稀有度", str(titles[0]))
ok("回复达人" in mod.gacha_title_line(titles[0]), "排版包含称号名")
ok(mod.parse_gacha_titles("") == [], "空 HTML 返回空列表")
ok(mod.parse_gacha_titles("<div>很遗憾，什么都没抽到</div>") == [], "空抽结果不伪造称号")

print("\n[9] 登录表单字段识别（NodeSeek 登录页形态：账号框 + 密码框 + 隐藏 csrf）")
LOGIN_INPUTS = [
    {"name": "_csrf", "type": "hidden", "id": "", "placeholder": "", "autocomplete": "", "visible": False},
    {"name": "username", "type": "text", "id": "username", "placeholder": "用户名 / 邮箱", "autocomplete": "username", "visible": True},
    {"name": "password", "type": "password", "id": "password", "placeholder": "密码", "autocomplete": "current-password", "visible": True},
    {"name": "submit", "type": "submit", "id": "", "placeholder": "", "autocomplete": "", "visible": True},
]
user_el, pw_el = mod.pick_login_fields(LOGIN_INPUTS)
ok(user_el and user_el["name"] == "username", "挑出账号框", str(user_el))
ok(pw_el and pw_el["name"] == "password", "挑出密码框", str(pw_el))
ok(mod.input_selector(user_el) == 'input[name="username"]', "选择器优先用 name", mod.input_selector(user_el))
ok(mod.input_selector(pw_el) == 'input[name="password"]', "密码框选择器", mod.input_selector(pw_el))
ok(mod.pick_login_fields([{"name": "q", "type": "text", "visible": True}])[1] is None, "没有密码框时如实返回 None")
ok(mod.pick_login_fields([]) == (None, None), "空表单不报错")
# 邮箱框优先于普通文本框（placeholder 里带 email 的那种）
EMAIL_FIRST = [
    {"name": "nick", "type": "text", "id": "", "placeholder": "昵称", "autocomplete": "", "visible": True},
    {"name": "email", "type": "email", "id": "", "placeholder": "邮箱", "autocomplete": "", "visible": True},
    {"name": "password", "type": "password", "id": "", "placeholder": "", "autocomplete": "", "visible": True},
]
ok(mod.pick_login_fields(EMAIL_FIRST)[0]["name"] == "email", "账号框优先挑邮箱输入")
ok(mod.input_selector({"type": "password"}) == 'input[type="password"]', "没有 name/id 时退到 type")

print("\n[10] Cookie 拼装与「会话到手」判据")
JAR = [
    {"name": "session", "value": "abc", "domain": "nodeseek.com"},
    {"name": "pjwt", "value": "jwt", "domain": ".nodeseek.com"},
    {"name": "cf_clearance", "value": "cf", "domain": ".nodeseek.com"},
    {"name": "other", "value": "x", "domain": "example.com"},
]
hdr = mod.cookies_to_header(JAR, "nodeseek.com")
ok("session=abc" in hdr and "pjwt=jwt" in hdr, "取到本站会话 cookie", hdr)
ok("cf_clearance=cf" in hdr, "cf_clearance 也在（由上层决定要不要写回）", hdr)
ok("other=x" not in hdr, "不带别的域的 cookie", hdr)
ok(mod.cookies_to_header([], "nodeseek.com") == "", "空 jar 返回空串")
ok(mod.has_session_cookie(hdr) is True, "识别出已有会话")
ok(mod.has_session_cookie("cf_clearance=cf; colorscheme=light") is False, "只有 CF cookie 不算登录")
ok(mod.has_session_cookie("") is False, "空串不算登录")

print("\n[11] 浏览器流程引用的 JS 常量与函数都在（编辑时被整段删掉过一次，钉住）")
for _name in ("JS_LOGIN_FORM", "JS_CLICK_LOGIN_ENTRY", "JS_SUBMIT_LOGIN", "JS_ATTENDANCE", "JS_BOARD"):
    _v = getattr(mod, _name, None)
    ok(isinstance(_v, str) and len(_v) > 20, f"{_name} 存在且非空", str(type(_v)))
for _fn in (
    "nodeseek_browser_login",
    "nodeseek_browser_checkin",
    "linuxsb_browser_checkin",
    "linuxsb_browser_gacha",
    "forum_browser_checkin",
    "pick_login_fields",
    "input_selector",
    "cookies_to_header",
    "session_value",
    "has_session_cookie",
    "today_signed_evidence",
    "checkin_record_evidence",
    "parse_stats_cookie",
    "parse_gacha_titles",
):
    ok(callable(getattr(mod, _fn, None)), f"{_fn} 可调用")
ok("inPasswordForm" in mod.JS_PICK_LOGIN_SUBMIT, "候选清单标注是否在密码表单内（别点错邮箱验证那一栏）")
ok("closest('form')" in mod.JS_PICK_LOGIN_SUBMIT, "以密码框所属 form 为范围挑提交按钮")

print("\n[13] 登录输入用真实按键 + 提交失败换 Enter 再试（站点按 keydown 判空时会走错分支）")
ok(callable(getattr(mod, "type_like_human", None)), "type_like_human 可调用")
ok("JS_LOGIN_DIAG" in dir(mod) and "pwFormIndex" in mod.JS_LOGIN_DIAG, "表单结构诊断可用")
_src = open(os.path.join(HERE, "browser-checkin.py"), encoding="utf-8").read()
ok("await type_like_human(page, sel, username)" in _src, "账号用真实按键输入")
ok("await type_like_human(page, sel, password)" in _src, "密码用真实按键输入")
ok("use_enter = True" in _src, "被甩到邮箱验证后会换 Enter 提交再试一次")

print("\n[12] 登录提交按钮必须锚定在密码表单里（别点顶栏/邮箱验证那一栏的「登录」）")
ok("JS_PICK_LOGIN_SUBMIT" in dir(mod), "JS_PICK_LOGIN_SUBMIT 存在")
ok("__hub_login_submit" in mod.JS_PICK_LOGIN_SUBMIT, "会给表单提交按钮打标记 id")
ok("inPasswordForm" in mod.JS_PICK_LOGIN_SUBMIT, "候选清单标注是否在密码表单内")
ok("closest('form')" in mod.JS_PICK_LOGIN_SUBMIT, "以密码框所属 form 为范围")
ok("requestSubmit" in mod.JS_SUBMIT_LOGIN, "页面内兜底优先 requestSubmit（触发站点自己的 submit 处理）")
ok("emailSignIn" not in mod.JS_PICK_LOGIN_SUBMIT, "挑按钮时不把邮箱验证入口当目标")

print(f"\n{'❌' if failures else '✅'} {checks - failures}/{checks} 通过")
raise SystemExit(1 if failures else 0)
