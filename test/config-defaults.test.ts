import { describe, expect, test } from "bun:test";
import { DEFAULT_BASE_DIR, DEFAULT_CONFIG_PATH, defaultConfig, ensureDataDirs, loadConfig } from "../src/config";

describe("默认目录", () => {
  test("默认配置应放在用户目录 ~/.bunclaw", () => {
    const sep = process.platform === "win32" ? "\\" : "/";
    expect(DEFAULT_BASE_DIR.endsWith(`${sep}.bunclaw`)).toBe(true);
    expect(DEFAULT_CONFIG_PATH.endsWith(`${sep}.bunclaw${sep}bunclaw.json`)).toBe(true);
  });

  test("默认数据库与事件文件应在 ~/.bunclaw 下", () => {
    const cfg = defaultConfig();
    const sep = process.platform === "win32" ? "\\" : "/";
    expect(cfg.sessions.dbPath.endsWith(`${sep}.bunclaw${sep}bunclaw.db`)).toBe(true);
    expect(cfg.sessions.eventsPath.endsWith(`${sep}.bunclaw${sep}events.jsonl`)).toBe(true);
    expect(cfg.sessions.workspace.endsWith(`${sep}.bunclaw${sep}workspace`)).toBe(true);
    expect(cfg.storage?.skillsDir.endsWith(`${sep}.bunclaw${sep}skills`)).toBe(true);
    expect(cfg.storage?.agentsDir.endsWith(`${sep}.bunclaw${sep}agents`)).toBe(true);
    expect(cfg.storage?.channelsDir.endsWith(`${sep}.bunclaw${sep}channels`)).toBe(true);
  });

  test("ensureDataDirs 应创建 workspace 目录", async () => {
    const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const cfg = defaultConfig();
    const sep = process.platform === "win32" ? "\\" : "/";
    const base = `${process.cwd()}${sep}.tmp-workspace-${id}`;
    cfg.sessions.workspace = base;
    cfg.sessions.dbPath = `${base}${sep}bunclaw.db`;
    cfg.sessions.eventsPath = `${base}${sep}events.jsonl`;
    cfg.storage = {
      baseDir: base,
      skillsDir: `${base}${sep}skills`,
      agentsDir: `${base}${sep}agents`,
      channelsDir: `${base}${sep}channels`,
    };

    await ensureDataDirs(cfg);
    const stat = await Bun.file(cfg.sessions.workspace).stat();
    expect(stat.isDirectory()).toBe(true);
  });

  test("旧配置中的仓库内 .bunclaw/workspace 应自动迁移到用户目录", async () => {
    const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const p = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"} .tmp-cfg-${id}.json`.replace(" ", "");
    const cfg = defaultConfig();
    cfg.sessions.workspace = ".bunclaw/workspace";
    await Bun.write(p, `${JSON.stringify(cfg, null, 2)}\n`);
    const loaded = await loadConfig(p);
    const sep = process.platform === "win32" ? "\\" : "/";
    expect(loaded.sessions.workspace.endsWith(`${sep}.bunclaw${sep}workspace`)).toBe(true);
    expect(loaded.sessions.workspace.includes(`${sep}.tmp-cfg-`)).toBe(false);
  });

  test("旧配置中的仓库绝对 workspace 应自动迁移到用户目录", async () => {
    const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const sep = process.platform === "win32" ? "\\" : "/";
    const p = `${process.cwd()}${sep}.tmp-cfg-${id}-2.json`;
    const cfg = defaultConfig();
    cfg.sessions.workspace = `${process.cwd()}${sep}workspace`;
    await Bun.write(p, `${JSON.stringify(cfg, null, 2)}\n`);
    const loaded = await loadConfig(p);
    expect(loaded.sessions.workspace.endsWith(`${sep}.bunclaw${sep}workspace`)).toBe(true);
    expect(loaded.sessions.workspace.includes(`${sep}workspace`)).toBe(true);
    expect(loaded.sessions.workspace.startsWith(process.cwd())).toBe(false);
  });
});
