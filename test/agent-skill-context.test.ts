import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent";
import { DatabaseStore } from "../src/db";
import { EventLog } from "../src/event-log";
import { ProcessManager } from "../src/process-manager";
import type { Config } from "../src/types";

const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const modelPort = 27000 + Math.floor(Math.random() * 1000);
const dbPath = `temp/.tmp-agent-skill-${id}.db`;
const eventsPath = `temp/.tmp-agent-skill-${id}.jsonl`;
const skillsDir = `temp/.tmp-skills-${id}`;

let mockModel: ReturnType<typeof Bun.serve>;
let observedMessages: Array<{ role: string; content: string }> = [];

const config: Config = {
  gateway: { host: "127.0.0.1", port: 16789, token: "", allowExternal: false },
  model: {
    baseUrl: `http://127.0.0.1:${modelPort}/v1`,
    apiKey: "test-key",
    model: "fake-model",
    maxToolRounds: 1,
  },
  tools: { profile: "coding", allow: [], deny: [] },
  sessions: { dbPath, eventsPath, workspace: process.cwd() },
  security: { workspaceOnly: true },
  ui: { brandName: "BunClaw" },
  storage: {
    baseDir: process.cwd(),
    skillsDir,
    agentsDir: process.cwd(),
    channelsDir: process.cwd(),
  },
};

describe("agent skill context", () => {
  beforeAll(async () => {
    await ensureDir(`${skillsDir}/writer`);
    await Bun.write(`${skillsDir}/writer/SKILL.md`, "你是写作助手，输出结构化小标题。\n");

    mockModel = Bun.serve({
      port: modelPort,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
        const body = (await req.json()) as { messages?: Array<{ role?: string; content?: string }> };
        observedMessages = (body.messages || []).map((m) => ({ role: String(m.role || ""), content: String(m.content || "") }));
        const done = [
          'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
          "data: [DONE]\n\n",
        ].join("");
        return new Response(done, { headers: { "content-type": "text/event-stream" } });
      },
    });
  });

  afterAll(async () => {
    mockModel?.stop(true);
    await Bun.file(dbPath).delete().catch(() => null);
    await Bun.file(eventsPath).delete().catch(() => null);
    await removeDir(skillsDir);
  });

  test("cleaned user message should be sent to model when using @skill", async () => {
    const db = new DatabaseStore(dbPath);
    const eventLog = new EventLog(eventsPath);
    const processManager = new ProcessManager();

    const result = await runAgent({
      config,
      db,
      eventLog,
      toolCtx: { workspace: config.sessions.workspace, processManager },
      sessionKey: "main",
      message: "@writer 写一段关于 bun 的介绍",
      onEvent: () => {},
    });

    expect(result.output).toContain("ok");

    const userMsg = observedMessages.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(String(userMsg?.content || "")).toContain("写一段关于 bun 的介绍");
    expect(String(userMsg?.content || "")).not.toContain("@writer");

    const systemMsg = observedMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeTruthy();
    expect(String(systemMsg?.content || "")).toContain("技能名称: writer");

    db.db.close();
  });
});

async function ensureDir(dir: string): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${dir}' -Force | Out-Null`]).exited.catch(() => null);
    return;
  }
  await Bun.spawn(["sh", "-lc", `mkdir -p '${dir}'`]).exited.catch(() => null);
}

async function removeDir(dir: string): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["powershell", "-NoProfile", "-Command", `Remove-Item -Path '${dir}' -Recurse -Force -ErrorAction SilentlyContinue`]).exited.catch(() => null);
    return;
  }
  await Bun.spawn(["rm", "-rf", dir]).exited.catch(() => null);
}
