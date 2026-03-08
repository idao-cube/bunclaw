import { ensureDataDirs, loadConfig, saveConfig } from "./config";
import { DatabaseStore } from "./db";
import { EventLog } from "./event-log";
import { ProcessManager } from "./process-manager";
import { validateFirstFrame, validateReqFrame } from "./protocol";
import type { EventFrame, ResFrame } from "./types";
import { runAgent } from "./agent";

export async function startGateway(options?: { configPath?: string }) {
  const config = await loadConfig(options?.configPath);
  await ensureDataDirs(config);
  const db = new DatabaseStore(config.sessions.dbPath);
  const eventLog = new EventLog(config.sessions.eventsPath);
  const processManager = new ProcessManager();
  db.createSession("main");

  const inMemoryIdem = new Map<string, unknown>();
  let seq = 0;
  const peers = new Set<ServerWebSocket<unknown>>();

  const server = Bun.serve({
    port: config.gateway.port,
    hostname: config.gateway.host,
    fetch(req, serverRef) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "bunclaw-gateway" });
      }
      if (url.pathname === "/ws" && serverRef.upgrade(req)) {
        return;
      }
      if (url.pathname === "/") {
        return Response.redirect(`http://${config.gateway.host}:${config.gateway.port}/chat`, 302);
      }
      if (url.pathname === "/chat") {
        return new Response(renderChatPage(config.gateway.host, config.gateway.port, config.gateway.token || "", config.ui.brandName), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/logs") {
        return new Response(renderLogsPage(config.gateway.host, config.gateway.port, config.gateway.token || "", config.ui.brandName), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/config") {
        return new Response(renderConfigPage(config.gateway.host, config.gateway.port, config.gateway.token || "", config.ui.brandName), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/stats") {
        return new Response(renderStatsPage(config.gateway.host, config.gateway.port, config.gateway.token || "", config.ui.brandName), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("未找到", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.data = { connected: false } as any;
        peers.add(ws);
      },
      close(ws) {
        peers.delete(ws);
      },
      async message(ws, raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          ws.close(1002, "无效 JSON");
          return;
        }

        if (!(ws.data as any).connected) {
          const first = validateFirstFrame(parsed);
          if (!first.ok) {
            ws.close(1008, first.reason);
            return;
          }
          const expected = config.gateway.token?.trim();
          const got = first.frame.auth?.token?.trim();
          if (expected && expected.length > 0 && got !== expected) {
            ws.close(1008, "鉴权失败");
            return;
          }
          (ws.data as any).connected = true;
          ws.send(JSON.stringify({ type: "res", id: "connect", ok: true, payload: { hello: "ok" } }));
          return;
        }

        const valid = validateReqFrame(parsed);
        if (!valid.ok) {
          ws.send(JSON.stringify({ type: "res", id: crypto.randomUUID(), ok: false, error: { code: "bad_request", message: valid.reason } }));
          return;
        }

        const frame = valid.frame;
        const sendRes = (res: ResFrame) => ws.send(JSON.stringify(res));
        const sendEvent = async (event: string, payload: unknown, sessionId?: string) => {
          const item: EventFrame = { type: "event", event, payload, seq: ++seq, ...(sessionId ? { sessionId } : {}) };
          await eventLog.append(item);
          for (const p of peers) p.send(JSON.stringify(item));
        };

        try {
          if ((frame.method === "agent.run" || frame.method === "message.send") && frame.idemKey) {
            const idemKey = `${frame.method}:${frame.idemKey}`;
            if (inMemoryIdem.has(idemKey)) {
              sendRes({ type: "res", id: frame.id, ok: true, payload: inMemoryIdem.get(idemKey) });
              return;
            }
            const dbHit = db.findIdempotent(frame.method, frame.idemKey);
            if (dbHit) {
              const payload = JSON.parse(dbHit);
              inMemoryIdem.set(idemKey, payload);
              sendRes({ type: "res", id: frame.id, ok: true, payload });
              return;
            }
          }

          const payload = await handleMethod(frame.method, frame.params ?? {}, { config, configPath: options?.configPath, db, eventLog, processManager, sendEvent });
          if ((frame.method === "agent.run" || frame.method === "message.send") && frame.idemKey) {
            const idemKey = `${frame.method}:${frame.idemKey}`;
            inMemoryIdem.set(idemKey, payload);
            db.saveIdempotent(frame.method, frame.idemKey, JSON.stringify(payload));
          }
          sendRes({ type: "res", id: frame.id, ok: true, payload });
        } catch (error) {
          sendRes({ type: "res", id: frame.id, ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
        }
      },
    },
  });

  return server;
}

async function handleMethod(
  method: string,
  params: Record<string, unknown>,
  deps: {
    config: Awaited<ReturnType<typeof loadConfig>>;
    configPath?: string;
    db: DatabaseStore;
    eventLog: EventLog;
    processManager: ProcessManager;
    sendEvent: (event: string, payload: unknown, sessionId?: string) => Promise<void>;
  },
): Promise<unknown> {
  if (method === "health") return { ok: true, uptime: process.uptime() };
  if (method === "session.create") return deps.db.createSession(String(params.sessionKey ?? `s-${Date.now()}`));
  if (method === "session.list") return deps.db.listSessions();
  if (method === "session.history") {
    const session = deps.db.createSession(String(params.sessionKey ?? "main"));
    const limit = Number(params.limit ?? 100);
    return deps.db.listMessages(session.id, Number.isFinite(limit) ? limit : 100);
  }
  if (method === "chat.clear") {
    deps.db.clearChatData();
    const main = deps.db.createSession("main");
    await deps.sendEvent("system.chat_cleared", { sessionId: main.id, at: new Date().toISOString() }, main.id);
    return { ok: true, sessionId: main.id };
  }
  if (method === "system.config.get") {
    return {
      gateway: {
        host: deps.config.gateway.host,
        port: deps.config.gateway.port,
        token: deps.config.gateway.token || "",
        allowExternal: Boolean(deps.config.gateway.allowExternal),
      },
      model: {
        baseUrl: deps.config.model.baseUrl,
        apiKey: deps.config.model.apiKey,
        model: deps.config.model.model,
        maxToolRounds: deps.config.model.maxToolRounds,
      },
      tools: { profile: deps.config.tools.profile, allow: deps.config.tools.allow, deny: deps.config.tools.deny },
      storage: deps.config.storage,
      security: { workspaceOnly: deps.config.security.workspaceOnly },
      ui: { brandName: deps.config.ui.brandName },
    };
  }
  if (method === "system.config.file.get") {
    const cfgPath = deps.configPath ?? `${process.cwd()}/.bunclaw/bunclaw.json`;
    const file = Bun.file(cfgPath);
    const text = (await file.exists()) ? await file.text() : `${JSON.stringify(deps.config, null, 2)}\n`;
    return { path: cfgPath, text };
  }
  if (method === "system.config.file.save") {
    const raw = String(params.text ?? "");
    const next = JSON.parse(raw) as typeof deps.config;
    if (!next.gateway || !next.model || !next.tools || !next.sessions || !next.security || !next.ui) {
      throw new Error("配置缺少必要字段");
    }
    Object.assign(deps.config, next);
    const out = `${JSON.stringify(deps.config, null, 2)}\n`;
    await saveConfig(deps.config, deps.configPath);
    await deps.sendEvent("system.config_updated", { at: new Date().toISOString(), source: "raw" });
    return { ok: true, bytes: out.length };
  }
  if (method === "system.config.update") {
    const patch = (params.patch ?? {}) as Record<string, any>;
    if (patch.ui?.brandName !== undefined) deps.config.ui.brandName = String(patch.ui.brandName || "BunClaw");
    if (patch.model?.baseUrl !== undefined) deps.config.model.baseUrl = String(patch.model.baseUrl || deps.config.model.baseUrl);
    if (patch.model?.apiKey !== undefined) deps.config.model.apiKey = String(patch.model.apiKey || "");
    if (patch.model?.model !== undefined) deps.config.model.model = String(patch.model.model || deps.config.model.model);
    if (patch.model?.maxToolRounds !== undefined) deps.config.model.maxToolRounds = Math.max(1, Number(patch.model.maxToolRounds) || 1);
    if (patch.gateway?.allowExternal !== undefined) deps.config.gateway.allowExternal = Boolean(patch.gateway.allowExternal);
    if (patch.gateway?.host !== undefined) deps.config.gateway.host = String(patch.gateway.host || "127.0.0.1");
    if (patch.gateway?.port !== undefined) deps.config.gateway.port = Math.max(1, Number(patch.gateway.port) || deps.config.gateway.port);
    if (patch.gateway?.token !== undefined) deps.config.gateway.token = String(patch.gateway.token || "");
    if (!deps.config.gateway.allowExternal) {
      const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
      if (!localHosts.has(deps.config.gateway.host)) deps.config.gateway.host = "127.0.0.1";
    }
    await saveConfig(deps.config, deps.configPath);
    await deps.sendEvent("system.config_updated", { at: new Date().toISOString() });
    return { ok: true };
  }
  if (method === "stats.usage") {
    const file = Bun.file(deps.config.sessions.eventsPath);
    const text = (await file.exists()) ? await file.text() : "";
    const mem = process.memoryUsage?.();
    const dbFile = Bun.file(deps.config.sessions.dbPath);
    const dbStat = await dbFile.stat().catch(() => null);
    const eventsStat = await file.stat().catch(() => null);
    return {
      sessions: deps.db.countSessions(),
      messages: deps.db.countMessages(),
      totalTokens: deps.db.countTotalTokens(),
      events: text.trim().length === 0 ? 0 : text.trim().split("\n").length,
      uptimeSec: Math.floor(process.uptime()),
      system: {
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        pid: process.pid,
        cwd: process.cwd(),
        workspace: deps.config.sessions.workspace,
        host: deps.config.gateway.host,
        port: deps.config.gateway.port,
        allowExternal: Boolean(deps.config.gateway.allowExternal),
        model: deps.config.model.model,
        baseUrl: deps.config.model.baseUrl,
        memoryRss: Number(mem?.rss ?? 0),
        memoryHeapUsed: Number(mem?.heapUsed ?? 0),
        dbBytes: Number(dbStat?.size ?? 0),
        eventsBytes: Number(eventsStat?.size ?? 0),
      },
    };
  }
  if (method === "message.send") {
    const session = deps.db.createSession(String(params.sessionKey ?? "main"));
    const content = String(params.message ?? "");
    const message = deps.db.insertMessage(session.id, "user", content, { totalTokens: estimateTokens(content) });
    await deps.sendEvent("message.received", { sessionId: session.id, messageId: message.id, content: message.content }, session.id);
    return { sessionId: session.id, messageId: message.id };
  }
  if (method === "agent.run") {
    return await runAgent({
      config: deps.config,
      db: deps.db,
      eventLog: deps.eventLog,
      toolCtx: {
        workspace: deps.config.sessions.workspace,
        processManager: deps.processManager,
        webSearch: {
          endpoint: deps.config.tools.webSearch?.endpoint,
          apiKey: deps.config.tools.webSearch?.apiKey,
        },
      },
      sessionKey: String(params.sessionKey ?? "main"),
      message: String(params.message ?? ""),
      onEvent: (event, payload) => {
        void deps.sendEvent(event, payload, typeof (payload as any)?.sessionId === "string" ? (payload as any).sessionId : undefined);
      },
    });
  }
  if (method.startsWith("process.")) {
    const action = method.split(".")[1];
    if (action === "list") return { items: deps.processManager.list() };
    if (action === "poll") return { item: deps.processManager.poll(String(params.sessionId ?? "")) };
    if (action === "kill") return { ok: deps.processManager.kill(String(params.sessionId ?? "")) };
    throw new Error("未知 process 动作");
  }
  throw new Error(`未知方法: ${method}`);
}

function renderSharedStyle(): string {
  return `
  <style>
    :root {
      --bg:#0f0f11;
      --bg2:#17181c;
      --ink:#eceef2;
      --muted:#b8bdc7;
      --glass:rgba(255,255,255,.08);
      --glass-2:rgba(255,255,255,.12);
      --line:rgba(255,255,255,.18);
      --primary:#f2f3f5;
      --primary-ink:#111216;
      --btn-ink:#111216;
      --danger:#f97373;
    }
    body.theme-light {
      --bg:#f3f4f7;
      --bg2:#e6e8ec;
      --ink:#101216;
      --muted:#4f5968;
      --glass:rgba(255,255,255,.56);
      --glass-2:rgba(255,255,255,.68);
      --line:rgba(15,18,24,.20);
      --primary:#0f1115;
      --primary-ink:#f4f6fa;
      --btn-ink:#111216;
      --danger:#d43737;
    }
    *{box-sizing:border-box}
    html, body { width:100%; height:100%; overflow:hidden; }
    body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; margin:0; color:var(--ink); }
    .liquid-bg {
      height:100vh;
      background:
        radial-gradient(1200px 680px at 8% -12%, rgba(255,255,255,.12) 8%, transparent 58%),
        radial-gradient(980px 540px at 98% 0%, rgba(255,255,255,.08) 12%, transparent 62%),
        radial-gradient(700px 460px at 50% 120%, rgba(255,255,255,.10) 10%, transparent 62%),
        linear-gradient(165deg, var(--bg) 0%, var(--bg2) 60%, #101116 100%);
      position:relative;
      overflow:hidden;
    }
    .liquid-bg::before,.liquid-bg::after{
      content:""; position:absolute; inset:auto;
      width:420px; height:420px; border-radius:42% 58% 57% 43% / 40% 44% 56% 60%;
      background:radial-gradient(circle at 30% 30%, rgba(255,255,255,.28), rgba(255,255,255,.06));
      filter:blur(8px); opacity:.62; pointer-events:none; animation:float 16s ease-in-out infinite;
    }
    .liquid-bg::before{ top:-120px; right:-80px; }
    .liquid-bg::after{ bottom:-140px; left:-100px; animation-delay:-7s; }
    @keyframes float { 0%,100% { transform:translateY(0) rotate(0deg);} 50% { transform:translateY(22px) rotate(10deg);} }
    .app-shell { width:100%; height:100%; padding:14px; position:relative; z-index:1; display:grid; grid-template-rows:auto minmax(0,1fr); gap:10px; overflow:hidden; }
    .header { display:flex; gap:12px; align-items:center; background:var(--glass); backdrop-filter: blur(18px); border:1px solid var(--line); border-radius:14px; padding:10px 14px; box-shadow:0 14px 40px rgba(0,0,0,.28); min-width:0; }
    .brand { display:flex; align-items:center; gap:10px; min-width:0; }
    .logo { width:32px; height:32px; border-radius:10px; background:linear-gradient(150deg,#d7dae0,#868d99); box-shadow:inset 0 1px 0 rgba(255,255,255,.65); }
    .brand-text { font-size:18px; font-weight:700; white-space:nowrap; }
    .menu { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; flex:1; min-width:0; }
    .menu a { text-decoration:none; color:var(--ink); background:rgba(255,255,255,.06); border:1px solid var(--line); padding:8px 12px; border-radius:999px; font-weight:600; }
    .menu a.active { color:var(--primary-ink); background:var(--primary); border-color:#ffffff66; }
    .theme-btn { width:auto; margin:0; padding:8px 12px; border-radius:999px; background:rgba(255,255,255,.12); color:var(--ink); border:1px solid var(--line); font-weight:600; }
    .endpoint-wrap { margin-left:auto; display:flex; flex-direction:column; align-items:flex-end; gap:6px; min-width:0; }
    .endpoint { font-size:12px; color:var(--muted); text-align:right; max-width:46vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .wrap { width:100%; max-width:none; margin:0; padding:0; display:grid; grid-template-columns:1fr; gap:10px; min-height:0; overflow:auto; }
    .card { background:var(--glass); backdrop-filter: blur(16px); border-radius:14px; padding:14px; border:1px solid var(--line); box-shadow:0 14px 36px rgba(0,0,0,.24); min-height:0; overflow:hidden; }
    input, textarea, button { width:100%; box-sizing:border-box; padding:10px; border:1px solid #ffffff30; border-radius:10px; }
    textarea { min-height:90px; resize:vertical; background:rgba(255,255,255,.06); color:var(--ink); }
    input { background:rgba(255,255,255,.06); color:var(--ink); }
    button { background:linear-gradient(180deg,#f0f2f5,#d3d7de); color:var(--btn-ink); border:none; cursor:pointer; margin-top:10px; font-weight:700; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .btn-secondary { background:rgba(255,255,255,.22); color:var(--ink); border:1px solid #ffffff30; }
    .btn-danger { background:linear-gradient(180deg,#fca5a5,#ef4444); color:#fff; }
    pre { background:rgba(0,0,0,.36); color:#eceff4; padding:12px; border-radius:10px; overflow:auto; min-height:220px; white-space:pre-wrap; border:1px solid #ffffff1a; }
    .full { grid-column:1 / -1; }
    .chat-thread { height:100%; min-height:140px; overflow:auto; background:rgba(255,255,255,.03); border:1px solid #ffffff2e; border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:10px; }
    .bubble { max-width:82%; padding:10px 12px; border-radius:12px; line-height:1.45; white-space:pre-wrap; word-break:break-word; }
    .bubble.user { margin-left:auto; background:linear-gradient(180deg,#f4f6f9,#e0e4ea); color:#111216; border-bottom-right-radius:4px; }
    .bubble.assistant { margin-right:auto; background:rgba(255,255,255,.10); color:#eef1f5; border:1px solid #ffffff2b; border-bottom-left-radius:4px; }
    .chat-input-wrap { display:grid; grid-template-columns:minmax(0,1fr) auto auto auto; gap:8px; align-items:end; margin-top:10px; }
    .chat-input { min-height:48px; max-height:160px; margin:0; }
    .chat-action { width:120px; margin:0; }
    .send-status { font-size:12px; color:var(--muted); padding:0 4px; align-self:center; }
    .bubble-meta { margin-top:6px; font-size:11px; color:var(--muted); }
    .log-grid { display:grid; grid-template-columns:1fr; gap:12px; }
    .log-grid, .log-grid > div { min-height:0; height:100%; }
    .log-box { min-height:0; height:100%; }
    .section-title { margin:0 0 10px; }
    .surface-fill { display:grid; grid-template-rows:auto minmax(0,1fr) auto; gap:10px; height:100%; min-height:0; }
    .stats-grid { display:grid; grid-template-columns:repeat(5,minmax(120px,1fr)); gap:10px; }
    .stat { background:var(--glass-2); border:1px solid var(--line); border-radius:12px; padding:12px; }
    .stat .k { font-size:12px; color:var(--muted); }
    .stat .v { font-size:22px; font-weight:700; margin-top:6px; }
    .form-grid { display:grid; grid-template-columns:repeat(2,minmax(220px,1fr)); gap:10px; }
    .seg { display:flex; gap:8px; flex-wrap:wrap; }
    .seg button { width:auto; margin:0; }
    .seg button.active { background:var(--primary); color:var(--primary-ink); }
    .cfg-section { display:none; }
    .cfg-section.active { display:block; }
    .sys-grid { display:grid; grid-template-columns:repeat(2,minmax(220px,1fr)); gap:10px; }
    .sys-item { background:var(--glass-2); border:1px solid var(--line); border-radius:12px; padding:10px; }
    .sys-item .k { font-size:12px; color:var(--muted); }
    .sys-item .v { font-size:14px; margin-top:4px; word-break:break-all; }
    .hint { color:var(--muted); font-size:12px; }
    .raw-config { width:100%; height:48vh; min-height:280px; max-height:64vh; overflow:auto; background:rgba(0,0,0,.32); border:1px solid #ffffff25; border-radius:12px; padding:12px; color:var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height:1.5; }
    .theme-light pre, .theme-light .raw-config { background:rgba(255,255,255,.86); color:#111216; border-color:rgba(0,0,0,.14); }
    .theme-light .bubble.assistant { background:rgba(255,255,255,.82); color:#111216; border-color:rgba(15,18,24,.18); }
    .theme-light .btn-secondary, .theme-light .theme-btn { background:rgba(0,0,0,.06); color:#0f1115; border-color:rgba(15,18,24,.18); }
    @media (max-width: 1200px) {
      .chat-input-wrap { grid-template-columns:minmax(0,1fr) auto auto; }
      .send-status { grid-column:1 / -1; order:4; }
    }
    @media (max-width: 900px) {
      .app-shell { padding:12px; }
      .header { flex-direction:column; align-items:flex-start; }
      .menu { width:100%; justify-content:flex-start; overflow:auto; flex-wrap:nowrap; }
      .endpoint { text-align:left; max-width:100%; }
      .endpoint-wrap { margin-left:0; align-items:flex-start; }
      .stats-grid { grid-template-columns:repeat(2,minmax(120px,1fr)); }
      .sys-grid { grid-template-columns:1fr; }
      .form-grid { grid-template-columns:1fr; }
      .raw-config { height:54vh; max-height:none; }
      .chat-input-wrap { grid-template-columns:1fr; }
      .chat-action { width:100%; }
      .chat-thread { min-height:120px; }
    }
  </style>`;
}

function renderChatPage(host: string, port: number, token: string, brandName: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brandName} Chat</title>
  ${renderSharedStyle()}
</head>
<body class="liquid-bg">
  <div class="app-shell">
    <div class="header">
      <div class="brand">
        <div class="logo"></div>
        <div class="brand-text">${brandName}</div>
      </div>
      <nav class="menu">
        <a href="/chat" class="active">聊天</a>
        <a href="/logs">日志</a>
        <a id="menu-config" href="/config">系统配置</a>
        <a id="menu-stats" href="/stats">统计</a>
      </nav>
      <div class="endpoint-wrap">
        <button id="themeToggle" class="theme-btn">浅色主题</button>
        <div id="header-endpoint" class="endpoint">网关：连接中...</div>
      </div>
    </div>
    <div class="wrap">
      <div class="card surface-fill">
        <div>
          <h2 class="section-title">${brandName} Chat</h2>
          <input id="session" placeholder="会话ID（默认 main）" value="main" />
        </div>
        <div id="chat-thread" class="chat-thread"></div>
        <div class="chat-input-wrap">
          <textarea id="chat-input" class="chat-input" placeholder="输入消息，回车发送（Shift+Enter 换行）"></textarea>
          <div id="sendStatus" class="send-status">空闲</div>
          <button id="sendBtn" class="chat-action">发送</button>
          <button id="clearAllBtn" class="chat-action btn-danger">清除所有消息</button>
        </div>
      </div>
    </div>
  </div>
  <script>
    const thread = document.getElementById('chat-thread');
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('sendBtn');
    const clearAllBtn = document.getElementById('clearAllBtn');
    const sendStatus = document.getElementById('sendStatus');
    const themeToggle = document.getElementById('themeToggle');
    const applyTheme = (theme) => {
      document.body.classList.toggle('theme-light', theme === 'light');
      themeToggle.textContent = theme === 'light' ? '深色主题' : '浅色主题';
      localStorage.setItem('bunclaw_theme', theme);
    };
    applyTheme(localStorage.getItem('bunclaw_theme') || 'dark');
    themeToggle.onclick = () => applyTheme(document.body.classList.contains('theme-light') ? 'dark' : 'light');
    const appendBubble = (role, text, tokens) => {
      const node = document.createElement('div');
      node.className = 'bubble ' + role;
      const content = document.createElement('div');
      content.textContent = text || '';
      node.appendChild(content);
      const meta = document.createElement('div');
      meta.className = 'bubble-meta';
      meta.textContent = typeof tokens === 'number' && tokens > 0 ? ('约 ' + tokens + ' tokens') : '';
      node.appendChild(meta);
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
      return { node, content, meta };
    };
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    document.getElementById('header-endpoint').textContent = '网关：' + wsUrl;
    const ws = new WebSocket(wsUrl);
    const token = ${JSON.stringify(token)};
    const pending = new Map();
    let currentRunId = null;
    let currentAssistantBubble = null;
    let sending = false;
    const ensureReady = () => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('连接尚未就绪，请稍后重试');
    };
    const req = (method, params) => new Promise((resolve) => {
      ensureReady();
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type:'req', id, method, params, idemKey: crypto.randomUUID() }));
    });
    const loadHistory = async () => {
      try {
        const sessionKey = document.getElementById('session').value || 'main';
        const res = await req('session.history', { sessionKey, limit: 100 });
        if (!res.ok || !Array.isArray(res.payload)) return;
        thread.textContent = '';
        for (const m of res.payload) appendBubble(m.role === 'assistant' ? 'assistant' : 'user', m.content || '', m.totalTokens);
      } catch (e) {
        appendBubble('assistant', e instanceof Error ? e.message : String(e));
      }
    };
    const sendMessage = async () => {
      if (sending) return;
      const sessionKey = document.getElementById('session').value || 'main';
      const message = input.value.trim();
      if (!message) return;
      try {
        sending = true;
        sendStatus.textContent = '发送中...';
        sendBtn.disabled = true;
        appendBubble('user', message, Math.max(1, Math.ceil(message.length / 4)));
        input.value = '';
        currentRunId = null;
        currentAssistantBubble = appendBubble('assistant', '思考中...');
        const res = await req('agent.run', { sessionKey, message });
        if (!res.ok && res.error) {
          currentAssistantBubble.content.textContent = 'Agent 执行失败: ' + (res.error.message || JSON.stringify(res.error));
        } else if (res.payload && res.payload.output && !currentAssistantBubble.content.textContent.trim()) {
          currentAssistantBubble.content.textContent = res.payload.output;
          currentAssistantBubble.meta.textContent = '约 ' + Number(res.payload.tokens || 0) + ' tokens';
        }
      } catch (e) {
        appendBubble('assistant', e instanceof Error ? e.message : String(e));
      } finally {
        sending = false;
        sendStatus.textContent = '空闲';
        if (ws.readyState === WebSocket.OPEN) sendBtn.disabled = false;
      }
    };
    const clearAllMessages = async () => {
      if (sending) return;
      try {
        sending = true;
        sendBtn.disabled = true;
        clearAllBtn.disabled = true;
        const res = await req('chat.clear', {});
        if (!res.ok) throw new Error((res.error && res.error.message) || '清理失败');
        thread.textContent = '';
        appendBubble('assistant', '已清除所有聊天消息');
      } catch (e) {
        appendBubble('assistant', e instanceof Error ? e.message : String(e));
      } finally {
        sending = false;
        if (ws.readyState === WebSocket.OPEN) {
          sendBtn.disabled = false;
          clearAllBtn.disabled = false;
        }
      }
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type:'connect', auth:{ token }, client:'bunclaw-ui' }));
      sendBtn.disabled = false;
      clearAllBtn.disabled = false;
      appendBubble('assistant', '已连接网关');
      loadHistory();
    };
    ws.onclose = () => {
      sendBtn.disabled = true;
      clearAllBtn.disabled = true;
      appendBubble('assistant', '连接已断开，请刷新页面后重试');
    };
    ws.onerror = () => {
      sendBtn.disabled = true;
      clearAllBtn.disabled = true;
      appendBubble('assistant', '连接异常，请检查网关状态');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'res' && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.type === 'event' && msg.event === 'agent.delta') {
        if (!currentAssistantBubble) currentAssistantBubble = appendBubble('assistant', '');
        if (!currentRunId) currentRunId = msg.payload && msg.payload.runId ? msg.payload.runId : null;
        if (!currentRunId || msg.payload.runId === currentRunId) {
          if (currentAssistantBubble.content.textContent === '思考中...') currentAssistantBubble.content.textContent = '';
          currentAssistantBubble.content.textContent += msg.payload.text || '';
          thread.scrollTop = thread.scrollHeight;
        }
      }
      if (msg.type === 'event' && msg.event === 'agent.final' && currentAssistantBubble) {
        const t = Number(msg.payload && msg.payload.tokens ? msg.payload.tokens : 0);
        if (t > 0) currentAssistantBubble.meta.textContent = '约 ' + t + ' tokens';
        sendStatus.textContent = '已完成';
      }
    };
    sendBtn.onclick = sendMessage;
    clearAllBtn.onclick = clearAllMessages;
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        sendMessage();
      }
    });
  </script>
