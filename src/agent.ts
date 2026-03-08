import type { Config } from "./types";
import { DatabaseStore } from "./db";
import { EventLog } from "./event-log";
import { resolveAllowedTools } from "./tool-policy";
import { runTool, type ToolContext } from "./tools/index";
import { streamChatCompletion, type ModelMessage, type ToolDef } from "./model/openai";

const TOOL_SCHEMAS: Record<string, ToolDef> = {
  read: { type: "function", function: { name: "read", description: "读取工作目录文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  write: { type: "function", function: { name: "write", description: "写入文件", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  edit: { type: "function", function: { name: "edit", description: "替换文件文本", parameters: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"] } } },
  apply_patch: { type: "function", function: { name: "apply_patch", description: "覆盖文件内容", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  exec: { type: "function", function: { name: "exec", description: "执行命令", parameters: { type: "object", properties: { command: { type: "string" }, background: { type: "boolean" } }, required: ["command"] } } },
  process: { type: "function", function: { name: "process", description: "管理后台任务", parameters: { type: "object", properties: { action: { type: "string" }, sessionId: { type: "string" } }, required: ["action"] } } },
  web_search: { type: "function", function: { name: "web_search", description: "多引擎联网搜索（免 Key，失败源自动跳过）", parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "number" }, providers: { type: "array", items: { type: "string" } } }, required: ["query"] } } },
  web_fetch: { type: "function", function: { name: "web_fetch", description: "抓取网页文本", parameters: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] } } },
};

export async function runAgent(params: {
  config: Config;
  db: DatabaseStore;
  eventLog: EventLog;
  toolCtx: ToolContext;
  sessionKey: string;
  message: string;
  onEvent: (event: string, payload: unknown) => void;
}): Promise<{ runId: string; sessionId: string; output: string; tokens: number }> {
  const runId = crypto.randomUUID();
  const session = params.db.createSession(params.sessionKey);
  const skillCtx = await resolveSkillContext(params.message, params.config.storage?.skillsDir || "");
  params.db.insertMessage(session.id, "user", params.message, {
    totalTokens: estimateTokens(params.message),
  });
  if (skillCtx.skills.length > 0) {
    params.onEvent("agent.skill", { runId, skills: skillCtx.skills });
  }

  const allowed = resolveAllowedTools({
    profile: params.config.tools.profile,
    allow: params.config.tools.allow,
    deny: params.config.tools.deny,
  });
  const runtimeMessage = skillCtx.cleanedMessage || params.message;
  const forcedExecCommand = extractForcedExecCommand(runtimeMessage);
  const forcedFetchUrl = extractForcedWebFetchUrl(runtimeMessage);
  const preferWebResearch = shouldForceWebResearch(runtimeMessage);

  if (forcedExecCommand && allowed.has("exec")) {
    const output = await runForcedExec({
      runId,
      command: forcedExecCommand,
      toolCtx: params.toolCtx,
      onEvent: params.onEvent,
    });
    const tokens = estimateTokens(output);
    params.db.insertMessage(session.id, "assistant", output, {
      completionTokens: tokens,
      totalTokens: tokens,
    });
    await params.eventLog.append({ event: "agent.final", runId, sessionId: session.id, text: output });
    params.onEvent("agent.final", { runId, text: output, sessionId: session.id, tokens });
    return { runId, sessionId: session.id, output, tokens };
  }

  if (forcedFetchUrl && allowed.has("web_fetch")) {
    const output = await runForcedWebFetch({
      runId,
      url: forcedFetchUrl,
      toolCtx: params.toolCtx,
      onEvent: params.onEvent,
    });
    const tokens = estimateTokens(output);
    params.db.insertMessage(session.id, "assistant", output, {
      completionTokens: tokens,
      totalTokens: tokens,
    });
    await params.eventLog.append({ event: "agent.final", runId, sessionId: session.id, text: output });
    params.onEvent("agent.final", { runId, text: output, sessionId: session.id, tokens });
    return { runId, sessionId: session.id, output, tokens };
  }

  if (preferWebResearch && allowed.has("web_search")) {
    const output = await runForcedWebResearch({
      runId,
      query: runtimeMessage,
      toolCtx: params.toolCtx,
      onEvent: params.onEvent,
      canFetch: allowed.has("web_fetch"),
    });
    const tokens = estimateTokens(output);
    params.db.insertMessage(session.id, "assistant", output, {
      completionTokens: tokens,
      totalTokens: tokens,
    });
    await params.eventLog.append({ event: "agent.final", runId, sessionId: session.id, text: output });
    params.onEvent("agent.final", { runId, text: output, sessionId: session.id, tokens });
    return { runId, sessionId: session.id, output, tokens };
  }

  const toolDefs = [...allowed].map((name) => TOOL_SCHEMAS[name]).filter(Boolean);
  const history = params.db.listMessages(session.id, 20);
  const messages: ModelMessage[] = history.map((m) => ({ role: m.role as ModelMessage["role"], content: m.content }));
  if (skillCtx.systemPrompt) {
    messages.unshift({ role: "system", content: skillCtx.systemPrompt });
  }

  let final = "";
  let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (let round = 0; round <= params.config.model.maxToolRounds; round += 1) {
    const result = await streamChatCompletion({
      config: params.config,
      messages,
      tools: toolDefs,
      onDelta: (text) => {
        params.onEvent("agent.delta", { runId, text });
      },
    });
    finalUsage = result.usage;

    if (!result.toolCalls.length) {
      final = result.text;
      break;
    }

    messages.push({ role: "assistant", content: result.text || "" });
    for (const call of result.toolCalls) {
      const name = call.name;
      const args = safeJsonParse(call.arguments);
      let output: unknown;
      if (!allowed.has(name)) {
        output = { error: `工具已禁用: ${name}` };
      } else {
        try {
          output = await runTool(name, args, params.toolCtx);
        } catch (error) {
          output = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      params.onEvent("agent.tool", { runId, tool: name, args, output });
      messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(output) });
    }
  }

  if (!final) final = "（模型未返回文本）";
  const completion = Number(finalUsage.completionTokens || 0);
  const total = Number(finalUsage.totalTokens || 0);
  params.db.insertMessage(session.id, "assistant", final, {
    promptTokens: Number(finalUsage.promptTokens || 0),
    completionTokens: completion || estimateTokens(final),
    totalTokens: total || estimateTokens(final),
  });
  await params.eventLog.append({ event: "agent.final", runId, sessionId: session.id, text: final });
  params.onEvent("agent.final", { runId, text: final, sessionId: session.id, tokens: total || completion || 0 });
  return { runId, sessionId: session.id, output: final, tokens: total || completion || 0 };
}

