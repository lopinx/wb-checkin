// workbuddy_checkin.js
// WorkBuddy 每日积分自动签到 —— Cloudflare Workers + 本地 Node.js 双模运行
// 部署见 README.md；核心逻辑与平台无关，仅入口分流。
const ENDPOINT_CHECKIN = "https://copilot.tencent.com/v2/billing/meter/daily-checkin";
const ENDPOINT_RESOURCE = "https://copilot.tencent.com/v2/billing/meter/get-user-resource";
const RESOURCE_BODY = { PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3], OnlyValidPeriod: true };
const WXPUSHER_API = "https://wxpusher.zjiecode.com/api/send/message";

const ENV_MULTI = "WORKBUDDY";
const ENV_TOKEN = "WORKBUDDY_ACCESS_TOKEN";
const ENV_UID = "WORKBUDDY_UID";
const ENV_WXPUSHER_TOKEN = "WXPUSHER_APP_TOKEN";
const ENV_WXPUSHER_UID = "WXPUSHER_UID";

// ---------- 环境无关的跨平台工具 ----------
function decodeExp(token) {
  // 从 JWT 解析 exp，失败返回 null；仅用 atob + TextDecoder，CF/Node 均可用
  try {
    let part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = part.length % 4 ? "=".repeat(4 - (part.length % 4)) : "";
    const bin = atob(part + pad);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

function fmtCredits(v) {
  return v === null || v === undefined ? "—" : String(v);
}

async function postJson(url, token, uid, bodyObj = null) {
  const data = bodyObj === null ? "{}" : JSON.stringify(bodyObj);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "X-User-Id": uid,
        "User-Agent": "WorkBuddyCheckin/2.0-cf",
      },
      body: data,
    });
    const text = await resp.text();
    return { status: resp.status, body: text };
  } catch (e) {
    return { status: 0, body: "FetchError: " + e };
  }
}

function parseResult(status, body) {
  let code = null, msg = "", awarded = null, streak = null;
  try {
    const obj = JSON.parse(body);
    code = obj.code ?? null;
    msg = obj.msg || obj.message || "";
    const d = obj.data || {};
    if (d.credit !== undefined && d.credit !== null) awarded = toInt(d.credit);
    if (d.streak_days !== undefined && d.streak_days !== null) streak = toInt(d.streak_days);
  } catch { /* 非 JSON，保留默认 */ }

  if (status === 200 && (code === 0 || code === null)) {
    const extra = streak !== null ? ` (连续 ${streak} 天)` : "";
    return { ok: true, already: false, msg: "签到成功" + extra + (msg ? " | " + msg : ""), awarded, streak };
  }
  if (code === 10001 || body.includes("已签到") || body.toLowerCase().includes("already")) {
    return { ok: true, already: true, msg: "今日已签到(幂等命中)" + (code !== null ? ` | code=${code}` : ""), awarded: 0, streak };
  }
  if (status === 401) {
    return { ok: false, already: false, msg: `令牌失效(401), 请在 ${ENV_MULTI} 对应行更新令牌`, awarded: null, streak: null };
  }
  return { ok: false, already: false, msg: `签到失败 status=${status} code=${code} msg=${msg}`, awarded: null, streak: null };
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

async function queryBalance(token, uid) {
  const { status, body } = await postJson(ENDPOINT_RESOURCE, token, uid, RESOURCE_BODY);
  if (status !== 200) return null;
  try {
    const obj = JSON.parse(body);
    let accts = (obj.data || {}).Response || {};
    accts = (accts.Data || {}).Accounts || [];
    let total = 0;
    for (const a of accts) {
      const v = a.CycleCapacityRemainPrecise ?? a.CycleCapacityRemain ?? a.CapacityRemainPrecise ?? a.CapacityRemain;
      const n = parseFloat(v);
      if (!Number.isNaN(n)) total += n;
    }
    return Math.round(total);
  } catch {
    return null;
  }
}

// ---------- 账号加载 ----------
function parseAccountLine(line) {
  // ACCESS_TOKEN#UID#备注；备注可含 '#'，可省略
  line = (line || "").trim();
  if (!line) return null;
  const parts = line.split("#");
  const token = (parts[0] || "").trim();
  const uid = parts.length > 1 ? parts[1].trim() : "";
  const remark = parts.length > 2 ? parts.slice(2).join("#").trim() : "";
  if (!token || !uid) return null;
  return { token, uid, remark: remark || "(未备注)" };
}

function loadAccounts(env, readFile) {
  // 优先级: WORKBUDDY 多账号 > 旧单账号环境变量 > 本机文件(仅本地)
  const raw = (env[ENV_MULTI] || "").trim();
  const accounts = [];
  if (raw) {
    for (const line of raw.split(/\r?\n/)) {
      const acc = parseAccountLine(line);
      if (acc) {
        acc.src = `<env:${ENV_MULTI}>`;
        accounts.push(acc);
      }
    }
    if (accounts.length) return accounts;
  }

  // 兜底 1: 旧单账号环境变量
  const token = (env[ENV_TOKEN] || "").trim();
  const uid = (env[ENV_UID] || "").trim();
  if (token && uid) {
    return [{ token, uid, remark: "(env单账号)", src: `<env:${ENV_TOKEN}>` }];
  }

  // 兜底 2: 本机文件(仅本地 Node 提供 readFile)
  if (readFile) {
    for (const p of tokenFileCandidates(env)) {
      const parsed = readFile(p);
      if (!parsed) continue;
      const t = parsed?.auth?.accessToken;
      const u = parsed?.account?.uid;
      if (t && u) return [{ token: t, uid: u, remark: "(本机文件)", src: p }];
    }
  }
  return [];
}

function tokenFileCandidates(env) {
  // 跨平台候选路径；LOCALAPPDATA/APPDATA 在 Windows 存在
  const home = env.HOME || env.USERPROFILE || "";
  return [
    joinPath(env.LOCALAPPDATA || "", "CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info"),
    joinPath(env.APPDATA || "", "CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info"),
    joinPath(home, "Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info"),
    joinPath(home, ".config/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info"),
  ].filter(Boolean);
}

// 极简路径拼接，避免顶层引入 node:path
function joinPath(base, rel) {
  if (!base) return "";
  return base.replace(/[\\/]+$/, "") + "/" + rel;
}

// ---------- 通知 ----------
async function notify(title, content, env, log) {
  const sent = await wxpusherSend(title, content, env, log);
  if (sent) log.info("[通知] WxPusher 推送完成");
  else log.info("[通知] 未发送(未配置 WxPusher 或发送失败)");
}

async function wxpusherSend(title, content, env, log) {
  const appToken = (env[ENV_WXPUSHER_TOKEN] || "").trim();
  const uid = (env[ENV_WXPUSHER_UID] || "").trim();
  if (!appToken || !uid) {
    log.info(`[通知] WxPusher 未配置(缺 ${ENV_WXPUSHER_TOKEN}/${ENV_WXPUSHER_UID}), 跳过`);
    return false;
  }
  try {
    const resp = await fetch(WXPUSHER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify({
        appToken: appToken, uids: [uid], topicIds: [], summary: title,
        content: content.replace(/\n/g, "<br>"), contentType: 1, verifyPay: false,
      }),
    });
    const rj = await resp.json().catch(() => ({ code: -1, msg: "响应解析失败" }));
    if (rj.code === 1000) { log.info("[通知] WxPusher 发送成功"); return true; }
    log.info("[通知] WxPusher 返回异常: " + (rj.msg || JSON.stringify(rj)));
    return false;
  } catch (e) {
    log.info("[通知] WxPusher 通知失败: " + e);
    return false;
  }
}

