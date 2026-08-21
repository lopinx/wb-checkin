# WorkBuddy 每日积分自动签到

WorkBuddy（腾讯 CodeBuddy Copilot）每日积分自动签到脚本，支持 **Cloudflare Workers 定时执行** 与 **本地 Node.js 直接运行** 两种模式，单文件零运行时依赖。环境变量与原青龙面板版格式完全兼容，可直接迁移。

## 功能

- 每日自动调用签到接口（幂等，重复执行不重复发积分）
- 支持多账号（环境变量 `WORKBUDDY` 每行一个账号）
- 签到前后积分对比，展示本次获得量
- WxPusher 微信推送通知
- Cloudflare Cron 定时 / HTTP 手动触发 / 本地命令行三入口

## 环境要求

| 工具 | 版本 | 用途 |
|------|------|------|
| Node.js | ≥ 18（推荐 20+） | 本地运行、wrangler |
| wrangler | ≥ 3 | 部署到 Cloudflare |

安装依赖（仅 wrangler）：

```bash
mise exec -- npm install
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `WORKBUDDY` | 三选一 | 多账号，每行 `ACCESS_TOKEN#UID#备注`，换行分隔 |
| `WORKBUDDY_ACCESS_TOKEN` + `WORKBUDDY_UID` | 三选一 | 旧单账号兜底 |
| （本机令牌文件） | 三选一 | 仅本地模式：自动探测 `workbuddy-desktop.info` |
| `WORKBUDDY_SECRET` | 否 | CF 端 HTTP 手动触发鉴权密钥 |
| `WXPUSHER_APP_TOKEN` / `WXPUSHER_UID` | 否 | WxPusher 推送通知 |

> accessToken 是 JWT，约 60 天有效；过期后对应账号报 401，更新对应变量即可。签到接口幂等，重复执行不重复发放。

### 本机文件兜底（仅本地运行）

本地运行时若未设置环境变量，会自动读取以下路径的 `workbuddy-desktop.info`：

- Windows: `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
- Windows: `%APPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
- macOS: `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
- Linux: `~/.config/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`

文件中的 `auth.accessToken` 与 `account.uid` 会作为单账号使用。

## 本地 Node.js 运行

```bash
cp .env.example .env   # 可选：填写账号信息（也可不填，走本机令牌文件兜底）
mise exec -- node src/main.js --dry-run    # 首次建议试跑，不发请求
mise exec -- node src/main.js              # 正式签到
mise exec -- node src/main.js --no-notify  # 签到但不推送通知
```

本地可用 `.env` 文件配置环境变量（不会覆盖已存在的系统变量）。

退出码：全部成功 / dry-run 为 0，有真实失败为 1，未找到任何登录态为 2。

## GitHub Actions 运行

项目内置 `.github/workflows/checkin.yml`，支持定时自动签到和手动触发，无需服务器或额外部署。

### 配置 Secrets

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：

| Secret | 必填 | 说明 |
|--------|------|------|
| `WORKBUDDY` | 是 | 多账号，每行 `ACCESS_TOKEN#UID#备注`，换行分隔 |
| `WXPUSHER_APP_TOKEN` | 否 | WxPusher 推送通知 |
| `WXPUSHER_UID` | 否 | WxPusher 推送目标 UID |

> `WORKBUDDY_SECRET` 仅用于 CF Workers HTTP 鉴权，GitHub Actions 不需要。

### 自动定时

Workflow 默认每天 UTC 01:30（北京时间 09:30）执行，与 `wrangler.toml` 的 cron 一致。GitHub Actions cron 使用 UTC，且可能有几分钟延迟。

### 手动触发

在仓库 **Actions → WorkBuddy 签到 → Run workflow** 可手动触发，支持勾选「干跑」选项（不实际请求签到接口）。

## Cloudflare Workers 部署

```bash
mise exec -- npx wrangler login

# 设置多账号（粘贴多行值，每行 ACCESS_TOKEN#UID#备注）
mise exec -- npx wrangler secret put WORKBUDDY
# 可选：HTTP 手动触发鉴权
mise exec -- npx wrangler secret put WORKBUDDY_SECRET
# 可选：WxPusher 通知
mise exec -- npx wrangler secret put WXPUSHER_APP_TOKEN
mise exec -- npx wrangler secret put WXPUSHER_UID

mise exec -- npx wrangler deploy
```

定时任务由 `wrangler.toml` 的 `[triggers] crons` 配置，默认 `30 1 * * *`（UTC，即北京时间 09:30）每天执行一次。如需调整时间，修改 cron 表达式后重新部署。

### 手动触发（HTTP）

部署后可通过 HTTP 手动触发，便于测试：

```bash
# 带鉴权密钥时
curl "https://<your-worker>.workers.dev/?key=YOUR_SECRET"
# 干跑
curl "https://<your-worker>.workers.dev/?key=YOUR_SECRET&dry=1"
# 跳过通知
curl "https://<your-worker>.workers.dev/?key=YOUR_SECRET&no-notify=1"
```

不设置 `WORKBUDDY_SECRET` 时接口无鉴权，请谨慎公开暴露。

本地模拟 Worker 环境可用 `mise exec -- npx wrangler dev`，再请求 `http://localhost:8787/` 验证。

## 从青龙面板迁移

JS 版环境变量与原青龙 Python 版格式完全兼容，`WORKBUDDY` 多账号格式一致，可直接迁移。

## License

[WTFPL](./LICENSE) – Do What The Fuck You Want To.
