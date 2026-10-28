# Check-in Hub

多渠道自动签到面板，一键部署到 **Cloudflare Workers**。

在浏览器里管理 Sub2API / NewAPI / AgentRouter 等 API 站点，以及 NodeSeek / linux.sb / NodeLoc 等社区论坛、Obsidian Arc（Axis AI）等自建 AI 站的签到，支持签到、状态查询、用户信息、批量并发签到，以及导入导出配置。

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

---

## ✨ 功能特性

- **多渠道适配**：内置 `sub2api` / `newapi` / `agentrouter` / `nodeseek` / `linux.sb` / `nodeloc` / `onyxaxis`，可继续扩展
- **卡片式首页**：所有渠道直接展示，支持按类型筛选与多种排序
- **弹窗编辑**：新增 / 编辑渠道使用模态框，不打断列表浏览
- **并发签到**：全部签到使用 `Promise.allSettled` 并发执行
- **悬浮 Toast**：操作结果顶部悬浮提示；完整日志在侧边 Log 抽屉
- **点击跳转**：点击渠道名称直接打开对应站点
- **KV 自动持久化**：渠道默认读写 Cloudflare KV（`CHECKIN_KV`）；`localStorage` 仅作离线缓存
- **访问密码**：可选 `ACCESS_PASSWORD` 保护面板与业务 API
- **可选定时任务**：Cron 从 KV 读取渠道做服务端批量签到
- **导入导出**：一键导出 / 导入渠道 JSON

---

## 🖼 界面概览

| 区域 | 说明 |
|------|------|
| 渠道总览 | 新增渠道、全部签到、导入导出 |
| 渠道卡片 | 筛选类型、排序、签到 / 状态 / 用户 / 登录 / 编辑 / 删除 |
| Log 抽屉 | 查看完整请求与结果 |
| 访问门禁 | 启用密码后先解锁再使用 |

---

## 🚀 快速开始

### 环境要求

- Node.js 18+
- Cloudflare 账号（部署时）
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)（项目已作为 devDependency）

### 本地开发

```bash
git clone https://github.com/<your-username>/checkin-hub.git
cd checkin-hub
npm install
npm run dev
```

浏览器打开终端提示地址（通常是 `http://127.0.0.1:8787`）。

### 部署到 Cloudflare

```bash
npm run deploy
```

建议生产环境开启访问密码：

```bash
npx wrangler secret put ACCESS_PASSWORD
# 可选：单独的会话签名密钥
npx wrangler secret put SESSION_SECRET
```

