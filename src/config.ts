import type { Config } from "./types";
import { writeTextIfChanged } from "./fs-utils";

export const DEFAULT_BASE_DIR = process.env.BUNCLAW_HOME || `${userHomeDir()}/.bunclaw`;
export const DEFAULT_CONFIG_PATH = process.env.BUNCLAW_CONFIG || `${DEFAULT_BASE_DIR}/bunclaw.json`;

export function defaultConfig(): Config {
  return {
    gateway: { host: "127.0.0.1", port: 16789, token: "", allowExternal: false },
    model: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4.1-mini",
      maxToolRounds: 4,
    },
    tools: {
      profile: "coding",
      allow: [],
      deny: [],
      webSearch: { provider: "", endpoint: "", apiKey: "" },
    },
    sessions: {
      dbPath: `${DEFAULT_BASE_DIR}/bunclaw.db`,
      eventsPath: `${DEFAULT_BASE_DIR}/events.jsonl`,
      workspace: process.cwd(),
    },
    storage: {
      baseDir: DEFAULT_BASE_DIR,
      skillsDir: `${DEFAULT_BASE_DIR}/skills`,
      agentsDir: `${DEFAULT_BASE_DIR}/agents`,
      channelsDir: `${DEFAULT_BASE_DIR}/channels`,
    },
    security: { workspaceOnly: true },
    ui: { brandName: "BunClaw" },
  };
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<Config> {
  let actualPath = path;
  let file = Bun.file(actualPath);
  if (!(await file.exists()) && path === DEFAULT_CONFIG_PATH) {
    const legacyPath = `${process.cwd()}/bunclaw.json`;
    const legacy = Bun.file(legacyPath);
    if (await legacy.exists()) {
      actualPath = legacyPath;
      file = legacy;
    }
  }
  if (!(await file.exists())) return defaultConfig();
  const parsed = JSON.parse(await file.text()) as Config;
  const def = defaultConfig();
  return {
    ...def,
    ...parsed,
    gateway: { ...def.gateway, ...parsed.gateway },
    model: { ...def.model, ...parsed.model },
    tools: { ...def.tools, ...parsed.tools },
    sessions: { ...def.sessions, ...parsed.sessions },
    storage: { ...def.storage, ...(parsed.storage ?? {}) },
    security: { ...def.security, ...parsed.security },
    ui: { ...def.ui, ...parsed.ui },
  };
}

export async function saveConfig(config: Config, path = DEFAULT_CONFIG_PATH): Promise<void> {
  await ensureParentDir(path);
  await writeTextIfChanged(path, `${JSON.stringify(config, null, 2)}\n`);
}

export async function ensureDataDirs(config: Config): Promise<void> {
  if (config.storage?.baseDir) await ensureDir(config.storage.baseDir);
  if (config.storage?.skillsDir) await ensureDir(config.storage.skillsDir);
  if (config.storage?.agentsDir) await ensureDir(config.storage.agentsDir);
  if (config.storage?.channelsDir) await ensureDir(config.storage.channelsDir);
  await ensureParentDir(config.sessions.dbPath);
  await ensureParentDir(config.sessions.eventsPath);
  await ensureParentDir(DEFAULT_CONFIG_PATH);
}

async function ensureParentDir(filePath: string): Promise<void> {
  const normalized = filePath.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return;
  const dir = normalized.slice(0, idx);
  if (process.platform === "win32") {
    await Bun.spawn(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${dir}' -Force | Out-Null`]).exited;
    return;
  }
  await Bun.spawn(["sh", "-lc", `mkdir -p '${dir}'`]).exited;
}

async function ensureDir(dir: string): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${dir}' -Force | Out-Null`]).exited;
    return;
  }
  await Bun.spawn(["sh", "-lc", `mkdir -p '${dir}'`]).exited;
}

function userHomeDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return home.replaceAll("\\", "/");
}

