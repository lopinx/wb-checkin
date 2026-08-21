# AGENTS.md — wb-checkin

ZCode agent 在本仓库操作前的必读上下文。

---

## 项目概述

WorkBuddy（腾讯 CodeBuddy Copilot）每日积分自动签到脚本。单文件实现，支持 Cloudflare Workers、GitHub Actions 和本地 Node.js 三种运行方式，零运行时依赖。

- **远程仓库**：`git@github.com:lopinx/wb-checkin.git`
- **License**：WTFPL
- **当前版本**：2.0.0

---

## 核心文件

| 文件 | 用途 |
|------|------|
| `src/main.js` | 唯一业务文件，~400 行，包含全部签到逻辑和三种入口 |
| `.github/workflows/checkin.yml` | GitHub Actions 定时任务（UTC 01:30 / 北京 09:30） |
| `wrangler.toml` | Cloudflare Workers 配置，cron 与 GHA 一致 |
| `package.json` | npm scripts：`start`/`dry`/`dev`/`deploy` |
| `.env.example` | 环境变量模板，`.env` 被 `.gitignore` 排除 |

---

## 环境变量（所有模式共用）

| 变量 | 必填 | 说明 |
|------|------|------|
| `WORKBUDDY` | 是 | 多账号，格式 `ACCESS_TOKEN#UID#备注`，换行分隔 |
| `WECOM` | 否 | 企业微信通知，格式 `corpid\|agentid\|secret` |
| `WORKBUDDY_SECRET` | 否 | 仅 CF：HTTP 手动触发鉴权 |

`WECOM` 解析规则：`split("|")` 后 `parseInt(agentid, 10)` 转整数，NaN 时判为无效配置跳过。

---

## 运行命令

```bash
npm start               # node src/main.js
npm run dry             # node src/main.js --dry-run
npm run dev             # wrangler dev（CF 本地调试）
npm run deploy          # wrangler deploy
```

exitCode：0 = 成功/dry-run，1 = 有失败，2 = 无登录态。

---

## 架构约束

1. **`src/main.js` 是单一业务文件**，所有修改在此进行。不得新增独立业务文件。
2. **不能静态 import `node:` 模块**（如 `node:fs`）到顶层——CF Workers 会立即求值并报错。Node 专属能力必须用 `await import("node:fs")` 动态引入（见 `runLocal()`）。
3. `runCheckin(ctx)` 是平台无关核心，`env` 对象注入运行时上下文。新增通知渠道或功能应作为 `runCheckin` 的调用方而非修改其签名。
4. 企业微信通知使用 `touser: "@all"` 推送给应用可见范围内所有成员（非群聊）。

---

## 文档规范

- 修改 `src/main.js` 同步更新 `README.md` 环境变量表和相关章节
- 修改 `README.md` 同步更新 `.env.example` 中的注释
- CRON 表达式变更需同时更新 `wrangler.toml` 和 `.github/workflows/checkin.yml`

---

## 代码风格

- 全部使用简体中文注释和日志输出
- Git commit 使用英文 Conventional Commits
- 函数不超过 50 行，文件不超过 500 行（当前 `src/main.js` 约 400 行）
- 不允许出现未使用的变量或死代码