本地开发可复制示例文件：

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入密码
```

---

## 📦 已支持适配器

| 类型 | 样例站点 | 鉴权 | 签到方式 |
|------|----------|------|----------|
| `sub2api` | Sub2API 系站点（林夕 k40 / 百倍 100xlabs 等） | Bearer JWT | `POST /api/v1/check-in`；另有「抽奖」动作与「自动抽奖」开关（`POST /api/v1/lottery`） |
| `newapi` | NewAPI / OneAPI 系 | Cookie + `New-Api-User`；带图片验证码的定制站**必须**有 `session=` | `POST /api/user/checkin`（有验证码时先 `POST /api/user/checkin/captcha` 取图） |
| `agentrouter` | AgentRouter 等同系 | Cookie / 账密（登录前先 logout） | 查询用户信息自动签到，兼容 `sign_in` / `checkin` |
| `nodeseek` | NodeSeek（www.nodeseek.com） | Cookie | **`gha_browser` 通道**：真浏览器过 CF 挑战后，页面内 `POST /api/attendance?random=true`（收益=鸡腿） |
| `linuxsb` | linux.sb（烧饼社区） | Cookie | **`gha_browser` 通道**：真浏览器过 CF 挑战后打开首页触发服务端自动签到；另有「抽称号」动作 |
| `nodeloc` | NodeLoc（www.nodeloc.com，Discourse） | Cookie + CSRF | `POST /checkin`（form 编码 + `X-Checkin-Nonce`） |
| `onyxaxis` | Obsidian Arc 系自建 AI 站（ai.onyxaxis.org 等） | 会话 Cookie（`obsidian_session`）或账密登录 | `POST /api/checkin`（body `{}`，需带同源 `Origin`）；另有「领里程碑」动作 |

### 填写建议

**Sub2API**

- 推荐：邮箱 + 密码（Worker 会登录并必要时 refresh）
- 或直接填 Access Token / Refresh Token

**Sub2API 系站点的抽奖（林夕 k40 / 百倍 100xlabs 等）**

- 站点是「免费额度 / 活动分 / 余额」三选一消耗后抽奖。卡片上点「**抽奖**」开一个**抽奖弹窗**：
  先看清今日进度、剩余次数、各类余额与本次消耗方式，再选抽几次（`1`/`3`/`5`/`全部` 快捷键，
  或手填；**留空 = 抽完今日剩余**），抽的过程中**每抽一次追加一行结果**（第几次、中了什么、
  这次花掉什么），可以随时「停止」。另有 **自动抽奖** 开关：打开后每次签到成功会顺带抽奖，
  结果随签到一起进面板日志与 TG 推送（`🎰` 一行，不会被签到文案的 90 字上限截断）
- **默认只花免费额度**（`cost_type=free`）。活动分（`activity_score`）与余额是真实资产，
  只有把渠道选项 `options.lotteryCost` 设成 `auto`（免费额度→活动分）或 `all`
  （再加余额）才会动 —— 自动任务不该悄悄花用户的钱
- 「今日已签到」这条路径**也会抽**：定时任务常在用户手动签过的日子拿到这个回话，
  而抽奖次数与签到是两回事
- 抽几次：弹窗里手填的次数优先（仍受今日剩余与硬上限约束，被卡住时日志会说明
  「填了 9 次，今日只剩 2 次 —— 按 2 次抽」）；留空与自动抽奖则按
  `options.lotteryMaxDraws`（缺省 = 抽完今日剩余）。弹窗是**每次请求只抽 1 次**的循环，
  所以每条结果都是真实到账后立刻显示、也能中途停；单次请求路径（自动抽奖）的硬上限是
  30 次（Workers 免费版单次请求子请求上限 50，签到自身还要用掉几个）。每次抽奖都带新的
  `idempotency_key` —— 重复用同一个会被服务端去重，等于白抽
- 抽奖失败**不推翻签到结论**，只追加说明；中途失败会保留已抽到的结果（奖品是真实
  到账的）。跳过时也会写清原因（活动未开启 / 窗口未开放 / 今日次数已用完 /
  额度不足（需 88，现有 N））
- 浏览器通道（`gha_browser`）走的是同一套口径：脚本在页面里用登录拿到的 Bearer
  发 `POST /api/v1/lottery`（见 `scripts/browser-checkin.py` 的 `auto_lottery_note`）

**NewAPI**

- 账密站点：用户名 + 密码
- OAuth 站点：从浏览器 Application → Cookies 复制 Cookie，并填写用户 ID
- **带图片验证码的定制站（如 jianzhile.vip）**：必须填 Cookie（含 `session=`），
  且**不能只填访问令牌**。这类站的签到接口只认浏览器会话，带访问令牌会回
  「请打开网站后再签到」；而状态查询两种凭证都认，所以「状态查得到、签到报请打开
  网站」正是这道闸门的特征，不是令牌过期。签到由浏览器通道取图 + OCR + 带
  `captcha_id` 提交完成，答错自动换一张重试（见下文）

**AgentRouter**

- 用户名 + 密码（会先清理脏 session）
- 或完整 Cookie；建议填写 `New-Api-User`

**Obsidian Arc（Axis AI / ai.onyxaxis.org 等自建站）**

- 站点是自建 AI 站（开源实现 [ObsidianArc](https://github.com/OnyxAxisOwO/ObsidianArc)），
  签到只认**服务端会话 Cookie**（默认名 `obsidian_session`），没有 API 令牌能签到
- 推荐填「用户名 / 邮箱 + 密码」：Worker 侧直接 `POST /api/auth/login` 换会话 Cookie，
  换到的 Cookie 会自动写回渠道，不必手抄
- 或手抄 Cookie：浏览器登录后 F12 → Application → Cookies 复制 `obsidian_session`
- 账号开了**二次验证**、或站点把登录接口挂上 Turnstile 时自动登录走不通（脚本不代填
  6 位动态码），这时改用 Cookie 方式即可 —— 签到接口本身不挂人机验证
- **里程碑奖励（如连续 5 天的「签到重置卡」）**：卡片上有 **「领里程碑」** 按钮，一键领取
  当前所有已达成的里程碑；没达成时会显示进度（如「签到重置卡 1/5」），不会报红
- 想让每日签到**顺带领**（连续天数刚涨上去，正是最容易忘的时刻）：渠道里加一条
  `options.autoClaim = true`（默认 false，与 linux.sb 的 `autoGacha` 同规矩）；
  领取失败不会推翻签到结论，只在日志里追加说明

**NodeSeek / linux.sb / NodeLoc（社区论坛）**

- 三站都**只认浏览器 Cookie**，没有账密登录，也没有 API 令牌
- 复制方式：浏览器登录后 F12 → Application → Cookies → 复制整站 Cookie
  （NodeLoc 至少要含 `_t`；被 Cloudflare 挑战过的话把 `cf_clearance` 也带上）
- **NodeSeek / linux.sb 必须把「签到通道」设成 `gha_browser`（浏览器通道）**。这两站全站
  挂在 Cloudflare 后面，而 `cf_clearance` 与签发它的出口 IP 绑定 —— 2026-10-13 实测
  Worker 出口（NodeSeek 302、linux.sb 403 拦截页）与 `gha_api` 的 Azure 出口
  （两站都是 403 Just a moment）都过不去，`cf_clearance` 拷进渠道也照样失效。
  浏览器通道用真浏览器（Camoufox）过挑战，再在**页面上下文里**发签到请求：
  CF 放行 cookie 与站点自己的签名头（NodeSeek 的 `refract-*` 由 sw.js 生成）都是现成的
- **NodeSeek**：签到单位是「鸡腿」不是美元，面板按积分展示，不会折算成金额。
  **签到走两段**：① 快路径 —— `cloudscraper`（自动解 Cloudflare JS 挑战，参考
  [xinycai/nodeseek_signin](https://github.com/xinycai/nodeseek_signin)）直接
  `POST /api/attendance?random=false`，秒级完成、不开浏览器（2026-10-14 线上实测命中）；
  ② 快路径解不了挑战时退回真浏览器流程（Camoufox + 代理池）。
  **凭证两种填法**：① 只填 Cookie（F12 → Application → Cookies 复制整站，推荐 —— 快路径
  就靠它）；②「论坛用户名 + 密码」—— 浏览器通道会打开站点登录页用账密登录，换到的会话
  Cookie **自动写回渠道**，之后直接复用，不用手抄。会话失效时接口会回 `USER NOT FOUND`、
  页面签到入口写成「登录后签到」，面板会照实报出来并提示补凭证。
  已签到的判据有三条，按可靠性：页面状态行「今日签到获得鸡腿 N 个」> 当日排行榜按用户名命中
  > 接口回话（重复签到站点是配 **HTTP 500** +「今天已完成签到，请勿重复操作」发的）
  登录页实测是 **`/signIn.html`**（`/login` 不存在），账号/密码框由前端 JS 后渲染，
  所以脚本会等它出现再填；页面上挂着 **Cloudflare Turnstile** —— 机房直连出口 45s 拿不到
  token，**住宅代理 7s 就拿到**（2026-10-13 实测），所以这个渠道建议保留代理池。
  登录成功的判据是「会话值变了 / 已离开登录页」（只查「有没有 session」会被渠道里那份旧
  Cookie 骗过）；输入用**真实按键**（直接设 value 时站点前端会当成没填，根本不发登录请求）。
  登录接口是 `POST /api/account/signIn`，回话会原样透到面板上。**注意账号维度的每日限流**：
  失败几次后站点回 `RATE_LIMITED`「该账户操作过于频繁，请明天再尝试密码登录，或者改用邮箱
  验证登录」—— 遇到它当天别再试（脚本会自动停下并说明），否则只会把额度耗得更久；
  被限流时改用 Cookie 方式即可
- **linux.sb**：签到是**自动的** —— 打开任意页面时服务端顺手完成，提示写进页面的
  `window.__pageFlash`。浏览器通道打开首页即可：有「已帮您完成自动签到」= 刚签上；
  没有 flash 时再去 `/daily_checkin` 看「今天已签到」这类**相对日期**措辞
  （站点不写具体日期，所以判据是那个词组，面板会把原文片段一并显示，便于核对）。
  渠道的 `options.autoGacha` 填 `true` 时，浏览器通道会在签到后顺手抽**免费那一发**：
  今日免费抽已用完（按钮变成「抽一次 (10 积分)」）时**直接跳过**，绝不替用户花积分。
  面板上另有 **抽称号** 按钮供手动使用
- **NodeLoc（Discourse）**：会自动用 Cookie 换 `/session/csrf.json` 的会话级 CSRF token，
  通常不用手填；`CSRF Token` 字段只在自动获取失败时用。注意请求体是表单编码
  （`nonce=…&timestamp=…`），不是 JSON。本站走 worker 直连即可（实测没被拦）

---

## 🧭 使用方式

1. 打开面板（若启用密码则先解锁）
2. 点击 **新增渠道**，选择类型并填写 Base URL 与凭证
3. 保存后在卡片上执行 **签到 / 状态 / 用户 / 登录校验**
4. 或点击 **全部签到**（并发）
5. 需要完整结果时点 **Log**

> 凭证默认只在你的浏览器本地。只有你主动点击操作时，Worker 才会代发请求到目标站点。

---

## 🔌 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 前端面板 |
| `GET` | `/api/health` | 健康检查（公开） |
| `GET` | `/api/auth/status` | 是否启用密码 / 是否已登录（公开） |
| `POST` | `/api/auth/login` | 访问密码登录 |
| `POST` | `/api/auth/logout` | 退出 |
| `GET` | `/api/adapters` | 适配器列表与表单字段 |
| `POST` | `/api/checkin` | 单渠道动作：`login` / `me` / `status` / `checkin` / `refresh` |
| `POST` | `/api/batch` | 多渠道批量动作 |
| `POST` | `/api/cron/run` | 定时任务入口（校验 `CRON_SECRET`） |

### 单渠道示例

```bash
curl -X POST https://<your-worker>/api/checkin \
  -H "Content-Type: application/json" \
  -H "X-Access-Password: your-password" \
  -d '{
    "action": "checkin",
    "channel": {
      "type": "sub2api",
      "baseUrl": "https://example.com",
      "auth": {
        "email": "you@example.com",
        "password": "secret"
      },
      "options": { "timezone": "Asia/Shanghai" }
    }
  }'
