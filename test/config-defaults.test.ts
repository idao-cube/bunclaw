import { describe, expect, test } from "bun:test";
import { DEFAULT_BASE_DIR, DEFAULT_CONFIG_PATH, defaultConfig } from "../src/config";

describe("默认目录", () => {
  test("默认配置应放在用户目录 ~/.bunclaw", () => {
    expect(DEFAULT_BASE_DIR.endsWith("/.bunclaw")).toBe(true);
    expect(DEFAULT_CONFIG_PATH.endsWith("/.bunclaw/bunclaw.json")).toBe(true);
  });

  test("默认数据库与事件文件应在 ~/.bunclaw 下", () => {
    const cfg = defaultConfig();
    expect(cfg.sessions.dbPath.endsWith("/.bunclaw/bunclaw.db")).toBe(true);
    expect(cfg.sessions.eventsPath.endsWith("/.bunclaw/events.jsonl")).toBe(true);
    expect(cfg.storage?.skillsDir.endsWith("/.bunclaw/skills")).toBe(true);
    expect(cfg.storage?.agentsDir.endsWith("/.bunclaw/agents")).toBe(true);
    expect(cfg.storage?.channelsDir.endsWith("/.bunclaw/channels")).toBe(true);
  });
});

