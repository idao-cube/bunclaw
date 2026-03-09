import type { Config } from "./types";
import { writeTextIfChanged } from "./fs-utils";

export const DEFAULT_BASE_DIR = toPlatformPath(process.env.BUNCLAW_HOME || `${userHomeDir()}/.bunclaw`);
export const DEFAULT_CONFIG_PATH = toPlatformPath(process.env.BUNCLAW_CONFIG || `${DEFAULT_BASE_DIR}/bunclaw.json`);

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
      webSearch: { providers: ["news", "media", "bing", "google", "duckduckgo", "baidu", "sogou", "so", "github"], categories: ["tech", "research", "media"], timeoutMs: 8000, customScript: "" },
    },
    sessions: {
      dbPath: toPlatformPath(`${DEFAULT_BASE_DIR}/bunclaw.db`),
      eventsPath: toPlatformPath(`${DEFAULT_BASE_DIR}/events.jsonl`),
      workspace: toPlatformPath(`${DEFAULT_BASE_DIR}/workspace`),
    },
    storage: {
      baseDir: DEFAULT_BASE_DIR,
      skillsDir: toPlatformPath(`${DEFAULT_BASE_DIR}/skills`),
      agentsDir: toPlatformPath(`${DEFAULT_BASE_DIR}/agents`),
      channelsDir: toPlatformPath(`${DEFAULT_BASE_DIR}/channels`),
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
  const parsedStorage = parsed.storage ?? ({} as NonNullable<Config["storage"]>);
  const merged: Config = {
    ...def,
    ...parsed,
    gateway: { ...def.gateway, ...parsed.gateway },
    model: { ...def.model, ...parsed.model },
    tools: { ...def.tools, ...parsed.tools },
    sessions: { ...def.sessions, ...parsed.sessions },
    storage: {
      baseDir: parsedStorage.baseDir || def.storage!.baseDir,
      skillsDir: parsedStorage.skillsDir || def.storage!.skillsDir,
      agentsDir: parsedStorage.agentsDir || def.storage!.agentsDir,
      channelsDir: parsedStorage.channelsDir || def.storage!.channelsDir,
    },
    security: { ...def.security, ...parsed.security },
    ui: { ...def.ui, ...parsed.ui },
  };
  if (!merged.sessions.workspace || merged.sessions.workspace.trim() === "" || merged.sessions.workspace === ".") {
    merged.sessions.workspace = def.sessions.workspace;
  }
  const normalized = normalizeConfigPaths(merged);
  normalized.sessions.workspace = normalizeWorkspacePath(normalized.sessions.workspace, def.sessions.workspace);
  return normalized;
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
  if (config.sessions?.workspace) await ensureDir(config.sessions.workspace);
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
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

function normalizeConfigPaths(cfg: Config): Config {
  cfg.sessions.dbPath = normalizePathInput(cfg.sessions.dbPath);
  cfg.sessions.eventsPath = normalizePathInput(cfg.sessions.eventsPath);
  cfg.sessions.workspace = normalizePathInput(cfg.sessions.workspace);
  if (cfg.storage) {
    cfg.storage.baseDir = normalizePathInput(cfg.storage.baseDir);
    cfg.storage.skillsDir = normalizePathInput(cfg.storage.skillsDir);
    cfg.storage.agentsDir = normalizePathInput(cfg.storage.agentsDir);
    cfg.storage.channelsDir = normalizePathInput(cfg.storage.channelsDir);
  }
  return cfg;
}

function normalizePathInput(input: string): string {
  if (!input || input.trim() === "") return input;
  let p = input.trim();
  const home = userHomeDir();
  if (p === "~") p = home;
  if (p.startsWith("~/") || p.startsWith("~\\")) p = `${home}${p.slice(1)}`;

  const isWinAbs = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
  const isUnixAbs = p.startsWith("/");
  if (!isWinAbs && !isUnixAbs) {
    p = joinPath(process.cwd(), p);
  }
  return toPlatformPath(p);
}

function joinPath(a: string, b: string): string {
  if (a.endsWith("/") || a.endsWith("\\")) return `${a}${b}`;
  return `${a}/${b}`;
}

function toPlatformPath(p: string): string {
  if (process.platform === "win32") return p.replaceAll("/", "\\");
  return p.replaceAll("\\", "/");
}

function normalizeWorkspacePath(current: string, fallback: string): string {
  const ws = toPlatformPath(current || "");
  const fb = toPlatformPath(fallback || "");
  if (!ws.trim()) return fb;

  const legacyPrefix = toPlatformPath(`${process.cwd()}/.bunclaw`);
  const cwd = toPlatformPath(process.cwd());
  const homeBase = toPlatformPath(`${userHomeDir()}/.bunclaw`);
  const lowerWs = process.platform === "win32" ? ws.toLowerCase() : ws;
  const lowerLegacy = process.platform === "win32" ? legacyPrefix.toLowerCase() : legacyPrefix;
  const lowerCwd = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  const lowerHomeBase = process.platform === "win32" ? homeBase.toLowerCase() : homeBase;
  const legacyRel1 = process.platform === "win32" ? ".bunclaw\\workspace" : ".bunclaw/workspace";
  const legacyRel2 = process.platform === "win32" ? ".\\bunclaw\\workspace" : "./.bunclaw/workspace";
  const legacyRel3 = process.platform === "win32" ? ".\\" : "./";
  const legacyRel4 = process.platform === "win32" ? ".\\workspace" : "./workspace";

  if (lowerWs === legacyRel1 || lowerWs === legacyRel2 || lowerWs === legacyRel3 || lowerWs === legacyRel4) return fb;
  if (lowerWs.startsWith(lowerLegacy)) return fb;
  if (lowerWs === lowerCwd || lowerWs.startsWith(`${lowerCwd}${process.platform === "win32" ? "\\" : "/"}`)) {
    if (!lowerWs.startsWith(lowerHomeBase)) return fb;
  }
  return ws;
}