```

---

## 💾 持久化（Cloudflare KV）

`wrangler.toml` 已绑定 `CHECKIN_KV`。打开面板后：

1. **优先从 KV 加载**渠道列表  
2. 若 KV 为空而本地 `localStorage` 有数据 → **自动上传一次**  
3. 保存 / 删除 / 签到写回 token / 导入等变更 → **自动同步到 KV**（防抖约 450ms）

| Key | 内容 |
|-----|------|
| `channels` | 渠道 JSON 数组（含 auth、lastResult） |
| `last_run` | 最近一次 cron 结果 |

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/kv/status` | 是否绑定、条数、`last_run` |
| `GET` | `/api/kv/channels` | 读取全部渠道 |
| `PUT`/`POST` | `/api/kv/channels` | `{ "channels": [...] }` 全量覆盖 |
| `DELETE` | `/api/kv/channels` | 清空 |

`GET /api/health` 含 `kvBound`。生产请用真实 namespace id；本地 `wrangler dev` 用 `preview_id`。

---

## ⏰ 定时签到（可选）

1. 确保 `CHECKIN_KV` 已绑定（UI 保存渠道会自动写入 KV）  
2. 设置 `CRON_SECRET`，解开 `wrangler.toml` 里 cron 注释后 deploy  
3. 也可手动：

