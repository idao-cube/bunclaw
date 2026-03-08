import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent";
import { DatabaseStore } from "../src/db";
import { EventLog } from "../src/event-log";
import { ProcessManager } from "../src/process-manager";
import { runTool } from "../src/tools/index";
import type { Config } from "../src/types";

const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const modelPort = 26000 + Math.floor(Math.random() * 1000);
const dbPath = `.tmp-agent-${id}.db`;
const eventsPath = `.tmp-agent-${id}.jsonl`;
let mockModel: ReturnType<typeof Bun.serve>;

const config: Config = {
  gateway: { host: "127.0.0.1", port: 16789, token: "", allowExternal: false },
  model: {
    baseUrl: `http://127.0.0.1:${modelPort}/v1`,
    apiKey: "test-key",
    model: "fake-model",
    maxToolRounds: 2,
  },
  tools: { profile: "coding", allow: ["read"], deny: [] },
  sessions: { dbPath, eventsPath, workspace: process.cwd() },
  security: { workspaceOnly: true },
  ui: { brandName: "BunClaw" },
  storage: {
    baseDir: process.cwd(),
    skillsDir: process.cwd(),
    agentsDir: process.cwd(),
    channelsDir: process.cwd(),
  },
};

describe("agent tool error isolation", () => {
  beforeAll(() => {
    mockModel = Bun.serve({
      port: modelPort,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
        const body = (await req.json()) as { messages?: Array<{ role?: string }> };
        const hasToolResult = (body.messages || []).some((m) => m.role === "tool");
        if (!hasToolResult) {
          const chunk = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\".\\"}"}}]}}]}\n\n`;
          return new Response(`${chunk}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        const done = [
          'data: {"choices":[{"delta":{"content":"已完成文件创建步骤"}}],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n',
          "data: [DONE]\n\n",
        ].join("");
        return new Response(done, { headers: { "content-type": "text/event-stream" } });
      },
    });
  });

  afterAll(async () => {
    mockModel?.stop(true);
    await Bun.file(dbPath).delete();
    await Bun.file(eventsPath).delete();
  });

  test("tool throws should not fail agent.run", async () => {
    const db = new DatabaseStore(dbPath);
    const eventLog = new EventLog(eventsPath);
    const processManager = new ProcessManager();
    const events: Array<{ event: string; payload: unknown }> = [];

    const result = await runAgent({
      config,
      db,
      eventLog,
      toolCtx: { workspace: config.sessions.workspace, processManager },
      sessionKey: "main",
      message: "创建一个文件 1.txt 内容为 111111",
      onEvent: (event, payload) => events.push({ event, payload }),
    });

    expect(result.output).toContain("已完成文件创建步骤");
    const toolEvent = events.find((e) => e.event === "agent.tool");
    expect(toolEvent).toBeTruthy();
    const errText = String((toolEvent?.payload as any)?.output?.error ?? "");
    expect(errText).toContain("路径是目录");
    db.db.close();
  });

  test("read directory returns friendly error", async () => {
    try {
      await runTool("read", { path: "." }, { workspace: process.cwd(), processManager: new ProcessManager() });
      throw new Error("should throw");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).toContain("路径是目录");
    }
  });
});
