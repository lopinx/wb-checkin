# WorkBuddy 每日积分自动签到

> 腾讯 CodeBuddy Copilot 每日积分自动签到脚本，支持 **Cloudflare Workers**、**GitHub Actions** 和 **本地 Node.js** 三种运行方式，单文件零运行时依赖。

[![License](https://img.shields.io/badge/license-WTFPL-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)

---

## 功能

| 特性 | 说明 |
|------|------|
| 🔄 每日签到 | 调用腾讯 CodeBuddy 签到接口，幂等执行不重复发积分 |
| 👥 多账号支持 | `WORKBUDDY` 环境变量每行一个账号，格式 `ACCESS_TOKEN#UID#备注` |
| 📊 积分对比 | 签到前后自动查询总积分，展示本次获得量 |
| 💬 企业微信通知 | 配置 `WECOM` 后自动推送签到结果到企业微信群 |
| ☁️ 三模部署 | Cloudflare Workers / GitHub Actions / 本地 Node.js 任选其一 |

---

## 快速开始

### 1. 准备账号令牌

从本机获取登录态（Windows 示例）：

```bash
cat "$LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info"
```

取出其中的 `accessToken` 和 `uid` 备用。

### 2. 本地运行（开发/调试）

```bash
# 安装依赖
npm install

# 首次试跑（不发请求）
node src/main.js --dry-run --no-notify

# 正式签到
node src/main.js
```

如需配置环境变量，复制模板后填写：

```bash
cp .env.example .env   # 编辑 .env 填入账号信息
```

> `.env` 已在 `.gitignore` 中，不会被提交。

---

## 环境变量

所有运行方式共用同一套环境变量名：

| 变量 | 必填 | 说明 |
|------|------|------|
| `WORKBUDDY` | 三选一 | 多账号，每行 `ACCESS_TOKEN#UID#备注`，换行分隔 |
| `WORKBUDDY_ACCESS_TOKEN` + `WORKBUDDY_UID` | 三选一 | 旧单账号兜底 |
| `WECOM` | 否 | 企业微信通知，格式 `corpid|agentid|secret` |
| `WORKBUDDY_SECRET` | 否 | 仅 CF Workers：HTTP 手动触发鉴权密钥 |

> `accessToken` 是 JWT，约 60 天有效；过期后对应账号报 401，更新对应变量即可。

---

## 三种运行方式

### 方式一：GitHub Actions（推荐）

无需服务器，免费托管，开箱即用。

#### 配置 Secrets

仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| Secret | 说明 |
|--------|------|
| `WORKBUDDY` | 多账号（必填） |
| `WECOM` | 企业微信通知（可选） |

#### 定时触发

Workflow 已内置于 `.github/workflows/checkin.yml`，默认每天 UTC 01:30（北京时间 09:30）自动执行。

也可在仓库 **Actions → WorkBuddy 签到 → Run workflow** 手动触发，支持勾选「干跑」选项。

---

### 方式二：Cloudflare Workers

适合需要自定义 HTTP 接口或已有 CF 环境的用户。

#### 部署步骤

```bash
npm install
npx wrangler login

# 设置 Secrets
npx wrangler secret put WORKBUDDY
npx wrangler secret put WECOM     # 可选
npx wrangler secret put WORKBUDDY_SECRET  # 可选，HTTP 鉴权

# 部署
npx wrangler deploy
```

#### 手动触发（HTTP）

```bash
# 带鉴权密钥时
curl "https://<worker>.workers.dev/?key=YOUR_SECRET"

# 干跑
curl "https://<worker>.workers.dev/?key=YOUR_SECRET&dry=1"

# 跳过通知
curl "https://<worker>.workers.dev/?key=YOUR_SECRET&no-notify=1"
```

本地调试可用 `npx wrangler dev`，访问 `http://localhost:8787/`。

---

### 方式三：本地 Node.js

适合开发者本地调试或作为其他自动化流程的一环。

```bash
npm start            # 正式签到
npm run dry          # 干跑（不发请求）
npm start -- --no-notify   # 签到但不推送通知
```

退出码：全部成功 = 0，有失败 = 1，未找到登录态 = 2。

---

## 项目结构

```
wb-checkin/
├── src/
│   └── main.js              # 核心脚本（~400 行，三模共用）
├── .github/
│   └── workflows/
│       └── checkin.yml      # GitHub Actions 定时任务
├── wrangler.toml            # Cloudflare Workers 配置
├── package.json
├── .env.example             # 环境变量模板
├── .gitignore
├── LICENSE                  # WTFPL
└── README.md
```

**核心架构**：`src/main.js` 为平台无关的单一实现，通过入口分流适配三种运行环境：
- **Cloudflare Workers**：`export default { scheduled, fetch }` — 支持定时和 HTTP 触发
- **GitHub Actions**：直接运行 `node src/main.js`，命中本地入口
- **本地 Node.js**：`isMain` 检测路径自动激活 `runLocal()`

所有三方依赖已通过 `node:fs` 动态 `import()` 隔离，保证 CF Workers 环境下不会被引入。

---

## License

[WTFPL](./LICENSE) — Do What The Fuck You Want To.