// ---------- 单账号执行 ----------
async function runAccount(acc, dry, log) {
  const { remark, token, uid, src } = acc;
  const exp = decodeExp(token);
  if (exp) {
    const remain = Math.round((exp * 1000 - Date.now()) / 86400000);
    log.info(`账号[${remark}] 已加载(来源 ${src}, uid=${uid}, 令牌剩余 ~${remain}天)`);
  } else {
    log.info(`账号[${remark}] 已加载(来源 ${src}, uid=${uid})`);
  }

  if (dry) {
    log.info(`账号[${remark}] [dry-run] 跳过实际请求`);
    return { remark, ok: null, dry: true, msg: "[dry-run] 未执行", before: null, after: null, gained: null };
  }

  let before = await queryBalance(token, uid);
  if (before === null) log.warning(`账号[${remark}] 签到前积分查询失败, 仍继续`);
  else log.info(`账号[${remark}] 签到前总积分: ${fmtCredits(before)}`);

  const { status, body } = await postJson(ENDPOINT_CHECKIN, token, uid);
  const r = parseResult(status, body);
  log.info(`账号[${remark}] 签到接口返回: ${r.msg}`);

  let after = await queryBalance(token, uid);
  if (after === null) log.warning(`账号[${remark}] 签到后积分查询失败`);
  else log.info(`账号[${remark}] 签到后总积分: ${fmtCredits(after)}`);

  let gained = r.awarded;
  if (gained === null && before !== null && after !== null) gained = after - before;

  if (r.ok) log.info(`账号[${remark}] ✅ ${r.msg}`);
  else log.error(`账号[${remark}] ❌ ${r.msg} | 响应: ${body.slice(0, 300)}`);

  return { remark, ok: r.ok, dry: false, msg: r.msg, before, after, gained };
}

// ---------- 核心入口(平台无关) ----------
function makeLogger(sink) {
  const ts = () => new Date().toISOString();
  return {
    info: (m) => sink(`[${ts()}] INFO  ${m}`),
    warning: (m) => sink(`[${ts()}] WARN  ${m}`),
    error: (m) => sink(`[${ts()}] ERROR ${m}`),
  };
}