async function resolveSkillContext(message: string, skillsDir: string): Promise<{ cleanedMessage: string; systemPrompt: string; skills: string[] }> {
  const refs = extractSkillRefs(message);
  if (refs.length === 0 || !skillsDir) return { cleanedMessage: message, systemPrompt: "", skills: [] };
  const blocks: string[] = [];
  const used: string[] = [];
  for (const name of refs) {
    const content = await readSkillFile(skillsDir, name);
    if (!content) continue;
    used.push(name);
    blocks.push(`技能名称: ${name}\n技能内容:\n${content}`);
  }
  const cleaned = stripSkillRefs(message).trim();
  if (blocks.length === 0) return { cleanedMessage: cleaned || message, systemPrompt: "", skills: [] };
  const systemPrompt = `你必须严格参考以下技能文件执行任务；当技能与用户请求冲突时，以用户请求为准。\n\n${blocks.join("\n\n---\n\n")}`;
  return { cleanedMessage: cleaned || message, systemPrompt, skills: used };
}

function extractSkillRefs(message: string): string[] {
  const out = new Set<string>();
  const atRefs = [...message.matchAll(/@([a-zA-Z0-9._\-\u4e00-\u9fa5]+)/g)].map((m) => m[1]);
  atRefs.forEach((x) => out.add(x));
  const slashStart = message.trim().match(/^\/([a-zA-Z0-9._\-\u4e00-\u9fa5]+)\b/);
  if (slashStart?.[1] && slashStart[1].toLowerCase() !== "skill") out.add(slashStart[1]);
  return [...out];
}

