import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startGateway } from "../src/gateway";
import { callGateway } from "../src/client";

let mockModel: ReturnType<typeof Bun.serve>;
let gateway: ReturnType<typeof Bun.serve>;
const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const configPath = `temp/.tmp-gateway-${id}.json`;
const modelPort = 22000 + Math.floor(Math.random() * 1000);
const gatewayPort = modelPort + 1000;

describe("gateway integration", () => {
  beforeAll(async () => {
    await Bun.write(
      configPath,
      JSON.stringify(
        {
          gateway: { host: "127.0.0.1", port: gatewayPort, token: "t1" },
          model: {
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
            apiKey: "test-key",
            model: "fake-model",
            maxToolRounds: 1,
          },
          tools: { profile: "coding", allow: [], deny: [] },
          sessions: {
            dbPath: `temp/.tmp-gateway-${id}.db`,
            eventsPath: `temp/.tmp-gateway-${id}.jsonl`,
            workspace: process.cwd(),
          },
          storage: {
            baseDir: process.cwd(),
            skillsDir: `temp/.tmp-skills-${id}`,
            agentsDir: `temp/.tmp-agents-${id}`,
            channelsDir: `temp/.tmp-channels-${id}`,
          },
          security: { workspaceOnly: true },
          ui: { brandName: "BunClaw" },
        },
        null,
        2,
      ),
    );

    mockModel = Bun.serve({
      port: modelPort,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
          const body = ['data: {"choices":[{"delta":{"content":"mock reply"}}]}\n\n', "data: [DONE]\n\n"].join("");
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        if (url.pathname === "/v1/models") {
          return Response.json({ data: [{ id: "fake-model" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });

    gateway = await startGateway({ configPath });
    const health = await fetch(`http://127.0.0.1:${gatewayPort}/health`);
    expect(health.ok).toBe(true);
  });

  afterAll(() => {
    gateway?.stop(true);
    mockModel?.stop(true);
  });

  test("message.send idempotency returns same payload", async () => {
    const first = await callGateway("message.send", { sessionKey: "main", message: "hi" }, { idemKey: "abc", configPath });
    const second = await callGateway("message.send", { sessionKey: "main", message: "hi again" }, { idemKey: "abc", configPath });
    expect(first.response.ok).toBe(true);
    expect(second.response.ok).toBe(true);
    expect((first.response.payload as any).messageId).toBe((second.response.payload as any).messageId);
  });

  test("agent.run streams and returns final payload", async () => {
    const result = await callGateway("agent.run", { sessionKey: "main", message: "say hi" }, { idemKey: "run1", watchEvents: true, configPath });
    expect(result.response.ok).toBe(true);
    const payload = result.response.payload as any;
    expect(payload.output).toContain("mock reply");
    expect(result.events.some((e) => e.event === "agent.delta")).toBe(true);
  });

  test("session.history returns chat messages", async () => {
    const history = await callGateway("session.history", { sessionKey: "main", limit: 20 }, { configPath });
    expect(history.response.ok).toBe(true);
    const items = history.response.payload as any[];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length > 0).toBe(true);
    expect(items.some((m) => m.role === "assistant")).toBe(true);
  });

  test("system.config.get/update and stats.usage work", async () => {
    const get1 = await callGateway("system.config.get", {}, { configPath });
    expect(get1.response.ok).toBe(true);
    expect((get1.response.payload as any).ui.brandName).toBeTruthy();

    const update = await callGateway(
      "system.config.update",
      { patch: { ui: { brandName: "BunClaw 黑白版" }, model: { maxToolRounds: 3 } } },
      { configPath },
    );
    expect(update.response.ok).toBe(true);

    const get2 = await callGateway("system.config.get", {}, { configPath });
    expect(get2.response.ok).toBe(true);
    expect((get2.response.payload as any).ui.brandName).toBe("BunClaw 黑白版");
    expect((get2.response.payload as any).model.maxToolRounds).toBe(3);

    const stats = await callGateway("stats.usage", {}, { configPath });
    expect(stats.response.ok).toBe(true);
    expect(typeof (stats.response.payload as any).sessions).toBe("number");
    expect(typeof (stats.response.payload as any).messages).toBe("number");
    expect(typeof (stats.response.payload as any).events).toBe("number");
    expect(typeof (stats.response.payload as any).system?.platform).toBe("string");

    const rawGet = await callGateway("system.config.file.get", {}, { configPath });
    expect(rawGet.response.ok).toBe(true);
    expect(typeof (rawGet.response.payload as any).text).toBe("string");

    const rawSave = await callGateway("system.config.file.save", { text: (rawGet.response.payload as any).text }, { configPath });
    expect(rawSave.response.ok).toBe(true);
  });

  test("tools.list and skill CRUD work", async () => {
    const skillRoot = `temp/.tmp-skills-${id}`;
    if (process.platform === "win32") {
      await Bun.spawn(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${skillRoot}\\tech-article-generator' -Force | Out-Null`]).exited;
    } else {
      await Bun.spawn(["sh", "-lc", `mkdir -p '${skillRoot}/tech-article-generator'`]).exited;
    }
    await Bun.write(`${skillRoot}/tech-article-generator/SKILL.md`, "# tech article generator\n");

    const tools = await callGateway("tools.list", {}, { configPath });
    expect(tools.response.ok).toBe(true);
    const allowed = (tools.response.payload as any).allowed as string[];
    expect(Array.isArray(allowed)).toBe(true);
    expect(allowed.includes("exec")).toBe(true);

    const save = await callGateway("skill.save", { name: "netdiag", content: "# netdiag\n执行网络检查" }, { configPath });
    expect(save.response.ok).toBe(true);

    const list = await callGateway("skill.list", {}, { configPath });
    expect(list.response.ok).toBe(true);
    const names = ((list.response.payload as any[]) || []).map((x) => x.name);
    expect(names.includes("netdiag")).toBe(true);
    expect(names.includes("tech-article-generator")).toBe(true);

    const get = await callGateway("skill.get", { name: "netdiag" }, { configPath });
    expect(get.response.ok).toBe(true);
    expect(String((get.response.payload as any).content || "")).toContain("netdiag");

    const getDirSkill = await callGateway("skill.get", { name: "tech-article-generator" }, { configPath });
    expect(getDirSkill.response.ok).toBe(true);
    expect(String((getDirSkill.response.payload as any).content || "")).toContain("tech article generator");

    const del = await callGateway("skill.delete", { name: "netdiag" }, { configPath });
    expect(del.response.ok).toBe(true);
    expect((del.response.payload as any).ok).toBe(true);
  });
});