```bash
curl -X POST https://<your-worker>/api/cron/run \
  -H "X-Cron-Secret: your-secret"
```

### 降级与 token 过期自愈

渠道签到按 `worker → gha_api / gha_browser` 降级，token 过期优先在本地自愈：

- **Worker 直连**失败后看适配器结论：sub2api 站 accessToken 过期会自动
  `refreshToken` 换新 → 不行再账密重新登录 → 用新 token 重试签到；成功就完全不降级
  （文案分别标「刷新 token 后签到」「重新登录后签到」）；
- 两条回退都拿不到 token 时，**原因会写进面板文案**（旧版只透传站点原文，
  看起来像「根本没尝试重新登录」）：
  `Token has expired（accessToken 已过期或失效；刷新失败：invalid refresh token；账密登录失败：turnstile verification failed）`；
- 若失败形态是「登录接口本身要求人机验证（Turnstile）/ WAF」，换出口无解：适配器会标
  `needsBrowser`，Worker 直接把它降级到**浏览器通道**（不再浪费一次注定失败的 gha_api 运行）；
- `gha_api` 侧同理：本次 run 没带 browser job 时，`scripts/gha-checkin.mjs` 会反向请求
  面板补触发一次浏览器通道，否则这类渠道当天就漏签。
- **多家人机验证同时生效**（星见雅，2026-10-15 起）是**第四种形态**，也是最容易做错的：
  站点在 `/api/status` 里把 `checkin_turnstile_check` 与 `checkin_hcaptcha_check`
  **同时**置真，服务端要求**两个 token 都非空**：

  | 提交 | 服务端回话 |
  |------|-----------|
  | 不带 token / 只带一家 | 「人机验证 token 为空」 |
  | 两家都带（即使是假的） | 「Turnstile 校验失败，请刷新重试！」← 先校验 Turnstile |

  站点前端也是把启用的 token **全部** append 到同一个 query 上：
  `POST /api/user/checkin?turnstile=<ts>&hcaptcha=<hc>`。所以浏览器通道改成
  **多厂商同时自挂**：按 `checkin_<vendor>_check` 把每一家都挂上、拿到全部 token 后
  一起提交（每家一个独立容器、token 按厂商分别收；缺哪家补哪家的 SDK，被 SPA 重渲染
  清掉就重挂）。旧实现在 hCaptcha / reCAPTCHA 之间二选一，必然漏一家，于是每次都卡在
  「token 为空」，重试多少次都没用 —— `scripts/test-human-verify.py` 把这条钉住了。

  两个易错点：① 判据只认 `checkin_<vendor>_check`，**不能**回退到全局的
  `turnstile_check` / `hcaptcha_check`（那两个是登录用的；星见雅正是
  `turnstile_check=false` 而 `checkin_turnstile_check=true`）；
  ② 声明里含 reCAPTCHA 时仍走下面的站点 UI 驱动 —— v2 的 token 与页面 origin 绑定，
  自挂会被判低分。

  Cloudflare 对机房出口常静默不签发 Turnstile 挑战，所以这个渠道建议保留住宅代理。

  **当前状态（2026-10-15）**：Turnstile 那一半已经打通（真机运行能拿到 token），
  hCaptcha 那一半卡在**浏览器侧**——`api.hcaptcha.com` / `api2.hcaptcha.com` /
  `newassets.hcaptcha.com` 在 Camoufox 里一律 `NetworkError`，而只有 SDK
  （`js.hcaptcha.com`，脚本加载不受 CORS/ORB 约束）能通。同一批出口用裸 socket 发
  **真实 HTTP 请求**（含经代理）这三个域名全是 302/200 正常，所以拦的不是出口。
  已排除：CSP（站点两页都没有）、跟踪保护名单（关掉后复测无改善，改动已回退）、
  出口 IP（直连 + 3 个住宅出口结果相同）。失败文案里会带上「页面内可达性」与
  「各出口」两段实测数据，便于下次直接看结论。星见雅渠道暂时保持停用。
