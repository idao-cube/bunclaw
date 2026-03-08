type ProcInfo = {
  id: string;
  command: string;
  startedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
  output: string[];
  proc: ReturnType<typeof Bun.spawn>;
};

export class ProcessManager {
  private readonly procs = new Map<string, ProcInfo>();

  start(command: string): ProcInfo {
    const id = crypto.randomUUID();
    const proc = spawnShell(command);
    const info: ProcInfo = {
      id,
      command,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      output: [],
      proc,
    };
    this.procs.set(id, info);
    this.captureOutput(info);
    return info;
  }

  private async captureOutput(info: ProcInfo): Promise<void> {
    const text = await new Response(info.proc.stdout).text();
    if (text) info.output.push(text);
    const err = await new Response(info.proc.stderr).text();
    if (err) info.output.push(err);
    const code = await info.proc.exited;
    info.status = "exited";
    info.exitCode = code;
  }

  list(): Array<Omit<ProcInfo, "proc">> {
    return [...this.procs.values()].map(({ proc: _proc, ...rest }) => rest);
  }

  poll(id: string): Omit<ProcInfo, "proc"> | null {
    const found = this.procs.get(id);
    if (!found) return null;
    const { proc: _proc, ...rest } = found;
    return rest;
  }

  kill(id: string): boolean {
    const found = this.procs.get(id);
    if (!found) return false;
    if (found.status === "running") found.proc.kill();
    return true;
  }
}

export function spawnShell(command: string): ReturnType<typeof Bun.spawn> {
  if (process.platform === "win32") {
    return Bun.spawn(["powershell", "-NoProfile", "-Command", command], { stdout: "pipe", stderr: "pipe" });
  }
  return Bun.spawn(["sh", "-lc", command], { stdout: "pipe", stderr: "pipe" });
}

