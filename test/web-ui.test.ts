import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startGateway } from "../src/gateway";

let gateway: ReturnType<typeof Bun.serve>;
const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const configPath = `.tmp-ui-${id}.json`;
const port = 24000 + Math.floor(Math.random() * 1000);

describe("web ui", () => {
  beforeAll(async () => {
    const cfg = {
      gateway: { host: "127.0.0.1", port, token: "" },
      model: { baseUrl: "http://127.0.0.1:25001/v1", apiKey: "x", model: "x", maxToolRounds: 1 },
      tools: { profile: "coding", allow: [], deny: [] },
      ui: { brandName: "BunClaw Pro" },
      sessions: { dbPath: `.tmp-ui-${id}.db`, eventsPath: `.tmp-ui-${id}.jsonl`, workspace: process.cwd() },
      security: { workspaceOnly: true },
    };
    await Bun.write(configPath, JSON.stringify(cfg, null, 2));
    gateway = await startGateway({ configPath });
  });

  afterAll(() => {
    gateway?.stop(true);
  });

  test("GET /chat returns chat page", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes("Chat")).toBe(true);
    expect(html.includes("BunClaw Pro")).toBe(true);
    expect(html.includes("chat-thread")).toBe(true);
    expect(html.includes("chat-input")).toBe(true);
    expect(html.includes("bubble")).toBe(true);
    expect(html.includes("clearAllBtn")).toBe(true);
    expect(html.includes("menu-config")).toBe(true);
    expect(html.includes("menu-stats")).toBe(true);
    expect(html.includes("header-endpoint")).toBe(true);
    expect(html.includes("liquid-bg")).toBe(true);
    expect(html.includes("location.host")).toBe(true);
    expect(html.includes("app-shell")).toBe(true);
    expect(html.includes("ws.readyState")).toBe(true);
    expect(html.includes("overflow:hidden")).toBe(true);
    expect(html.includes("--bg:#0f0f11")).toBe(true);
  });

  test("GET /logs returns logs page", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/logs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes("Logs")).toBe(true);
    expect(html.includes("BunClaw Pro")).toBe(true);
    expect(html.includes("eventLog")).toBe(true);
    expect(html.includes("chatLog")).toBe(false);
    expect(html.includes("session.history")).toBe(false);
    expect(html.includes("menu-config")).toBe(true);
    expect(html.includes("menu-stats")).toBe(true);
    expect(html.includes("header-endpoint")).toBe(true);
    expect(html.includes("liquid-bg")).toBe(true);
    expect(html.includes("location.host")).toBe(true);
    expect(html.includes("app-shell")).toBe(true);
    expect(html.includes("ws.readyState")).toBe(true);
    expect(html.includes("overflow:hidden")).toBe(true);
    expect(html.includes("--bg:#0f0f11")).toBe(true);
  });

  test("GET /config returns config page", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/config`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes("系统配置")).toBe(true);
    expect(html.includes("cfgRawText")).toBe(true);
    expect(html.includes("cfgFormSave")).toBe(true);
    expect(html.includes("cfgTabForm")).toBe(true);
    expect(html.includes("cfgTabRaw")).toBe(true);
    expect(html.includes("bunclaw_cfg_tab")).toBe(true);
    expect(html.includes("cfgHost")).toBe(true);
    expect(html.includes("system.config.file.get")).toBe(true);
    expect(html.includes("system.config.file.save")).toBe(true);
    expect(html.includes("system.config.update")).toBe(true);
    expect(html.includes("raw-config")).toBe(true);
  });

  test("GET /stats returns stats page", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes("使用统计")).toBe(true);
    expect(html.includes("stats.usage")).toBe(true);
    expect(html.includes("statsSessions")).toBe(true);
    expect(html.includes("statsSystem")).toBe(true);
    expect(html.includes("sys-grid")).toBe(true);
  });

  test("GET /skills returns skills page", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/skills`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes("技能管理")).toBe(true);
    expect(html.includes("skill.list")).toBe(true);
    expect(html.includes("skill.save")).toBe(true);
    expect(html.includes("skill.delete")).toBe(true);
    expect(html.includes("skillContent")).toBe(true);
    expect(html.includes("menu-skills")).toBe(true);
  });
});


