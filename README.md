# Check-in Hub

多渠道自动签到面板，一键部署到 **Cloudflare Workers**。

在浏览器里管理 Sub2API / NewAPI / AgentRouter 等 API 站点，以及 NodeSeek / linux.sb / NodeLoc 等社区论坛的签到，支持签到、状态查询、用户信息、批量并发签到，以及导入导出配置。

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

---

## ✨ 功能特性

- **多渠道适配**：内置 `sub2api` / `newapi` / `agentrouter` / `nodeseek` / `linux.sb` / `nodeloc`，可继续扩展
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
| `sub2api` | Sub2API 系站点 | Bearer JWT | `POST /api/v1/check-in` |
| `newapi` | NewAPI / OneAPI 系 | Cookie + `New-Api-User` | `POST /api/user/checkin` |
| `agentrouter` | AgentRouter 等同系 | Cookie / 账密（登录前先 logout） | 查询用户信息自动签到，兼容 `sign_in` / `checkin` |
| `nodeseek` | NodeSeek（www.nodeseek.com） | Cookie | `POST /api/attendance?random=true`（收益=鸡腿） |
| `linuxsb` | linux.sb（烧饼社区） | Cookie | 打开页面即自动签到；另有「抽称号」动作 |
| `nodeloc` | NodeLoc（www.nodeloc.com，Discourse） | Cookie + CSRF | `POST /checkin`（form 编码 + `X-Checkin-Nonce`） |

### 填写建议

**Sub2API**

- 推荐：邮箱 + 密码（Worker 会登录并必要时 refresh）
- 或直接填 Access Token / Refresh Token

**NewAPI**

- 账密站点：用户名 + 密码
- OAuth 站点：从浏览器 Application → Cookies 复制 Cookie，并填写用户 ID

**AgentRouter**

- 用户名 + 密码（会先清理脏 session）
- 或完整 Cookie；建议填写 `New-Api-User`

**NodeSeek / linux.sb / NodeLoc（社区论坛）**

- 三站都**只认浏览器 Cookie**，没有账密登录，也没有 API 令牌
- 复制方式：浏览器登录后 F12 → Application → Cookies → 复制整站 Cookie
  （NodeLoc 至少要含 `_t`；被 Cloudflare 挑战过的话把 `cf_clearance` 也带上）
- **NodeSeek**：签到单位是「鸡腿」不是美元，面板按积分展示，不会折算成金额。
  站点没有独立状态接口，渠道里填上「论坛用户名」后，「状态」按钮会用当日签到排行榜
  判断今天是否已签。失败时若回 `high risk action`，那是站点风控（不是接口写错），
  换 Cookie / 带 `cf_clearance` / 把通道改成 `gha_api` 依次试
- **linux.sb**：签到是**自动的** —— 打开任意页面时服务端顺手完成，提示写进页面的
  `window.__pageFlash`。所以「签到」= 拉一次首页：有「已帮您完成自动签到」= 刚签上，
  为空 = 今日已签过。卡片上另有 **抽称号** 按钮（`POST /gacha_pull`，每日免费一抽，
  不花积分）；想在每天签到后自动抽，把渠道的 `options.autoGacha` 填 `true`
- **NodeLoc（Discourse）**：会自动用 Cookie 换 `/session/csrf.json` 的会话级 CSRF token，
  通常不用手填；`CSRF Token` 字段只在自动获取失败时用。注意请求体是表单编码
  （`nonce=…&timestamp=…`），不是 JSON
- **NodeSeek 整站挂在 Cloudflare 托管挑战后面**，Workers / Actions 的机房 IP 经常
  被拦。解法：Cookie 里带 `cf_clearance`，或把该渠道的签到通道改成 `gha_api`
  （GitHub Actions 的 Azure 出口 IP）

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
- **Google reCAPTCHA v2**（星见雅等）单独处理，**不能照搬 Turnstile 的自挂组件**：
  reCAPTCHA v2 的 token 与渲染它的那个页面 origin 绑定，自挂 widget 拿到的 token 会被
  判低分。所以浏览器通道对这类站改成**驱动站点自己的 UI** —— 打开 `/console/personal`
  → 点站点自己的签到按钮 → 点 `api2/anchor` 里的勾选框 → 轮询权威状态确认，全程不接触
  token（站点前端拿到 token 后自己 `POST /api/user/checkin?recaptcha=<token>`）。
  渠道编辑弹窗里的「该站用 Google reCAPTCHA v2」可强制走这条分支，留空则自动探测。


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
        └── nodeloc.js       # Discourse discourse-checkin
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
| `npm test` | 离线回归测试（mock fetch，不联网）：鉴权回退 / 降级路由 + 社区站适配器 |
| `npm run test:forum` | 只跑社区站适配器（nodeseek / linuxsb / nodeloc）的离线回归测试 |

---

## License

MIT

---

## 致谢

- [Cloudflare Workers](https://workers.cloudflare.com/)
- NewAPI / Sub2API 生态相关开源实现
