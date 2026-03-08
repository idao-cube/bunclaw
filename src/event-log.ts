export class EventLog {
  constructor(private readonly filePath: string, private readonly workspace?: string) {}

  async append(entry: unknown): Promise<void> {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...((entry ?? {}) as object) })}\n`;
    await ensureParentDir(this.filePath);
    await Bun.write(this.filePath, line, { append: true });
    if (this.workspace) {
      const daily = dayLogFile(this.workspace);
      await ensureParentDir(daily);
      await Bun.write(daily, line, { append: true });
    }
  }
}

export function dayWorkspaceDir(workspace: string, now = new Date()): string {
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const base = workspace.replaceAll("\\", "/").replace(/\/$/, "");
  return `${base}/${y}/${m}/${d}`;
}

export function dayLogFile(workspace: string, now = new Date()): string {
  return `${dayWorkspaceDir(workspace, now)}/logs/events.jsonl`;
}

export function dayLogFileByDate(workspace: string, date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dayLogFile(workspace);
  const base = workspace.replaceAll("\\", "/").replace(/\/$/, "");
  return `${base}/${m[1]}/${m[2]}/${m[3]}/logs/events.jsonl`;
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
