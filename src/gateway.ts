import { ensureDataDirs, loadConfig, saveConfig } from "./config";
import { DatabaseStore } from "./db";
import { EventLog, dayLogFile, dayLogFileByDate, dayWorkspaceDir } from "./event-log";
import { ProcessManager } from "./process-manager";
import { validateFirstFrame, validateReqFrame } from "./protocol";
import type { EventFrame, ResFrame } from "./types";
import { runAgent } from "./agent";
import { resolveAllowedTools } from "./tool-policy";

export async function startGateway(options?: { configPath?: string }) {
  const config = await loadConfig(options?.configPath);
  await ensureDataDirs(config);
  const db = new DatabaseStore(config.sessions.dbPath);
  const eventLog = new EventLog(config.sessions.eventsPath, config.sessions.workspace);
  const processManager = new ProcessManager();
  db.createSession("main");

  const inMemoryIdem = new Map<string, unknown>();
  const activeAbortControllers = new Map<string, AbortController>();
  let seq = 0;
  const peers = new Set<ServerWebSocket<unknown>>();

  const server = Bun.serve({
    port: config.gateway.port,
    hostname: config.gateway.host,
    async fetch(req, serverRef) {
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
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
        });
      }
      if (url.pathname === "/logs") {
        return new Response(renderLogsPage(config.gateway.host, config.gateway.port, config.gateway.token || "", config.ui.brandName), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
        });
      }
      if (url.pathname === "/config") {
        return new Response(renderConfigPage(config.gateway.host, config.gateway.port, config.gateway.token || "", config.ui.brandName), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
        });
      }
      if (url.pathname === "/stats") {
        return new Response(renderStatsPage(config.gateway.host, config.gateway.port, config.gateway.token || "", config.ui.brandName), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
        });
      }
      if (url.pathname === "/skills") {
        return new Response(renderSkillsPage(config.gateway.host, config.gateway.port, config.gateway.token || "", config.ui.brandName), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
        });
      }
      if (url.pathname === "/upload" && req.method === "POST") {
        try {
          const formData = await req.formData();
          const file = formData.get("file") as File | null;
          if (!file) return Response.json({ ok: false, error: "缺少文件" }, { status: 400 });
          const dayDir = dayWorkspaceDir(config.sessions.workspace);
          const uploadDir = `${dayDir}/uploads`;
          await ensureUploadDir(uploadDir);
          const safeName = sanitizeFileName(file.name);
          const dest = `${uploadDir}/${safeName}`;
          await Bun.write(dest, file);
          const servePath = `/files/${dest.slice(config.sessions.workspace.replaceAll("\\", "/").replace(/\/$/, "").length + 1)}`;
          return Response.json({ ok: true, path: dest, url: servePath, name: safeName, size: file.size });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      }
      if (url.pathname.startsWith("/files/")) {
        const rel = decodeURIComponent(url.pathname.slice("/files/".length));
        if (rel.includes("..")) return new Response("禁止路径穿越", { status: 403 });
        const base = config.sessions.workspace.replaceAll("\\", "/").replace(/\/$/, "");
        const full = `${base}/${rel}`;
        const f = Bun.file(full);
        if (!(await f.exists())) return new Response("文件不存在", { status: 404 });
        const mime = f.type || "application/octet-stream";
        return new Response(f, { headers: { "content-type": mime, "cache-control": "public, max-age=86400" } });
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
          if (frame.method === "agent.abort") {
            const runId = String(frame.params?.runId ?? "");
            if (runId && activeAbortControllers.has(runId)) {
              activeAbortControllers.get(runId)!.abort();
              activeAbortControllers.delete(runId);
              sendRes({ type: "res", id: frame.id, ok: true, payload: { aborted: true, runId } });
            } else {
              sendRes({ type: "res", id: frame.id, ok: true, payload: { aborted: false, runId } });
            }
            return;
          }

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

          const payload = await handleMethod(frame.method, frame.params ?? {}, { config, configPath: options?.configPath, db, eventLog, processManager, sendEvent, activeAbortControllers });
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
    activeAbortControllers: Map<string, AbortController>;
  },
): Promise<unknown> {
  if (method === "health") return { ok: true, uptime: process.uptime() };
  if (method === "tools.list") {
    const allowed = [...resolveAllowedTools({
      profile: deps.config.tools.profile,
      allow: deps.config.tools.allow,
      deny: deps.config.tools.deny,
    })];
    return {
      profile: deps.config.tools.profile,
      allowed,
      all: ["read", "write", "edit", "apply_patch", "exec", "process", "web_search", "web_fetch"],
    };
  }
  if (method === "session.create") return deps.db.createSession(String(params.sessionKey ?? `s-${Date.now()}`));
  if (method === "session.list") return deps.db.listSessions();
  if (method === "session.history") {
    const session = deps.db.createSession(String(params.sessionKey ?? "main"));
    const limit = Number(params.limit ?? 100);
    return deps.db.listMessages(session.id, Number.isFinite(limit) ? limit : 100);
  }
  if (method === "logs.list") {
    const limit = Math.max(1, Math.min(500, Number(params.limit ?? 200) || 200));
    let dateStr = typeof params.date === "string" ? params.date.trim() : "";
    if (!dateStr) {
      // 若前端未传 date，自动用本地 today 字符串
      dateStr = new Date().toISOString().slice(0, 10);
    }
    let logPath: string;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      logPath = dayLogFileByDate(deps.config.sessions.workspace, dateStr);
    } else {
      logPath = dayLogFile(deps.config.sessions.workspace);
    }
    const daily = Bun.file(logPath);
    const fallback = Bun.file(deps.config.sessions.eventsPath);
    const text = (await daily.exists()) ? await daily.text() : ((!dateStr && await fallback.exists()) ? await fallback.text() : "");
    if (!text.trim()) return [];
    const lines = text.trim().split("\n");
    const out: Array<Record<string, unknown>> = [];
    for (let i = Math.max(0, lines.length - limit); i < lines.length; i += 1) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const item = JSON.parse(line) as Record<string, unknown>;
        const evt = String(item.event ?? "");
        if (evt === "message.received" || evt === "agent.delta" || evt === "agent.final") continue;
        out.push(item);
      } catch {
        // ignore invalid line
      }
    }
    return out;
  }
  if (method === "chat.clear") {
    deps.db.clearChatData();
    await deps.eventLog.clear();
    const main = deps.db.createSession("main");
    await deps.sendEvent("system.chat_cleared", { sessionId: main.id, at: new Date().toISOString() }, main.id);
    return { ok: true, sessionId: main.id };
  }
  if (method === "skill.list") {
    return await listSkills(deps.config.storage?.skillsDir || `${process.cwd()}/.bunclaw/skills`);
  }
  if (method === "skill.get") {
    const name = String(params.name ?? "").trim();
    const out = await getSkill(deps.config.storage?.skillsDir || `${process.cwd()}/.bunclaw/skills`, name);
    if (!out) throw new Error("技能不存在");
    return out;
  }
  if (method === "skill.save") {
    const name = String(params.name ?? "").trim();
    const content = String(params.content ?? "");
    const out = await saveSkill(deps.config.storage?.skillsDir || `${process.cwd()}/.bunclaw/skills`, name, content);
    await deps.sendEvent("system.skill_saved", { name: out.name, path: out.path, at: new Date().toISOString() });
    return out;
  }
  if (method === "skill.delete") {
    const name = String(params.name ?? "").trim();
    const ok = await deleteSkill(deps.config.storage?.skillsDir || `${process.cwd()}/.bunclaw/skills`, name);
    await deps.sendEvent("system.skill_deleted", { name, ok, at: new Date().toISOString() });
    return { ok };
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
      webSearch: {
        provider: deps.config.tools.webSearch?.provider || "",
        providers: deps.config.tools.webSearch?.providers || [],
        categories: deps.config.tools.webSearch?.categories || [],
        endpoint: deps.config.tools.webSearch?.endpoint || "",
        apiKey: deps.config.tools.webSearch?.apiKey || "",
        timeoutMs: Number(deps.config.tools.webSearch?.timeoutMs ?? 8000),
        customScript: deps.config.tools.webSearch?.customScript || "",
      },
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
    if (patch.tools?.profile !== undefined) deps.config.tools.profile = String(patch.tools.profile || deps.config.tools.profile) as any;
    if (patch.tools?.allow !== undefined && Array.isArray(patch.tools.allow)) deps.config.tools.allow = patch.tools.allow.map((x: unknown) => String(x || "")).filter(Boolean);
    if (patch.tools?.deny !== undefined && Array.isArray(patch.tools.deny)) deps.config.tools.deny = patch.tools.deny.map((x: unknown) => String(x || "")).filter(Boolean);
    if (patch.tools?.webSearch !== undefined) {
      const ws = patch.tools.webSearch as Record<string, unknown>;
      deps.config.tools.webSearch = deps.config.tools.webSearch || {};
      if (ws.provider !== undefined) deps.config.tools.webSearch.provider = String(ws.provider || "");
      if (ws.providers !== undefined && Array.isArray(ws.providers)) deps.config.tools.webSearch.providers = ws.providers.map((x) => String(x || "")).filter(Boolean);
      if (ws.categories !== undefined && Array.isArray(ws.categories)) deps.config.tools.webSearch.categories = ws.categories.map((x) => String(x || "")).filter(Boolean);
      if (ws.endpoint !== undefined) deps.config.tools.webSearch.endpoint = String(ws.endpoint || "");
      if (ws.apiKey !== undefined) deps.config.tools.webSearch.apiKey = String(ws.apiKey || "");
      if (ws.timeoutMs !== undefined) deps.config.tools.webSearch.timeoutMs = Math.max(1000, Number(ws.timeoutMs) || 8000);
      if (ws.customScript !== undefined) deps.config.tools.webSearch.customScript = String(ws.customScript || "");
    }
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
    const dailyPath = dayLogFile(deps.config.sessions.workspace);
    const file = Bun.file(dailyPath);
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
        host: deps.config.gateway.host,
        port: deps.config.gateway.port,
        allowExternal: Boolean(deps.config.gateway.allowExternal),
        model: deps.config.model.model,
        baseUrl: deps.config.model.baseUrl,
        memoryRss: Number(mem?.rss ?? 0),
        memoryHeapUsed: Number(mem?.heapUsed ?? 0),
        dbBytes: Number(dbStat?.size ?? 0),
        eventsBytes: Number(eventsStat?.size ?? 0),
        dayPath: dailyPath,
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
    const abortController = new AbortController();
    const result = await runAgent({
      config: deps.config,
      db: deps.db,
      eventLog: deps.eventLog,
      toolCtx: {
        workspace: deps.config.sessions.workspace,
        processManager: deps.processManager,
        eventLog: deps.eventLog,
        webSearch: {
          provider: deps.config.tools.webSearch?.provider,
          providers: deps.config.tools.webSearch?.providers,
          categories: deps.config.tools.webSearch?.categories,
          endpoint: deps.config.tools.webSearch?.endpoint,
          apiKey: deps.config.tools.webSearch?.apiKey,
          timeoutMs: deps.config.tools.webSearch?.timeoutMs,
          customScript: deps.config.tools.webSearch?.customScript,
        },
      },
      sessionKey: String(params.sessionKey ?? "main"),
      message: String(params.message ?? ""),
      onEvent: (event, payload) => {
        void deps.sendEvent(event, payload, typeof (payload as any)?.sessionId === "string" ? (payload as any).sessionId : undefined);
      },
      abortSignal: abortController.signal,
      onRunId: (runId: string) => {
        deps.activeAbortControllers.set(runId, abortController);
      },
    });
    deps.activeAbortControllers.delete(result.runId);
    return result;
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

type SkillMeta = { name: string; file: string; bytes: number; updatedAt: string };

async function listSkills(skillsDir: string): Promise<SkillMeta[]> {
  await ensureDir(skillsDir);
  const out = new Map<string, SkillMeta>();
  const skillDocGlob = new Bun.Glob("**/SKILL.md");
  for await (const file of skillDocGlob.scan({ cwd: skillsDir })) {
    const full = joinPath(skillsDir, file);
    const stat = await Bun.file(full).stat().catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const parts = file.split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) continue;
    const name = parts[parts.length - 2];
    if (!name) continue;
    out.set(name, {
      name,
      file,
      bytes: Number(stat.size ?? 0),
      updatedAt: stat.mtime?.toISOString?.() || new Date().toISOString(),
    });
  }

  return [...out.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function getSkill(skillsDir: string, name: string): Promise<{ name: string; path: string; content: string } | null> {
  await ensureDir(skillsDir);
  const safe = sanitizeSkillName(name);
  if (!safe) throw new Error("非法技能名称");
  const candidates = [joinPath(skillsDir, `${safe}/SKILL.md`), joinPath(skillsDir, `${safe}/skill.md`)];
  for (const p of candidates) {
    const file = Bun.file(p);
    if (await file.exists()) {
      return { name: safe, path: p, content: await file.text() };
    }
  }
  return null;
}

async function saveSkill(skillsDir: string, name: string, content: string): Promise<{ ok: true; name: string; path: string; bytes: number }> {
  await ensureDir(skillsDir);
  const safe = sanitizeSkillName(name);
  if (!safe) throw new Error("非法技能名称");
  await ensureDir(joinPath(skillsDir, safe));
  const path = joinPath(skillsDir, `${safe}/SKILL.md`);
  await Bun.write(path, content.endsWith("\n") ? content : `${content}\n`);
  const stat = await Bun.file(path).stat().catch(() => null);
  return { ok: true, name: safe, path, bytes: Number(stat?.size ?? 0) };
}

async function deleteSkill(skillsDir: string, name: string): Promise<boolean> {
  await ensureDir(skillsDir);
  const safe = sanitizeSkillName(name);
  if (!safe) throw new Error("非法技能名称");
  const candidates = [joinPath(skillsDir, `${safe}/SKILL.md`), joinPath(skillsDir, `${safe}/skill.md`)];
  for (const p of candidates) {
    const file = Bun.file(p);
    if (await file.exists()) {
      await file.delete();
      return true;
    }
  }
  return false;
}

async function ensureDir(dir: string): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${dir}' -Force | Out-Null`]).exited;
    return;
  }
  await Bun.spawn(["sh", "-lc", `mkdir -p '${dir}'`]).exited;
}

