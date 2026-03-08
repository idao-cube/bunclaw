import type { Config } from "../types";

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
};

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export async function streamChatCompletion(params: {
  config: Config;
  messages: ModelMessage[];
  tools: ToolDef[];
  onDelta: (text: string) => void;
}): Promise<{
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const url = `${params.config.model.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.config.model.apiKey}`,
    },
    body: JSON.stringify({
      model: params.config.model.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: params.messages,
      tools: params.tools,
      tool_choice: "auto",
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`model request failed: ${res.status}`);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = "";
  let text = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const json = JSON.parse(payload) as any;
        const usage = json.usage;
        if (usage) {
          promptTokens = Number(usage.prompt_tokens ?? promptTokens);
          completionTokens = Number(usage.completion_tokens ?? completionTokens);
          totalTokens = Number(usage.total_tokens ?? totalTokens);
        }
        const delta = json.choices?.[0]?.delta;
        const deltaText = delta?.content;
        if (typeof deltaText === "string" && deltaText.length > 0) {
          text += deltaText;
          params.onDelta(deltaText);
        }
        const calls = delta?.tool_calls as Array<any> | undefined;
        if (calls) {
          for (const c of calls) {
            const idx = String(c.index ?? c.id ?? "0");
            const existing = toolCalls.get(idx) ?? { id: c.id ?? idx, name: "", arguments: "" };
            if (c.id) existing.id = c.id;
            if (c.function?.name) existing.name = c.function.name;
            if (c.function?.arguments) existing.arguments += c.function.arguments;
            toolCalls.set(idx, existing);
          }
        }
      }
    }
  }

  return { text, toolCalls: [...toolCalls.values()], usage: { promptTokens, completionTokens, totalTokens } };
}