- **Google reCAPTCHA v2**（星见雅等）单独处理，**不能照搬 Turnstile 的自挂组件**：
  reCAPTCHA v2 的 token 与渲染它的那个页面 origin 绑定，自挂 widget 拿到的 token 会被
  判低分。所以浏览器通道对这类站改成**驱动站点自己的 UI** —— 打开 `/console/personal`
  → 点站点自己的签到按钮 → 点 `api2/anchor` 里的勾选框 → 轮询权威状态确认，全程不接触
  token（站点前端拿到 token 后自己 `POST /api/user/checkin?recaptcha=<token>`）。
  渠道编辑弹窗里的「该站用 Google reCAPTCHA v2」可强制走这条分支，留空则自动探测。
- **站点自建的图片验证码**（jianzhile.vip，NewAPI local-0.0.29 定制版）是第三种形态，
  **既不是 Turnstile 也不是 reCAPTCHA**：站点后端自己画 5 位图形验证码，页面上不挂任何
  第三方组件，所以「自挂组件拿 token」和「点站点勾选框」两条路都走不通。2026-10-15 实测：
  - 判据：`/api/status` 的 `turnstile_check` 是 **false**，但 `/api/user/checkin` 的状态
    回话里有 `captcha_enabled: true`。适配器把状态里的这个开关带进 `status.captchaEnabled`，
    浏览器通道则用它决定要不要走验证码分支（只读查询，不消耗验证码）
  - **签到接口只认浏览器会话**：带访问令牌（`Bearer` + `New-Api-User`）一律回
    「请打开网站后再签到」，同一请求换成 session cookie 立刻返回验证码图片。而**状态查询
    两种凭证都认** —— 所以「状态查得到、签到报请打开网站」是这道闸门的特征，**不是令牌过期**，
    别去重新生成访问令牌（渠道的 Cookie 栏必须填含 `session=` 的浏览器 Cookie）
  - 流程：`POST /api/user/checkin/captcha` 取图（`captcha_id` + base64 PNG）→ 本地 OCR
    → `POST /api/user/checkin {captcha_id, captcha_answer}`。回话判据逐条实测：
    答对且未签 = `success:true`；**答对但今天已签 = 「今日已签到」**（站点先校验验证码、
    再判已签，所以这句反过来是「答案对了」的证据，不能当失败）；答错 = 「验证码错误，请重试」；
    id 过期/复用 = 「验证码已失效」
  - OCR：ddddocr 收窄到字母数字字符集，按固定网格切成 5 个字格，每格跑 3 种预处理取
    置信度最高的读数。**单轮通过率实测约 70–75%**，所以做成重试循环（默认 6 次，
    失败概率约 0.07%），答错就换一张重来；有字格读不出来时直接换图，不浪费一次提交。
    注意服务端**区分大小写**（实测：原样提交 9/12 通过，翻转大小写 0/12 通过），
    所以不能把大小写归一化
  - **会话自动刷新（主动）**：session 有有效期，过期后服务端同样回「请打开网站后再签到」。
    渠道里存了账密时，脚本进页面后先用 `session_alive()` 只读探一次会话，失效就立刻用
    `POST /api/user/login` 换一个新 session 再开始签到（该站登录接口不挂人机校验，实测可用）；
    换到的 cookie 经 `newTokens` 回传、面板写回 KV，之后直接复用，用户不必手抄。
    **续期成功但签到失败时也会回写**，所以不会每次重跑都重新登录。没存账密才提示手动更新。
  - **签到接口的请求头要求**（2026-10-15 逐条实测，浏览器通道的页内 fetch 天然满足）：

    | 头 | 要求 | 缺了会怎样 |
    |----|------|-----------|
    | `Cookie: session=…` | **必需** | 只带访问令牌 → 「请打开网站后再签到」 |
    | `New-Api-User: <用户ID>` | **必需** | 401「Unauthorized, New-Api-User header not provided」——**对有效会话也照回**，所以探测会话时必须带上它 |
    | `Origin` **或** `Referer`（指向本站） | **必需** | 「请从网站页面发起签到」；Referer 指向别的站点同样被拒 |
    | `Authorization: Bearer …` | 可选 | 与 session 并存无妨，但**不能替代** session |
    | `User-Agent` / `sec-ch-ua` / `sec-fetch-*` / `Accept-Language` | 不校验 | 带与不带结果相同（实测） |
  - 依赖：浏览器通道需要 `ddddocr opencv-python pillow numpy`（workflow 里已装）
  - 回归：`python scripts/test-captcha.py`（判据 + 版面几何，不联网、不依赖 ddddocr）