function stripSkillRefs(message: string): string {
  return message
    .replace(/@([a-zA-Z0-9._\-\u4e00-\u9fa5]+)/g, "")
    .replace(/^\/([a-zA-Z0-9._\-\u4e00-\u9fa5]+)\b/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function readSkillFile(skillsDir: string, name: string): Promise<string | null> {
  const safe = sanitizeSkillName(name);
  if (!safe) return null;
  const candidates = [
    joinPath(skillsDir, `${safe}/SKILL.md`),
    joinPath(skillsDir, `${safe}/skill.md`),
  ];
  for (const p of candidates) {
    const file = Bun.file(p);
    if (await file.exists()) return await file.text();
  }
  return null;
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

async function runForcedWebFetch(input: {
  runId: string;
  url: string;
  toolCtx: ToolContext;
  onEvent: (event: string, payload: unknown) => void;
}): Promise<string> {
  const args = { url: input.url, maxChars: 4000 };
  let output: any;
  try {
    output = await runTool("web_fetch", args, input.toolCtx);
  } catch (error) {
    output = { error: error instanceof Error ? error.message : String(error) };
  }
  input.onEvent("agent.tool", { runId: input.runId, tool: "web_fetch", args, output });
  if (output?.error) return `网页抓取失败\nURL: ${input.url}\n错误: ${String(output.error)}`;
  const content = String(output?.content || "").trim();
  return `网页抓取结果\nURL: ${input.url}\n状态: ${Number(output?.status ?? 0)}\n\n内容摘录:\n${content || "（无正文）"}`;
}

async function runForcedExec(input: {
  runId: string;
  command: string;
  toolCtx: ToolContext;
  onEvent: (event: string, payload: unknown) => void;
}): Promise<string> {
  const args = { command: input.command, background: false };
  let output: any;
  try {
    output = await runTool("exec", args, input.toolCtx);
  } catch (error) {
    output = { error: error instanceof Error ? error.message : String(error) };
  }
  input.onEvent("agent.tool", { runId: input.runId, tool: "exec", args, output });
  return formatExecOutput(input.command, output);
}

function formatExecOutput(command: string, output: any): string {
  if (output?.error) {
    return `命令执行失败\n命令: ${command}\n错误: ${String(output.error)}`;
  }
  const executed = String(output?.command || command);
  const adapted = output?.adaptedFrom ? `\n原始命令: ${String(output.adaptedFrom)}` : "";
  const exitCode = Number(output?.exitCode ?? -1);
  const stdout = String(output?.stdout ?? "").trim();
  const stderr = String(output?.stderr ?? "").trim();
  const lines: string[] = [];
  lines.push(`命令执行结果`);
  lines.push(`执行命令: ${executed}${adapted}`);
  lines.push(`退出码: ${exitCode}`);
  lines.push("");
  lines.push("STDOUT:");
  lines.push(stdout || "（无输出）");
  if (stderr) {
    lines.push("");
    lines.push("STDERR:");
    lines.push(stderr);
  }
  return lines.join("\n");
}

async function runForcedWebResearch(input: {
  runId: string;
  query: string;
  toolCtx: ToolContext;
  onEvent: (event: string, payload: unknown) => void;
  canFetch: boolean;
}): Promise<string> {
  const searchArgs = { query: input.query, count: 10, providers: ["news", "media", "bing", "google", "baidu", "github"] };
  let searchOutput: any;
  try {
    searchOutput = await runTool("web_search", searchArgs, input.toolCtx);
  } catch (error) {
    searchOutput = { error: error instanceof Error ? error.message : String(error) };
  }
  input.onEvent("agent.tool", { runId: input.runId, tool: "web_search", args: searchArgs, output: searchOutput });
  const results = Array.isArray(searchOutput?.results) ? searchOutput.results : [];
  const top = results.slice(0, 5);
  const details: Array<{ title: string; url: string; source: string; content: string }> = [];

  if (input.canFetch) {
    for (const item of top.slice(0, 3)) {
      const fetchArgs = { url: String(item.url || ""), maxChars: 1200 };
      if (!fetchArgs.url) continue;
      let fetchOutput: any;
      try {
        fetchOutput = await runTool("web_fetch", fetchArgs, input.toolCtx);
      } catch (error) {
        fetchOutput = { error: error instanceof Error ? error.message : String(error) };
      }
      input.onEvent("agent.tool", { runId: input.runId, tool: "web_fetch", args: fetchArgs, output: fetchOutput });
      details.push({
        title: String(item.title || "未命名"),
        url: fetchArgs.url,
        source: String(item.source || item.provider || "unknown"),
        content: String(fetchOutput?.content || fetchOutput?.error || "").slice(0, 220),
      });
    }
  }
  return formatResearchOutput(input.query, searchOutput, top, details);
}

function formatResearchOutput(query: string, searchOutput: any, top: any[], details: Array<{ title: string; url: string; source: string; content: string }>): string {
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`已按“联网搜索+抓取”模式执行（非模型臆测）。`);
  lines.push(`查询：${query}`);
  lines.push(`抓取时间：${now}`);
  lines.push("");
  const ok = Array.isArray(searchOutput?.providersSucceeded) ? searchOutput.providersSucceeded : [];
  const tried = Array.isArray(searchOutput?.providersTried) ? searchOutput.providersTried : [];
  const errs = Array.isArray(searchOutput?.errors) ? searchOutput.errors : [];
  lines.push(`搜索源：${ok.length > 0 ? ok.join(", ") : "无成功源"}（尝试：${tried.join(", ")}）`);
  if (errs.length > 0) lines.push(`失败源：${errs.map((e: any) => `${e.provider}:${String(e.message || "").slice(0, 60)}`).join(" | ")}`);
  lines.push("");
  if (top.length === 0) {
    lines.push("未检索到有效结果，请更换关键词后重试。");
    return lines.join("\n");
  }
  lines.push("检索结果：");
  top.forEach((r: any, i: number) => {
    lines.push(`${i + 1}. ${String(r.title || "未命名")} [${String(r.source || r.provider || "unknown")}]`);
    lines.push(`   ${String(r.url || "")}`);
    if (r.snippet) lines.push(`   ${String(r.snippet).slice(0, 140)}`);
  });
  if (details.length > 0) {
    lines.push("");
    lines.push("页面抓取摘要：");
    details.forEach((d, i) => {
      lines.push(`${i + 1}. ${d.title} [${d.source}]`);
      if (d.content) lines.push(`   ${d.content}`);
      lines.push(`   ${d.url}`);
    });
  }
  return lines.join("\n");
}

export function shouldForceWebResearch(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  if (extractSkillRefs(message).length > 0) return false;
  const explicitWebAction = /(联网搜索|互联网搜索|在线搜索|全网搜索|web search|search web|google一下|bing一下|百度一下|上网查|去网上查|网页抓取|抓取网页|爬取网页|crawl web)/i.test(text);
  if (explicitWebAction) return true;

  const hasTemporal = /(最新|最近|今日|今天|刚刚|实时|头条|热点|快讯|breaking|trending|news)/i.test(text);
  const hasDate = /(\d{4}年\d{1,2}月\d{1,2}日)|(\d{4}-\d{1,2}-\d{1,2})|(\d{1,2}月\d{1,2}日)/.test(text);
  const hasNewsTopic = /(消息|新闻|资讯|发布|公告|政策|价格|汇率|股价|比赛|比分|赛程|天气|票房|销量|排行|榜单|版本更新|release note)/i.test(text);
  if ((hasTemporal && hasNewsTopic) || (hasDate && hasNewsTopic)) return true;

  const localTask = /(本地|项目内|项目中|工程内|工程中|本项目|仓库|workspace|工作目录|代码|文件|目录|src|readme|日志|数据库|执行|run|命令|shell|终端|创建|修改|删除|重命名)/i.test(text);
  if (localTask) return false;

  // 保守默认：不强制联网，优先本地能力和模型工具决策
  return false;
}

export function extractForcedExecCommand(message: string): string | null {
  const text = message.trim();
  if (!text) return null;
  const m1 = text.match(/^执行\s+(.+?)(?:\s*(?:看|查看|看看)(?:结果|输出)?\s*)?$/i);
  if (m1 && m1[1]) return m1[1].trim();
  const m2 = text.match(/^run\s+(.+)$/i);
  if (m2 && m2[1]) return m2[1].trim();
  return null;
}

export function extractForcedWebFetchUrl(message: string): string | null {
  const text = message.trim();
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s)]+/i);
  if (!m) return null;
  const hasFetchIntent = /(抓取|获取|打开|读取|解析|fetch|crawl|爬取|网页)/i.test(text);
  if (!hasFetchIntent) return null;
  return m[0];
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // ignore
  }
  return {};
}

function estimateTokens(text: string): number {
  const chars = text.trim().length;
  if (!chars) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}