async function ensureUploadDir(dir: string): Promise<void> {
  await ensureDir(dir);
}

function sanitizeFileName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() || "file";
  const safe = base.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "_").slice(0, 128);
  if (!safe || safe === "." || safe === "..") return `upload_${Date.now()}`;
  const ts = Date.now().toString(36);
  const dot = safe.lastIndexOf(".");
  if (dot > 0) return `${safe.slice(0, dot)}_${ts}${safe.slice(dot)}`;
  return `${safe}_${ts}`;
}

function sanitizeSkillName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) return "";
  if (!/^[a-zA-Z0-9._\-\u4e00-\u9fa5]+$/.test(trimmed)) return "";
  return trimmed;
}

function joinPath(a: string, b: string): string {
  const left = a.replaceAll("\\", "/").replace(/\/$/, "");
  return `${left}/${b}`;
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
    .bubble.tool { margin-right:auto; max-width:92%; background:rgba(255,255,255,.07); color:var(--ink); border:1px dashed #ffffff55; border-left:4px solid rgba(255,255,255,.65); border-radius:10px; }
    .bubble.tool .bubble-meta { color:var(--muted); }
    .chat-input-wrap { display:grid; grid-template-columns:minmax(0,1fr) auto auto auto; gap:8px; align-items:end; margin-top:10px; }
    .chat-input-bar { grid-template-columns:auto minmax(0,1fr) auto auto auto; align-items:center; }
    .chat-bottom { display:flex; flex-direction:column; gap:6px; }
    .chat-bar-btn { width:42px; height:42px; margin:0; padding:0; border-radius:10px; font-size:22px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:rgba(255,255,255,.12); color:var(--ink); border:1px solid var(--line); flex-shrink:0; }
    .chat-bar-btn:hover { background:rgba(255,255,255,.22); }
    .chat-bar-select { width:auto; min-width:80px; height:42px; margin:0; padding:4px 8px; border-radius:10px; background:rgba(255,255,255,.10); color:var(--ink); border:1px solid var(--line); font-size:13px; cursor:pointer; appearance:auto; flex-shrink:0; }
    .attach-preview { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
    .attach-preview:empty { display:none; }
    .attach-item { display:flex; align-items:center; gap:4px; background:rgba(255,255,255,.10); border:1px solid var(--line); border-radius:8px; padding:4px 8px; font-size:12px; color:var(--muted); }
    .attach-item img { height:28px; border-radius:4px; }
    .attach-remove { cursor:pointer; font-weight:700; color:var(--danger); margin-left:4px; font-size:14px; }
    .chat-action.is-abort { background:linear-gradient(180deg,#fca5a5,#ef4444); color:#fff; }
    .chat-input { min-height:48px; max-height:160px; margin:0; }
    .input-stack { position:relative; min-width:0; }
    .skill-suggest { position:absolute; left:0; right:0; bottom:100%; margin-bottom:6px; background:var(--glass-2); border:1px solid var(--line); border-radius:10px; max-height:200px; overflow:auto; display:none; z-index:20; backdrop-filter: blur(10px); }
    .skill-suggest.active { display:block; }
    .skill-item { padding:8px 10px; cursor:pointer; border-bottom:1px solid #ffffff1f; font-size:13px; }
    .skill-item:last-child { border-bottom:none; }
    .skill-item:hover, .skill-item.active { background:rgba(255,255,255,.15); }
    .chat-action { width:120px; margin:0; }
    .send-status { font-size:12px; color:var(--muted); padding:2px 6px; white-space:nowrap; text-align:right; }
    .bubble-meta { margin-top:6px; font-size:11px; color:var(--muted); }
    .bubble-images { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
    .bubble-images img { max-width:200px; max-height:180px; border-radius:8px; cursor:pointer; border:1px solid var(--line); }
    .bubble-images img:hover { opacity:.85; }
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
    .theme-light .bubble.tool { background:rgba(255,255,255,.92); color:#111216; border-color:rgba(15,18,24,.28); border-left-color:rgba(15,18,24,.5); }
    .theme-light .btn-secondary, .theme-light .theme-btn { background:rgba(0,0,0,.06); color:#0f1115; border-color:rgba(15,18,24,.18); }
    .theme-light .chat-bar-btn { background:rgba(0,0,0,.06); color:#0f1115; border-color:rgba(15,18,24,.18); }
    .theme-light .chat-bar-btn:hover { background:rgba(0,0,0,.12); }
    .theme-light .chat-bar-select { background:rgba(0,0,0,.04); color:#0f1115; border-color:rgba(15,18,24,.18); }
    .theme-light .attach-item { background:rgba(0,0,0,.05); border-color:rgba(15,18,24,.14); }
    .theme-light .chat-action.is-abort { background:linear-gradient(180deg,#fca5a5,#ef4444); color:#fff; }
    .theme-light .skill-suggest { background:rgba(255,255,255,.92); border-color:rgba(15,18,24,.16); }
    .theme-light .skill-item:hover, .theme-light .skill-item.active { background:rgba(0,0,0,.08); }
    @media (max-width: 1200px) {
      .chat-input-wrap { grid-template-columns:minmax(0,1fr) auto auto; }
      .chat-input-bar { grid-template-columns:auto minmax(0,1fr) auto auto auto; }
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
      .chat-input-bar { grid-template-columns:auto minmax(0,1fr) auto auto; }
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
        <a id="menu-skills" href="/skills">技能管理</a>
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
        <div class="chat-bottom">
          <div id="attachPreview" class="attach-preview"></div>
          <div id="sendStatus" class="send-status">空闲</div>
          <div class="chat-input-wrap chat-input-bar">
            <button id="attachBtn" class="chat-bar-btn" title="上传文件/图片" style="display:none">+</button>
            <input id="fileInput" type="file" accept="image/*,.txt,.md,.json,.csv,.log,.xml,.yaml,.yml,.html,.js,.ts,.py,.sh,.bat,.ps1" multiple style="display:none" />
            <div class="input-stack">
              <div id="skillSuggest" class="skill-suggest"></div>
              <textarea id="chat-input" class="chat-input" placeholder="输入消息，回车发送（Shift+Enter 换行）。支持 @技能名 或 /技能名"></textarea>
            </div>
            <select id="toolSelect" class="chat-bar-select" title="技能/工具" style="display:none">
              <option value="">🔧 工具</option>
            </select>
            <button id="sendBtn" class="chat-action" title="发送/暂停">发送</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const thread = document.getElementById('chat-thread');
    const input = document.getElementById('chat-input');
    const skillSuggest = document.getElementById('skillSuggest');
    const sendBtn = document.getElementById('sendBtn');
    const sendStatus = document.getElementById('sendStatus');
    const themeToggle = document.getElementById('themeToggle');
    const attachBtn = document.getElementById('attachBtn');
    const fileInput = document.getElementById('fileInput');
    const attachPreview = document.getElementById('attachPreview');
    const toolSelect = document.getElementById('toolSelect');
    const attachments = [];
    const applyTheme = (theme) => {
      document.body.classList.toggle('theme-light', theme === 'light');
      themeToggle.textContent = theme === 'light' ? '深色主题' : '浅色主题';
      localStorage.setItem('bunclaw_theme', theme);
    };
    applyTheme(localStorage.getItem('bunclaw_theme') || 'dark');
    themeToggle.onclick = () => applyTheme(document.body.classList.contains('theme-light') ? 'dark' : 'light');
    const appendBubble = (role, text, tokens, images) => {
      const node = document.createElement('div');
      node.className = 'bubble ' + role;
      const content = document.createElement('div');
      content.textContent = text || '';
      node.appendChild(content);
      if (Array.isArray(images) && images.length > 0) {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'bubble-images';
        for (const src of images) {
          const img = document.createElement('img');
          img.src = src;
          img.onclick = () => window.open(src, '_blank');
          imgWrap.appendChild(img);
        }
        node.appendChild(imgWrap);
      }
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
    let skills = [];
    let tools = [];
    let suggestItems = [];
    let suggestIndex = -1;
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
    const escapeHtml = (s) => String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const renderSkillSuggest = () => {
      const text = input.value || '';
      if (!text.startsWith('/')) {
        skillSuggest.classList.remove('active');
        skillSuggest.innerHTML = '';
        suggestItems = [];
        suggestIndex = -1;
        return;
      }
      const afterSlash = text.slice(1);
      if (afterSlash.includes(' ') || afterSlash.includes('\\n') || afterSlash.includes('\\r')) {
        skillSuggest.classList.remove('active');
        skillSuggest.innerHTML = '';
        suggestItems = [];
        suggestIndex = -1;
        return;
      }
      const kwRaw = String(afterSlash || '').toLowerCase();
      const kw = kwRaw === 'skill' ? '' : kwRaw;
      const matched = skills.filter((x) => !kw || String(x.name || '').toLowerCase().includes(kw)).slice(0, 20);
      suggestItems = matched;
      if (matched.length === 0) {
        skillSuggest.classList.remove('active');
        skillSuggest.innerHTML = '';
        suggestIndex = -1;
        return;
      }
      if (suggestIndex >= matched.length) suggestIndex = 0;
      skillSuggest.innerHTML = matched.map((x, i) => '<div class="skill-item ' + (i === suggestIndex ? 'active' : '') + '" data-i="' + i + '">/' + escapeHtml(x.name) + '</div>').join('');
      skillSuggest.classList.add('active');
    };
    const applySkillByIndex = (idx) => {
      const item = suggestItems[idx];
      if (!item) return;
      input.value = '/' + item.name + ' ';
      renderSkillSuggest();
      input.focus();
    };
    const loadSkills = async () => {
      const res = await req('skill.list', {});
      if (res.ok && Array.isArray(res.payload)) skills = res.payload;
    };
    const loadTools = async () => {
      try {
        const res = await req('tools.list', {});
        if (res.ok && res.payload) {
          tools = Array.isArray(res.payload.allowed) ? res.payload.allowed : [];
          toolSelect.innerHTML = '<option value="">🔧 工具</option>';
          for (const t of tools) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            toolSelect.appendChild(opt);
          }
        }
      } catch {}
    };
    const checkModelAvailable = async () => {
      try {
        const res = await req('system.config.get', {});
        if (res.ok && res.payload && res.payload.model) {
          const m = res.payload.model;
          const available = Boolean(m.apiKey && String(m.apiKey).trim() && m.baseUrl && String(m.baseUrl).trim());
          attachBtn.style.display = available ? '' : 'none';
        }
      } catch {}
    };
    toolSelect.onchange = () => {
      const v = toolSelect.value;
      if (!v) return;
      const cur = input.value || '';
      input.value = cur + (cur && !cur.endsWith(' ') ? ' ' : '') + '[工具:' + v + '] ';
      toolSelect.value = '';
      input.focus();
    };
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const files = fileInput.files;
      if (!files || files.length === 0) return;
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        try {
          const res = await fetch('/upload', { method: 'POST', body: form });
          const json = await res.json();
          if (json.ok) {
            attachments.push({ name: json.name || file.name, type: file.type, size: json.size || file.size, url: json.url, dataUrl: null, text: null });
            renderAttachPreview();
          } else {
            appendBubble('assistant', '上传失败: ' + (json.error || '未知错误'));
          }
        } catch (e) {
          appendBubble('assistant', '上传失败: ' + String(e.message || e));
        }
      }
      fileInput.value = '';
    };
    const renderAttachPreview = () => {
      attachPreview.innerHTML = '';
      attachments.forEach((a, i) => {
        const item = document.createElement('div');
        item.className = 'attach-item';
        if (a.url && a.type && a.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = a.url;
          item.appendChild(img);
        }
        const nameSpan = document.createElement('span');
        nameSpan.textContent = a.name + ' (' + formatFileSize(a.size) + ')';
        item.appendChild(nameSpan);
        const removeBtn = document.createElement('span');
        removeBtn.className = 'attach-remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = () => { attachments.splice(i, 1); renderAttachPreview(); };
        item.appendChild(removeBtn);
        attachPreview.appendChild(item);
      });
    };
    const formatFileSize = (bytes) => {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(1) + ' MB';
    };
    const buildMessage = (text) => {
      let msg = text;
      const sentImages = [];
      if (attachments.length > 0) {
        const parts = attachments.map((a) => {
          if (a.url && a.type && a.type.startsWith('image/')) {
            sentImages.push(a.url);
            return '\\n[图片:' + a.name + '](' + a.url + ')';
          }
          if (a.text !== null) return '\\n[附件:' + a.name + ']\\n' + String(a.text).slice(0, 8000);
          if (a.url) return '\\n[文件:' + a.name + '](' + a.url + ')';
          return '\\n[文件:' + a.name + ']';
        });
        msg += parts.join('');
        attachments.length = 0;
        renderAttachPreview();
      }
      return { msg, sentImages };
    };
    const abortCurrentRun = async () => {
      if (!currentRunId) return;
      try {
        await req('agent.abort', { runId: currentRunId });
      } catch {}
      sending = false;
      sendBtn.textContent = '发送';
      sendBtn.classList.remove('is-abort');
      sendStatus.textContent = '已中断';
    };
    const sendMessage = async () => {
      if (sending) {
        await abortCurrentRun();
        return;
      }
      const sessionKey = document.getElementById('session').value || 'main';
      const rawText = input.value.trim();
      if (!rawText && attachments.length === 0) return;
      const { msg: message, sentImages } = buildMessage(rawText);
      try {
        sending = true;
        sendStatus.textContent = '发送中...';
        sendBtn.textContent = '暂停';
        sendBtn.classList.add('is-abort');
        appendBubble('user', rawText, Math.max(1, Math.ceil(rawText.length / 4)), sentImages);
        input.value = '';
        currentRunId = null;
        currentAssistantBubble = appendBubble('assistant', '思考中...');
        const res = await req('agent.run', { sessionKey, message });
        if (!res.ok && res.error) {
          currentAssistantBubble.content.textContent = 'Agent 执行失败: ' + (res.error.message || JSON.stringify(res.error));
        } else if (res.payload && res.payload.output) {
          const oldText = (currentAssistantBubble.content.textContent || '').trim();
          if (!oldText || oldText === '思考中...') {
            currentAssistantBubble.content.textContent = String(res.payload.output || '');
          }
          const t = Number(res.payload.tokens || 0);
          if (t > 0) currentAssistantBubble.meta.textContent = '约 ' + t + ' tokens';
          if (res.payload.runId) currentRunId = res.payload.runId;
        }
      } catch (e) {
        appendBubble('assistant', e instanceof Error ? e.message : String(e));
      } finally {
        sending = false;
        sendBtn.textContent = '发送';
        sendBtn.classList.remove('is-abort');
        sendStatus.textContent = '空闲';
      }
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type:'connect', auth:{ token }, client:'bunclaw-ui' }));
      sendBtn.disabled = false;
      appendBubble('assistant', '已连接网关');
    };
    ws.onclose = () => {
      sendBtn.disabled = true;
      appendBubble('assistant', '连接已断开，请刷新页面后重试');
    };
    ws.onerror = () => {
      sendBtn.disabled = true;
      appendBubble('assistant', '连接异常，请检查网关状态');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'res' && msg.id === 'connect') {
        loadHistory();
        loadSkills();
        loadTools();
        checkModelAvailable();
        return;
      }
      if (msg.type === 'res' && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.type === 'event' && msg.event === 'agent.delta') {
        if (!currentAssistantBubble) currentAssistantBubble = appendBubble('assistant', '');
        if (!currentRunId) currentRunId = msg.payload && msg.payload.runId ? msg.payload.runId : null;
        if (!currentRunId || msg.payload.runId === currentRunId) {
          sendStatus.textContent = '生成回复中...';
          if (currentAssistantBubble.content.textContent === '思考中...') currentAssistantBubble.content.textContent = '';
          currentAssistantBubble.content.textContent += msg.payload.text || '';
          thread.scrollTop = thread.scrollHeight;
        }
      }
      if (msg.type === 'event' && msg.event === 'agent.final' && currentAssistantBubble) {
        const runId = msg.payload && msg.payload.runId ? msg.payload.runId : null;
        if (!currentRunId && runId) currentRunId = runId;
        if (currentRunId && runId && runId !== currentRunId) return;
        const text = String(msg.payload && msg.payload.text ? msg.payload.text : '').trim();
        const oldText = String(currentAssistantBubble.content.textContent || '').trim();
        if (text && (!oldText || oldText === '思考中...')) {
          currentAssistantBubble.content.textContent = text;
        }
        const t = Number(msg.payload && msg.payload.tokens ? msg.payload.tokens : 0);
        if (t > 0) currentAssistantBubble.meta.textContent = '约 ' + t + ' tokens';
        sendStatus.textContent = '已完成';
        sending = false;
        sendBtn.textContent = '发送';
        sendBtn.classList.remove('is-abort');
      }
    };
    sendBtn.onclick = sendMessage;
    skillSuggest.onclick = (ev) => {
      const el = ev.target && ev.target.closest ? ev.target.closest('.skill-item') : null;
      if (!el) return;
      const idx = Number(el.getAttribute('data-i') || -1);
      if (idx >= 0) applySkillByIndex(idx);
    };
    input.addEventListener('input', () => {
      suggestIndex = 0;
      renderSkillSuggest();
    });
    input.addEventListener('keydown', (ev) => {
      if (skillSuggest.classList.contains('active')) {
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          if (suggestItems.length > 0) {
            suggestIndex = (suggestIndex + 1 + suggestItems.length) % suggestItems.length;
            renderSkillSuggest();
          }
          return;
        }
        if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          if (suggestItems.length > 0) {
            suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
            renderSkillSuggest();
          }
          return;
        }
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          if (suggestIndex >= 0 && suggestItems.length > 0) {
            applySkillByIndex(suggestIndex);
            return;
          }
        }
      }
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
        <a id="menu-skills" href="/skills">技能管理</a>
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
          <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
            <h3 class="section-title" style="margin:0;">系统/事件日志</h3>
            <input id="logDate" type="date" style="width:auto; margin:0; padding:6px 10px; border-radius:8px; background:rgba(255,255,255,.08); color:var(--ink); border:1px solid var(--line); font-size:13px;" />
            <button id="logLoad" style="width:auto; margin:0; padding:6px 14px; border-radius:8px; font-size:13px;">加载</button>
            <button id="logToday" class="btn-secondary" style="width:auto; margin:0; padding:6px 14px; border-radius:8px; font-size:13px;">今天</button>
          </div>
          <pre id="eventLog" class="log-box"></pre>
        </div>
      </div>
      </div>
    </div>
  </div>
  <script>
    const eventLog = document.getElementById('eventLog');
    const themeToggle = document.getElementById('themeToggle');
    const logDate = document.getElementById('logDate');
    const logLoad = document.getElementById('logLoad');
    const logToday = document.getElementById('logToday');
    const todayStr = new Date().toISOString().slice(0, 10);
    logDate.value = todayStr;
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
    const normalizeEvent = (msg) => msg;
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
    const loadHistory = async (date) => {
      const params = { limit: 200 };
      if (date) params.date = date;
      const res = await req('logs.list', params);
      if (!res.ok || !Array.isArray(res.payload)) return;
      const label = date || new Date().toISOString().slice(0, 10);
      print('\\n\\u2500\\u2500 ' + label + ' \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500');
      for (const item of res.payload) print(normalizeEvent(item));
      print('\\u5df2\\u52a0\\u8f7d ' + label + ' \\u65e5\\u5fd7\\uff0c\\u5171 ' + String(res.payload.length) + ' \\u6761');
    };
    logLoad.onclick = () => {
      const d = logDate.value;
      loadHistory(d).catch((e) => print('加载日志失败：' + String(e && e.message ? e.message : e)));
    };
    logToday.onclick = () => {
      const today = new Date().toISOString().slice(0, 10);
      logDate.value = today;
      loadHistory(today).catch((e) => print('加载日志失败：' + String(e && e.message ? e.message : e)));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type:'connect', auth:{ token }, client:'bunclaw-logs' }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'res' && msg.id === 'connect') {
        print('已连接日志流');
        loadHistory('').catch((e) => print('加载历史日志失败：' + String(e && e.message ? e.message : e)));
        return;
      }
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

function renderSkillsPage(host: string, port: number, token: string, brandName: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brandName} 技能管理</title>
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
        <a id="menu-stats" href="/stats">统计</a>
        <a id="menu-skills" class="active" href="/skills">技能管理</a>
      </nav>
      <div class="endpoint-wrap">
        <button id="themeToggle" class="theme-btn">浅色主题</button>
        <div id="header-endpoint" class="endpoint">网关：ws://${host}:${port}/ws</div>
      </div>
    </div>
    <div class="wrap">
      <div class="card">
        <h2 class="section-title">技能管理</h2>
        <div class="hint">技能文件位置：<code>.bunclaw/skills</code>，聊天可用 <code>@技能名</code> 或 <code>/技能名</code> 调用。</div>
        <div class="chat-input-wrap">
          <button id="skillRefresh" class="chat-action btn-secondary">刷新</button>
        </div>
        <div class="chat-input-wrap" style="margin-top:8px;">
          <input id="skillFilter" placeholder="筛选技能..." />
          <div class="send-status"></div>
        </div>
        <div class="hint" id="skillCount">技能列表：0</div>
        <div class="hint" id="skillSelected">当前技能：-</div>
        <pre id="skillList" class="log-box"></pre>
        <textarea id="skillContent" class="raw-config" spellcheck="false" placeholder="# 技能说明" readonly></textarea>
        <pre id="skillLog"></pre>
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
    document.getElementById('header-endpoint').textContent = '网关：' + wsUrl;

    const ws = new WebSocket(wsUrl);
    const token = ${JSON.stringify(token)};
    const pending = new Map();
    const skillFilter = document.getElementById('skillFilter');
    const skillList = document.getElementById('skillList');
    const skillContent = document.getElementById('skillContent');
    const skillLog = document.getElementById('skillLog');
    const skillCount = document.getElementById('skillCount');
    const skillSelected = document.getElementById('skillSelected');
    let allSkills = [];

    const print = (txt) => {
      skillLog.textContent += '[' + new Date().toLocaleTimeString() + '] ' + txt + '\\n';
      skillLog.scrollTop = skillLog.scrollHeight;
    };
    const req = (method, params) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type:'req', id, method, params }));
    });
    const renderList = () => {
      const kw = String(skillFilter.value || '').toLowerCase();
      const rows = allSkills.filter((s) => !kw || String(s.name || '').toLowerCase().includes(kw));
      skillCount.textContent = '技能列表：' + rows.length;
      skillList.textContent = rows.map((s) => '- ' + s.name + ' (' + (s.bytes || 0) + ' B)').join('\\n') || '（暂无技能）';
    };
    const loadSkills = async () => {
      const res = await req('skill.list', {});
      if (!res.ok) throw new Error(res.error?.message || '读取技能列表失败');
      allSkills = Array.isArray(res.payload) ? res.payload : [];
      renderList();
    };
    const loadSkill = async (name) => {
      const n = String(name || '').trim();
      if (!n) return;
      const res = await req('skill.get', { name: n });
      if (!res.ok) throw new Error(res.error?.message || '读取技能失败');
      const selectedName = res.payload.name || n;
      skillContent.value = res.payload.content || '';
      skillSelected.textContent = '当前技能：' + selectedName;
      print('已加载技能：' + selectedName);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type:'connect', auth:{ token }, client:'bunclaw-skills' }));
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'res' && msg.id === 'connect') {
        try { await loadSkills(); } catch (e) { print(String(e.message || e)); }
        return;
      }
      if (msg.type === 'res' && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = () => print('连接异常');

    skillFilter.oninput = () => renderList();
    skillList.ondblclick = async () => {
      const line = window.getSelection ? String(window.getSelection()) : '';
      const m = line.match(/-\\s+([a-zA-Z0-9._\\-\\u4e00-\\u9fa5]+)/);
      if (!m) return;
      try { await loadSkill(m[1]); } catch (e) { print(String(e.message || e)); }
    };
    document.getElementById('skillRefresh').onclick = async () => { try { await loadSkills(); } catch (e) { print(String(e.message || e)); } };
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
        <a id="menu-skills" href="/skills">技能管理</a>
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
        <div style="margin-top:16px; padding:14px; border:1px solid var(--danger); border-radius:12px; background:rgba(249,115,115,.06);">
          <h3 class="section-title" style="color:var(--danger);">危险操作</h3>
          <div class="hint">以下操作不可恢复，请谨慎使用。</div>
          <div class="chat-input-wrap" style="margin-top:8px;">
            <button id="clearAllBtn" class="chat-action btn-danger" style="width:auto;">清除所有聊天消息</button>
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
    document.getElementById('cfgSave').onclick = async () => { try { await saveConfig(); } catch (e) { print('JSON 格式错误：' + String(e.message || e)); } };
    document.getElementById('clearAllBtn').onclick = async () => {
      if (!confirm('确定要清除所有聊天消息吗？此操作不可恢复。')) return;
      try {
        const res = await req('chat.clear', {});
        if (!res.ok) throw new Error((res.error && res.error.message) || '清理失败');
        print('已清除所有聊天消息');
      } catch (e) {
        print('清除失败：' + String(e.message || e));
      }
    };
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
        <a id="menu-skills" href="/skills">技能管理</a>
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
    const keyLabel = {
      platform: '平台',
      arch: '架构',
      bunVersion: 'Bun 版本',
      pid: '进程 PID',
      host: '网关 Host',
      port: '网关 Port',
      allowExternal: '允许外网',
      model: '模型',
      baseUrl: '模型地址',
      memoryRss: '内存 RSS',
      memoryHeapUsed: '堆内存',
      dbBytes: '数据库大小',
      eventsBytes: '事件日志大小',
    };
    const formatBytes = (n) => {
      const v = Number(n || 0);
      if (!Number.isFinite(v) || v <= 0) return '0 B';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      let x = v;
      while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
      return (x >= 10 || i === 0 ? x.toFixed(0) : x.toFixed(1)) + ' ' + u[i];
    };
    const formatUptime = (sec) => {
      let s = Number(sec || 0);
      if (!Number.isFinite(s) || s < 0) s = 0;
      const d = Math.floor(s / 86400); s %= 86400;
      const h = Math.floor(s / 3600); s %= 3600;
      const m = Math.floor(s / 60); s %= 60;
      const parts = [];
      if (d) parts.push(d + '天');
      if (h) parts.push(h + '小时');
      if (m) parts.push(m + '分');
      parts.push(Math.floor(s) + '秒');
      return parts.join(' ');
    };
    const formatSystemValue = (k, v) => {
      if (k === 'memoryRss' || k === 'memoryHeapUsed' || k === 'dbBytes' || k === 'eventsBytes') return formatBytes(v);
      if (k === 'allowExternal') return v ? '是' : '否';
      return String(v ?? '');
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
    const loadStats = async () => {
      const res = await req('stats.usage', {});
      if (!res.ok) throw new Error(res.error?.message || '获取统计失败');
      const s = res.payload || {};
      document.getElementById('statsSessions').textContent = String(s.sessions ?? 0);
      document.getElementById('statsMessages').textContent = String(s.messages ?? 0);
      document.getElementById('statsTokens').textContent = String(s.totalTokens ?? 0);
      document.getElementById('statsEvents').textContent = String(s.events ?? 0);
      document.getElementById('statsUptime').textContent = formatUptime(s.uptimeSec ?? 0);
      const sys = s.system || {};
      const keys = Object.keys(sys);
      systemBox.innerHTML = keys.map((k) => '<div class="sys-item"><div class="k">' + (keyLabel[k] || k) + '</div><div class="v">' + formatSystemValue(k, sys[k]) + '</div></div>').join('');
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