- **社区站（NodeSeek / linux.sb）也吃这条降级链**：它们走纯 HTTP 时会被 Cloudflare 拦住
  （Worker 出口 NodeSeek 302 / linux.sb 403，Azure 出口两站都是 403 挑战页），适配器会把
  这类失败标成 `needsBrowser`，于是渠道即使配的是 `worker` 也会降到 `gha_browser`；
  持续跑请直接把这两个渠道的通道设成 `gha_browser`，省掉前面两次注定失败的尝试。
  浏览器通道的流程见 `scripts/browser-checkin.py` 的 `nodeseek_browser_checkin` /
  `linuxsb_browser_checkin`（后者含「签到后自动抽称号」）。


---

## 🧩 扩展新渠道

1. 在 `src/adapters/` 新建适配器，实现：

```js
export const xxxAdapter = {
  id: "xxx",
  name: "XXX",
  description: "...",
  fields: [/* UI 字段 */],
  async login(channel) {},
  async me(channel) {},
  async status(channel) {},
  async checkin(channel) {},
};
```

2. 在 `src/adapters/index.js` 注册。

建议返回：

```js
{ ok, message, user?, status?, result?, tokens?, raw? }
```

`tokens` 会被前端写回本地渠道配置（例如刷新后的 JWT / Cookie）。