</body>
</html>`;
}

function renderLogsPage(host: string, port: number, token: string, brandName: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brandName} Logs</title>
  ${renderSharedStyle()}
</head>
<body class="liquid-bg">
  <div class="app-shell">
    <div class="header">
      <div class="brand">
        <div class="logo"></div>
        <div class="brand-text">${brandName}</div>
      </div>
      <nav class="menu">
        <a href="/chat">聊天</a>
        <a href="/logs" class="active">日志</a>
        <a id="menu-config" href="/config">系统配置</a>
        <a id="menu-stats" href="/stats">统计</a>
      </nav>
      <div class="endpoint-wrap">
        <button id="themeToggle" class="theme-btn">浅色主题</button>
        <div id="header-endpoint" class="endpoint">实时事件流：连接中...</div>
      </div>
    </div>
    <div class="wrap">
      <div class="card">
      <h2 class="section-title">${brandName} Logs</h2>
      <div class="log-grid">
        <div>
          <h3 class="section-title">系统/事件日志</h3>
          <pre id="eventLog" class="log-box"></pre>
        </div>
      </div>
      </div>
    </div>
  </div>
  <script>
    const eventLog = document.getElementById('eventLog');
    const themeToggle = document.getElementById('themeToggle');
    const applyTheme = (theme) => {
      document.body.classList.toggle('theme-light', theme === 'light');
      themeToggle.textContent = theme === 'light' ? '深色主题' : '浅色主题';
      localStorage.setItem('bunclaw_theme', theme);
    };
    applyTheme(localStorage.getItem('bunclaw_theme') || 'dark');
    themeToggle.onclick = () => applyTheme(document.body.classList.contains('theme-light') ? 'dark' : 'light');
    const print = (v) => {
      eventLog.textContent += (typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\\n';
      eventLog.scrollTop = eventLog.scrollHeight;
    };
    const isChatEvent = (evt) => evt === 'message.received' || evt === 'agent.delta' || evt === 'agent.final';
    const normalizeEvent = (msg) => {
      const payload = msg && msg.payload && typeof msg.payload === 'object' ? { ...msg.payload } : msg.payload;
      if (payload && typeof payload === 'object') {
        delete payload.content;
        delete payload.message;
        delete payload.text;
        delete payload.output;
      }
      return { ...msg, payload };
    };
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    document.getElementById('header-endpoint').textContent = '实时事件流：' + wsUrl;
    const ws = new WebSocket(wsUrl);
    const token = ${JSON.stringify(token)};
    const pending = new Map();
    const ensureReady = () => {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error('日志连接尚未就绪');
      }
    };
    const req = (method, params) => new Promise((resolve) => {
      ensureReady();
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type:'req', id, method, params, idemKey: crypto.randomUUID() }));
    });
    ws.onopen = () => {
      ws.send(JSON.stringify({ type:'connect', auth:{ token }, client:'bunclaw-logs' }));
      print('已连接日志流');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'res' && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.type === 'event') {
        if (!isChatEvent(msg.event)) print(normalizeEvent(msg));
      }
    };
    ws.onerror = () => print('连接异常，请检查网关状态');
  </script>
</body>
</html>`;
}