async function runCheckin(ctx) {
  // ctx: { env, args?, readFile?, logSink?, dry?, noNotify? }
  const env = ctx.env || {};
  const log = ctx.log ?? makeLogger(ctx.logSink || console.log.bind(console));
  const args = ctx.args || [];
  const dry = ctx.dry ?? args.includes("--dry-run");
  const noNotify = ctx.noNotify ?? args.includes("--no-notify");
  const readFile = ctx.readFile || null;

  const accounts = loadAccounts(env, readFile);
  if (!accounts.length) {
    log.error(`未找到任何登录态: 请设置 ${ENV_MULTI}(每行 ACCESS_TOKEN#UID#备注), 或旧变量 ${ENV_TOKEN}/${ENV_UID}, 或本机 workbuddy-desktop.info`);
    return { exitCode: 2, results: [], title: "WorkBuddy 签到 无账号", content: "未找到任何登录态" };
  }

  log.info(`共加载 ${accounts.length} 个账号, 开始签到${dry ? " [dry-run]" : ""}`);
  const results = [];
  for (const acc of accounts) results.push(await runAccount(acc, dry, log));

  const okCount = results.filter((r) => r.ok === true).length;
  const failCount = results.filter((r) => r.ok === false).length;

  const dateStr = new Date().toISOString().slice(0, 10);
  let title;
  if (dry) title = "WorkBuddy 签到 [dry-run]";
  else if (failCount === 0) title = `WorkBuddy 签到 全部成功 (${okCount}/${results.length})`;
  else title = `WorkBuddy 签到 ${okCount}成功 ${failCount}失败`;

  const lines = [`📅 ${dateStr} 每日签到 (共 ${results.length} 个账号)`, "─".repeat(28)];
  for (const r of results) {
    lines.push(`【${r.remark}】`);
    if (r.dry) { lines.push(`  结果: ${r.msg}`); continue; }
    lines.push(`  结果: ${r.ok ? "✅ " + r.msg : "❌ " + r.msg}`);
    lines.push(`  总积分(签到前→后): ${fmtCredits(r.before)} → ${fmtCredits(r.after)}`);
    if (r.gained !== null && r.gained !== undefined) {
      lines.push(`  本次获得: ${r.gained === 0 ? "0 (今日已签到/无增量)" : "+" + r.gained}`);
    }
    if (!r.ok) lines.push("  状态: 失败, 请检查该账号令牌是否有效");
  }
  const content = lines.join("\n");
  log.info(`已生成通知内容(${results.length} 个账号)`);

  if (!noNotify) await notify(title, content, env, log);
  else log.info("已指定 --no-notify, 跳过推送");

  let exitCode;
  if (dry) exitCode = 0;
  else exitCode = failCount === 0 ? 0 : 1;
  return { exitCode, results, title, content };
}

// ---------- Cloudflare Workers 入口 ----------
export default {
  // 定时触发(Cron): 由 wrangler.toml 的 triggers.crons 配置
  async scheduled(_controller, env, ctx) {
    const log = makeLogger((m) => console.log(m));
    ctx.waitUntil(runCheckin({ env, log }));
  },
  // 手动触发: GET /?key=xxx[&dry=1][&no-notify=1]
  async fetch(request, env) {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
    }
    const url = new URL(request.url);
    const secret = (env.WORKBUDDY_SECRET || "").trim();
    if (secret) {
      const key = url.searchParams.get("key") || request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
      if (key !== secret) return new Response("Forbidden", { status: 403 });
    }
    const dry = url.searchParams.has("dry") ? url.searchParams.get("dry") !== "0" : undefined;
    const noNotify = url.searchParams.has("no-notify") ? url.searchParams.get("no-notify") !== "0" : undefined;
    const logs = [];
    const log = makeLogger((m) => { logs.push(m); console.log(m); });
    const res = await runCheckin({ env, dry, noNotify, log });
    return Response.json({ exitCode: res.exitCode, title: res.title, logs, results: res.results });
  },
};

// ---------- 本地 Node.js 入口(动态、仅 Node 执行) ----------
const isNode = typeof process !== "undefined" && !!process.versions?.node;
const isMain = isNode && (process.argv[1] || "").replace(/\\/g, "/").endsWith("src/main.js");

if (isMain) {
  runLocal().catch((e) => { console.error(e); process.exitCode = 1; });
}

async function runLocal() {
  // 动态引入 Node 专属模块；Cloudflare 不会执行到此函数
  const fs = await import("node:fs");

  await loadDotenv(fs); // 本地可选 .env，便于调试

  // 同步读取本机令牌文件(只在本地兜底路径生效)
  const readFile = (p) => {
    try {
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch (e) {
      console.warn(`读取令牌文件失败 ${p}: ${e}`);
      return null;
    }
  };

  const res = await runCheckin({
    env: process.env,
    args: process.argv.slice(2),
    readFile,
    logSink: (m) => console.log(m),
  });
  process.exitCode = res.exitCode;
}

// 极简 .env 解析(仅本地；不覆盖已存在的环境变量)
async function loadDotenv(fs) {
  let content;
  try { content = fs.readFileSync(".env", "utf-8"); } catch { return; }
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