---

## 🔎 代理检测（GitHub / Worker）

面板默认选择 **GitHub · HTTPS 检测**。Worker 的 TCP 出口与 GitHub 不同，且 Worker
只能做协议握手；Worker 测不通不能直接判断代理在 GitHub 也不可用。

### 配置与上线顺序

1. 将 `.github/workflows/proxy-test.yml`、`scripts/gha-proxy-test.mjs` 和相关源码推送到
   `GH_REPO` 的**默认分支**，启用 Actions。只在本地新增工作流不会生效。
2. Worker 配置 `GH_TOKEN`（可调用 repository_dispatch 的令牌，fine-grained PAT 需仓库
   Contents 写权限，classic PAT 需 repo 权限）、`GH_REPO=owner/repo`、`CRON_SECRET`。
3. GitHub Actions Secrets 配置 `HUB_BASE_URL`（面板的 HTTPS 根地址）、`HUB_SECRET`
   （与 Worker 的 `CRON_SECRET` 相同）。代理检测不需要 `HUB_ACCESS_PASSWORD`；现有签到
   工作流读取渠道仍需按原配置设置该密码。
4. 执行 `npm run deploy` 部署 Worker，在面板保存并启用代理，点击「测试启用代理」。

检测任务只把 `jobId` 放入 GitHub 事件。runner 使用 `X-Cron-Secret` 获取该任务的代理快照，
以最多 5 路并发请求公开的 HTTPS IP 服务，再把结果回写当前代理池。不会读取渠道凭证，
不会因检测复活已删除的代理；较旧任务也不会覆盖已写入的新检测结果。

- 支持 HTTP、HTTPS、SOCKS4(a)、SOCKS5(h)，单次最多 100 个启用代理。
- 默认校验目标和 HTTPS 代理的 TLS 证书，**不使用 `--insecure` 或 `--proxy-insecure`**。
  证书失败会明确显示，不冒充“已安全可用”。
- 带凭证的 SOCKS5 先测免认证；只有带认证才通时，标记为浏览器认证不兼容。
- 结果包含检测来源、时间、延迟、出口 IP 和错误分类。HTTPS 通过不代表目标站一定能过盾；
  浏览器签到原有的证书安全检查仍保留。
- GitHub 异步返回 `202`，面板每 5 秒刷新，重新打开页面也能恢复任务状态。
  KV 跨区域传播可能延迟约一分钟；30 分钟未回写会显示超时及排查提示，任务记录保留 24 小时。
- 「Worker · 握手诊断」保留原来的快速诊断，但不验证代理转发后的目标 TLS 或出口 IP。

接口：`POST /api/proxies/test {"runner":"github"}` 提交；
`GET /api/proxies/test?id=<jobId>` 查结果（省略 id 查最近任务）。这些接口需要面板登录。
runner 专用的 `GET /api/proxies/test/task`、`POST /api/proxies/test/result` 不使用面板登录，
而是**始终**要求正确的 `X-Cron-Secret`，即使面板本身未设访问密码也是如此。

## 💬 Telegram 指令和按钮

只需要通知时，保留已有的 `TG_BOT_TOKEN` 和 `TG_CHAT_ID` 即可。开启交互还需配置
`TG_WEBHOOK_SECRET`：16–256 位随机字母、数字、`_` 或 `-`（建议用 32 字节随机数的 hex）。
使用 `npx wrangler secret put <变量名>` 保存，不把真实令牌写进仓库。