function renderConfigPage(host: string, port: number, token: string, brandName: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brandName} 配置</title>
  ${renderSharedStyle()}
</head>
<body class="liquid-bg">
  <div class="app-shell">
    <div class="header">
      <div class="brand"><div class="logo"></div><div class="brand-text">${brandName}</div></div>
      <nav class="menu">
        <a href="/chat">聊天</a>
        <a href="/logs">日志</a>
        <a id="menu-config" class="active" href="/config">系统配置</a>
        <a id="menu-stats" href="/stats">统计</a>
      </nav>
      <div class="endpoint-wrap">
        <button id="themeToggle" class="theme-btn">浅色主题</button>
        <div id="header-endpoint" class="endpoint">网关：ws://${host}:${port}/ws</div>
      </div>
    </div>
    <div class="wrap">
      <div class="card">
        <h2 class="section-title">系统配置</h2>
        <div class="seg">
          <button id="cfgTabForm" class="btn-secondary">表单配置</button>
          <button id="cfgTabRaw" class="btn-secondary">文本配置</button>
        </div>
        <div id="cfgFormSection" class="cfg-section active">
        <div class="form-grid">
          <div><div class="hint">网关 Host</div><input id="cfgHost" /></div>
          <div><div class="hint">网关 Port</div><input id="cfgPort" type="number" min="1" max="65535" /></div>
          <div><div class="hint">允许外网访问</div><input id="cfgAllowExternal" type="checkbox" style="width:auto" /></div>
          <div><div class="hint">网关 Token</div><input id="cfgToken" /></div>
          <div><div class="hint">模型 Base URL</div><input id="cfgBaseUrl" /></div>
          <div><div class="hint">模型 API Key</div><input id="cfgApiKey" /></div>
          <div><div class="hint">模型 ID</div><input id="cfgModel" /></div>
          <div><div class="hint">工具回合上限</div><input id="cfgRounds" type="number" min="1" max="20" /></div>
          <div><div class="hint">品牌名称</div><input id="cfgBrandName" /></div>
        </div>
        <div class="chat-input-wrap">
          <button id="cfgFormReload" class="chat-action btn-secondary">加载表单</button>
          <button id="cfgFormSave" class="chat-action">保存表单</button>
        </div>
        </div>
        <div id="cfgRawSection" class="cfg-section">
        <div class="hint">直接编辑配置文件：<code id="cfgPath"></code></div>
        <textarea id="cfgRawText" class="raw-config" spellcheck="false" placeholder="{}"></textarea>
        <div class="chat-input-wrap">
          <button id="cfgRefresh" class="chat-action btn-secondary">重新加载</button>
          <button id="cfgFormat" class="chat-action btn-secondary">格式化</button>
          <button id="cfgSave" class="chat-action">保存配置</button>
        </div>
        </div>
        <pre id="cfgLog"></pre>
      </div>
    </div>
  </div>
  <script>
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const themeToggle = document.getElementById('themeToggle');
    const applyTheme = (theme) => {
      document.body.classList.toggle('theme-light', theme === 'light');
      themeToggle.textContent = theme === 'light' ? '深色主题' : '浅色主题';
      localStorage.setItem('bunclaw_theme', theme);
    };
    applyTheme(localStorage.getItem('bunclaw_theme') || 'dark');
    themeToggle.onclick = () => applyTheme(document.body.classList.contains('theme-light') ? 'dark' : 'light');
    const endpoint = document.getElementById('header-endpoint');
    endpoint.textContent = '网关：' + wsUrl;
    const ws = new WebSocket(wsUrl);
    const token = ${JSON.stringify(token)};
    const pending = new Map();
    const log = document.getElementById('cfgLog');
    const pathEl = document.getElementById('cfgPath');
    const rawText = document.getElementById('cfgRawText');
    const formSec = document.getElementById('cfgFormSection');
    const rawSec = document.getElementById('cfgRawSection');
    const tabFormBtn = document.getElementById('cfgTabForm');
    const tabRawBtn = document.getElementById('cfgTabRaw');
    const CFG_TAB_KEY = 'bunclaw_cfg_tab';
    const setTab = (tab) => {
      formSec.classList.toggle('active', tab === 'form');
      rawSec.classList.toggle('active', tab === 'raw');
      tabFormBtn.classList.toggle('active', tab === 'form');
      tabRawBtn.classList.toggle('active', tab === 'raw');
      localStorage.setItem(CFG_TAB_KEY, tab);
    };
    const setForm = (cfg) => {
      document.getElementById('cfgHost').value = cfg.gateway?.host || '127.0.0.1';
      document.getElementById('cfgPort').value = String(cfg.gateway?.port || 16789);
      document.getElementById('cfgAllowExternal').checked = Boolean(cfg.gateway?.allowExternal);
      document.getElementById('cfgToken').value = cfg.gateway?.token || '';
      document.getElementById('cfgBaseUrl').value = cfg.model?.baseUrl || '';
      document.getElementById('cfgApiKey').value = cfg.model?.apiKey || '';
      document.getElementById('cfgModel').value = cfg.model?.model || '';
      document.getElementById('cfgRounds').value = String(cfg.model?.maxToolRounds || 1);
      document.getElementById('cfgBrandName').value = cfg.ui?.brandName || 'BunClaw';
    };
    const print = (txt) => {
      log.textContent += '[' + new Date().toLocaleTimeString() + '] ' + txt + '\\n';
      log.scrollTop = log.scrollHeight;
    };
    const req = (method, params) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type:'req', id, method, params }));
    });
    const loadConfig = async () => {
      const res = await req('system.config.file.get', {});
      if (!res.ok) throw new Error(res.error?.message || '读取配置失败');
      pathEl.textContent = res.payload.path || '.bunclaw/bunclaw.json';
      rawText.value = res.payload.text || '{}\\n';
      print('配置文本已加载');
    };
    const loadForm = async () => {
      const res = await req('system.config.get', {});
      if (!res.ok) throw new Error(res.error?.message || '读取表单配置失败');
      setForm(res.payload || {});
      print('表单配置已加载');
    };
    const formatConfig = () => {
      const parsed = JSON.parse(rawText.value || '{}');
      rawText.value = JSON.stringify(parsed, null, 2) + '\\n';
      print('已格式化 JSON');
    };
    const saveConfig = async () => {
      const parsed = JSON.parse(rawText.value || '{}');
      const text = JSON.stringify(parsed, null, 2) + '\\n';
      const res = await req('system.config.file.save', { text });
      if (!res.ok) throw new Error(res.error?.message || '保存配置失败');
      rawText.value = text;
      print('配置已保存，部分字段需重启网关生效（如 host/port）');
    };
    const saveForm = async () => {
      const patch = {
        ui: { brandName: document.getElementById('cfgBrandName').value.trim() || 'BunClaw' },
        model: {
          baseUrl: document.getElementById('cfgBaseUrl').value.trim() || 'https://api.openai.com/v1',
          apiKey: document.getElementById('cfgApiKey').value.trim() || '',
          model: document.getElementById('cfgModel').value.trim() || 'gpt-4.1-mini',
          maxToolRounds: Number(document.getElementById('cfgRounds').value || '1'),
        },
        gateway: {
          host: document.getElementById('cfgHost').value.trim() || '127.0.0.1',
          port: Number(document.getElementById('cfgPort').value || '16789'),
          allowExternal: Boolean(document.getElementById('cfgAllowExternal').checked),
          token: document.getElementById('cfgToken').value || '',
        },
      };
      const res = await req('system.config.update', { patch });
      if (!res.ok) throw new Error(res.error?.message || '保存表单配置失败');
      await loadConfig();
      print('表单配置已保存，host/port 需重启网关生效');
    };
    ws.onopen = async () => {
      ws.send(JSON.stringify({ type:'connect', auth:{ token }, client:'bunclaw-config' }));
    };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'res' && msg.id === 'connect') {
        try { await loadForm(); await loadConfig(); } catch (e) { print(String(e.message || e)); }
        return;
      }
      if (msg.type === 'res' && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = () => print('连接异常');
    tabFormBtn.onclick = () => setTab('form');
    tabRawBtn.onclick = () => setTab('raw');
    setTab(localStorage.getItem(CFG_TAB_KEY) === 'raw' ? 'raw' : 'form');
    document.getElementById('cfgFormReload').onclick = async () => { try { await loadForm(); } catch (e) { print(String(e.message || e)); } };
    document.getElementById('cfgFormSave').onclick = async () => { try { await saveForm(); } catch (e) { print(String(e.message || e)); } };
    document.getElementById('cfgRefresh').onclick = async () => { try { await loadConfig(); } catch (e) { print(String(e.message || e)); } };
    document.getElementById('cfgFormat').onclick = () => { try { formatConfig(); } catch (e) { print('JSON 格式错误：' + String(e.message || e)); } };
    document.getElementById('cfgSave').onclick = async () => { try { await saveConfig(); } catch (e) { print(String(e.message || e)); } };
  </script>
</body>
</html>`;
}

function renderStatsPage(host: string, port: number, token: string, brandName: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brandName} 统计</title>
  ${renderSharedStyle()}
</head>
<body class="liquid-bg">
  <div class="app-shell">
    <div class="header">
      <div class="brand"><div class="logo"></div><div class="brand-text">${brandName}</div></div>
      <nav class="menu">
        <a href="/chat">聊天</a>
        <a href="/logs">日志</a>
        <a id="menu-config" href="/config">系统配置</a>
        <a id="menu-stats" class="active" href="/stats">统计</a>
      </nav>
      <div class="endpoint-wrap">
        <button id="themeToggle" class="theme-btn">浅色主题</button>
        <div id="header-endpoint" class="endpoint">网关：ws://${host}:${port}/ws</div>
      </div>
    </div>
    <div class="wrap">
      <div class="card">
        <h2 class="section-title">使用统计</h2>
        <div class="stats-grid">
          <div class="stat"><div class="k">会话数</div><div id="statsSessions" class="v">0</div></div>
          <div class="stat"><div class="k">消息数</div><div id="statsMessages" class="v">0</div></div>
          <div class="stat"><div class="k">累计 Tokens</div><div id="statsTokens" class="v">0</div></div>
          <div class="stat"><div class="k">事件数</div><div id="statsEvents" class="v">0</div></div>
          <div class="stat"><div class="k">运行秒数</div><div id="statsUptime" class="v">0</div></div>
        </div>
        <div class="chat-input-wrap">
          <button id="statsRefresh" class="chat-action">刷新统计</button>
        </div>
        <div class="hint">系统信息</div>
        <div id="statsSystem" class="sys-grid"></div>
        <pre id="statsLog"></pre>
      </div>
    </div>
  </div>
  <script>
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const themeToggle = document.getElementById('themeToggle');
    const applyTheme = (theme) => {
      document.body.classList.toggle('theme-light', theme === 'light');
      themeToggle.textContent = theme === 'light' ? '深色主题' : '浅色主题';
      localStorage.setItem('bunclaw_theme', theme);
    };
    applyTheme(localStorage.getItem('bunclaw_theme') || 'dark');
    themeToggle.onclick = () => applyTheme(document.body.classList.contains('theme-light') ? 'dark' : 'light');
    const endpoint = document.getElementById('header-endpoint');
    endpoint.textContent = '网关：' + wsUrl;
    const ws = new WebSocket(wsUrl);
    const token = ${JSON.stringify(token)};
    const pending = new Map();
    const log = document.getElementById('statsLog');
    const systemBox = document.getElementById('statsSystem');
    const print = (txt) => {
      log.textContent += '[' + new Date().toLocaleTimeString() + '] ' + txt + '\\n';
      log.scrollTop = log.scrollHeight;
    };
    const req = (method, params) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type:'req', id, method, params }));
    });
    const loadStats = async () => {
      const res = await req('stats.usage', {});
      if (!res.ok) throw new Error(res.error?.message || '获取统计失败');
      const s = res.payload || {};
      document.getElementById('statsSessions').textContent = String(s.sessions ?? 0);
      document.getElementById('statsMessages').textContent = String(s.messages ?? 0);
      document.getElementById('statsTokens').textContent = String(s.totalTokens ?? 0);
      document.getElementById('statsEvents').textContent = String(s.events ?? 0);
      document.getElementById('statsUptime').textContent = String(s.uptimeSec ?? 0);
      const sys = s.system || {};
      const keys = Object.keys(sys);
      systemBox.innerHTML = keys.map((k) => '<div class="sys-item"><div class="k">' + k + '</div><div class="v">' + String(sys[k]) + '</div></div>').join('');
      print('统计已刷新');
    };
    ws.onopen = () => ws.send(JSON.stringify({ type:'connect', auth:{ token }, client:'bunclaw-stats' }));
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'res' && msg.id === 'connect') {
        try { await loadStats(); } catch (e) { print(String(e.message || e)); }
        return;
      }
      if (msg.type === 'res' && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = () => print('连接异常');
    document.getElementById('statsRefresh').onclick = async () => { try { await loadStats(); } catch (e) { print(String(e.message || e)); } };
  </script>
</body>
</html>`;
}

function estimateTokens(text: string): number {
  const chars = text.trim().length;
  if (!chars) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

