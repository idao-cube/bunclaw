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
  web_search: { type: "function", function: { name: "web_search", description: "调用配置的搜索接口", parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query"] } } },
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
  params.db.insertMessage(session.id, "user", params.message, {
    totalTokens: estimateTokens(params.message),
  });

  const allowed = resolveAllowedTools({
    profile: params.config.tools.profile,
    allow: params.config.tools.allow,
    deny: params.config.tools.deny,
  });

  const toolDefs = [...allowed].map((name) => TOOL_SCHEMAS[name]).filter(Boolean);
  const history = params.db.listMessages(session.id, 20);
  const messages: ModelMessage[] = history.map((m) => ({ role: m.role as ModelMessage["role"], content: m.content }));

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
      const output = allowed.has(name)
        ? await runTool(name, args, params.toolCtx)
        : { error: `工具已禁用: ${name}` };
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