`TG_CHAT_ID` 必须是数值聊天 ID。群聊还**必须**配置 `TG_ALLOWED_USER_ID`，否则拒绝群成员操作；
私聊配置该值后也只允许该用户。Webhook 只接受正确的 Telegram secret header 与指定聊天/用户，
并用 `CHECKIN_KV` 按 update_id 去重 24 小时。KV 为最终一致存储，不承诺跨区域并发严格 exactly-once。
配置中的聊天 ID 必须是非零安全整数，用户白名单必须是正整数；填错时拒绝执行，
不会退回“允许全部用户”。普通文本、`/checkin123` 等非完整指令不会触发操作。
按钮先回执再执行，重复 update 只回执、不重复派发；KV 去重读写失败时返回 503。
超过 Telegram 单条上限的通知会转换为纯文本分条发送（最多 10 条），避免截断 HTML 或 emoji。

部署后登录面板，在 Telegram 区域点击「注册 Webhook / 指令」，再向机器人发送 `/start`。
也可在已登录状态下 `POST /api/tg/setup`。注册地址固定为当前 HTTPS 面板的
`/api/tg/webhook`，不会清空 Telegram 的待处理消息；`GET /api/tg/status` 可检查注册状态。
注册前会检查 KV 与群聊白名单；状态接口不回显旧 Webhook 地址中的用户信息、查询串或密钥。
如 Webhook 注册成功但命令菜单设置失败，会明确提示部分成功，可以重新注册。

| 指令 | 功能 |
|------|------|
| `/start`、`/help` | 帮助与操作按钮 |
| `/status` | 渠道启用数和最近签到概况 |
| `/checkin` | 请求签到，结果通过既有通知流程推送 |
| `/proxies` | 查看打码后的代理及最近检测结果 |
| `/testproxies` | 提交 GitHub 代理检测，完成后收到汇总通知 |

---

## 📁 目录结构

```text
checkin-hub/
├── package.json
├── wrangler.toml
├── README.md
├── .dev.vars.example
└── src/
    ├── index.js          # Worker 入口 + API
    ├── auth.js           # 访问密码 / 会话
    ├── kv.js             # CHECKIN_KV 读写
    ├── ui.html           # 前端面板（单文件）
    └── adapters/
        ├── index.js
        ├── sub2api.js
        ├── newapi.js
        ├── agentrouter.js
        ├── anyrouter.js
        ├── forum.js         # NodeSeek / linux.sb 共用的签到工厂
        ├── nodeseek.js
        ├── linuxsb.js
        ├── nodeloc.js       # Discourse discourse-checkin
        └── onyxaxis.js      # Obsidian Arc（Axis AI）：会话 Cookie / 账密登录
```

---

## 🔒 安全提醒

- 不要把含密码 / Cookie / JWT 的导出 JSON 或 HAR 发到公开地方
- 生产环境请设置 `ACCESS_PASSWORD`，或叠加 Cloudflare Access
- 本工具仅用于你有权操作的账号自动签到
- 部分站点有 Cloudflare / WAF 防护，Worker 代发可能被拦截，需改用 Cookie 会话或自行适配

---

## 🛠 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 本地开发 |
| `npm run deploy` | 部署到 Cloudflare Workers |
| `npm run tail` | 查看线上日志 |
| `npm test` | 全量离线回归：适配器、降级路由、抽奖、验证码、代理任务/runner/面板轮询、HTTP 鉴权与 Telegram |
| `npm run test:forum` | 只跑社区站适配器（nodeseek / linuxsb / nodeloc）的离线回归测试 |
| `npm run test:onyxaxis` | 只跑 Obsidian Arc（onyxaxis）适配器的离线回归测试 |
| `npm run test:lottery` | 只跑 Sub2API 抽奖（含浏览器通道页内抽奖 JS）的离线回归测试 |
| `npm run test:browser` | 只跑浏览器通道的纯函数判据（`python scripts/test-forum-browser.py` + `python scripts/test-captcha.py` + `python scripts/test-human-verify.py`，不联网、不开浏览器、不依赖 ddddocr） |
| `npm run test:proxy` | 代理解析、GitHub 分发/回写、curl 行为、面板轮询和管理接口鉴权（全部 mock，不联网） |
| `npm run test:tg` | Telegram 指令、按钮、Webhook 鉴权、重复更新和注册流程（mock，不联网） |

---

## License

MIT

---

## 致谢

- [Cloudflare Workers](https://workers.cloudflare.com/)
- NewAPI / Sub2API 生态相关开源实现
