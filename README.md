# Check-in Hub

多渠道自动签到面板，一键部署到 **Cloudflare Workers**。

在浏览器里管理 Sub2API / NewAPI / AgentRouter 等站点渠道，支持签到、状态查询、用户信息、批量并发签到，以及导入导出配置。

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

---

## ✨ 功能特性

- **多渠道适配**：内置 `sub2api` / `newapi` / `agentrouter`，可继续扩展
- **卡片式首页**：所有渠道直接展示，支持按类型筛选与多种排序
- **弹窗编辑**：新增 / 编辑渠道使用模态框，不打断列表浏览
- **并发签到**：全部签到使用 `Promise.allSettled` 并发执行
- **悬浮 Toast**：操作结果顶部悬浮提示；完整日志在侧边 Log 抽屉
- **点击跳转**：点击渠道名称直接打开对应站点
- **本地凭证**：默认只保存在浏览器 `localStorage`，Worker 仅在操作时代发
- **访问密码**：可选 `ACCESS_PASSWORD` 保护面板与业务 API
- **可选定时任务**：绑定 KV + Cron 后可做服务端批量签到
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

## ⏰ 定时签到（可选）

1. 创建 KV，并在 `wrangler.toml` 绑定 `CHECKIN_KV`
2. 将渠道 JSON 数组写入 key `channels`（结构同 UI 导出）
3. 设置 `CRON_SECRET`，解开 cron 注释
4. 也可手动触发：

```bash
curl -X POST https://<your-worker>/api/cron/run \
  -H "X-Cron-Secret: your-secret"
```

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
    ├── ui.html           # 前端面板（单文件）
    └── adapters/
        ├── index.js
        ├── sub2api.js
        ├── newapi.js
        └── agentrouter.js
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

---

## License

MIT

---

## 致谢

- [Cloudflare Workers](https://workers.cloudflare.com/)
- NewAPI / Sub2API 生态相关开源实现
