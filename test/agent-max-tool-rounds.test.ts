import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent";
import { DatabaseStore } from "../src/db";
import { EventLog } from "../src/event-log";
import { ProcessManager } from "../src/process-manager";
import type { Config } from "../src/types";

const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const modelPort = 28000 + Math.floor(Math.random() * 1000);
const dbPath = `temp/.tmp-agent-rounds-${id}.db`;
const eventsPath = `temp/.tmp-agent-rounds-${id}.jsonl`;
let mockModel: ReturnType<typeof Bun.serve>;

const config: Config = {
  gateway: { host: "127.0.0.1", port: 16789, token: "", allowExternal: false },
  model: {
    baseUrl: `http://127.0.0.1:${modelPort}/v1`,
    apiKey: "test-key",
    model: "fake-model",
    maxToolRounds: 1,
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

describe("agent maxToolRounds", () => {
  beforeAll(() => {
    mockModel = Bun.serve({
      port: modelPort,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
        // 始终返回 tool_call，模拟模型持续请求工具。
        const chunk = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\".\\"}"}}]}}]}\n\n`;
        return new Response(`${chunk}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
  });

  afterAll(async () => {
    mockModel?.stop(true);
    await Bun.file(dbPath).delete().catch(() => null);
    await Bun.file(eventsPath).delete().catch(() => null);
  });

  test("should not execute tools more than configured rounds", async () => {
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
      message: "测试工具轮次限制",
      onEvent: (event, payload) => events.push({ event, payload }),
    });

    const toolEvents = events.filter((e) => e.event === "agent.tool");
    expect(toolEvents.length).toBe(1);
    expect(result.output).toContain("工具调用轮次上限");

    db.db.close();
  });
});
