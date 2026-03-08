import { ProcessManager, spawnShell } from "../process-manager";

export type ToolContext = {
  workspace: string;
  processManager: ProcessManager;
  webSearch?: { endpoint?: string; apiKey?: string };
};

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  if (name === "read") {
    const path = resolveInsideWorkspace(String(args.path ?? ""), ctx.workspace);
    return { path, content: await Bun.file(path).text() };
  }
  if (name === "write") {
    const path = resolveInsideWorkspace(String(args.path ?? ""), ctx.workspace);
    await Bun.write(path, String(args.content ?? ""));
    return { ok: true, path };
  }
  if (name === "edit") {
    const path = resolveInsideWorkspace(String(args.path ?? ""), ctx.workspace);
    const oldText = await Bun.file(path).text();
    const next = oldText.replaceAll(String(args.find ?? ""), String(args.replace ?? ""));
    await Bun.write(path, next);
    return { ok: true, path, changed: oldText !== next };
  }
  if (name === "apply_patch") {
    const path = resolveInsideWorkspace(String(args.path ?? ""), ctx.workspace);
    await Bun.write(path, String(args.content ?? ""));
    return { ok: true, path, mode: "replace" };
  }
  if (name === "exec") {
    const command = String(args.command ?? "");
    if (args.background === true) {
      const session = ctx.processManager.start(command);
      return { status: "running", sessionId: session.id };
    }
    const proc = spawnShell(command);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { status: "done", exitCode, stdout, stderr };
  }
  if (name === "process") {
    const action = String(args.action ?? "list");
    if (action === "list") return { items: ctx.processManager.list() };
    if (action === "poll") return { item: ctx.processManager.poll(String(args.sessionId ?? "")) };
    if (action === "kill") return { ok: ctx.processManager.kill(String(args.sessionId ?? "")) };
    return { error: "未知进程动作" };
  }
  if (name === "web_fetch") {
    const url = String(args.url ?? "");
    const res = await fetch(url);
    const text = await res.text();
    return { url, status: res.status, content: stripHtml(text).slice(0, Number(args.maxChars ?? 20000)) };
  }
  if (name === "web_search") {
    const endpoint = ctx.webSearch?.endpoint;
    if (!endpoint) return { error: "web_search 未配置（tools.webSearch.endpoint）" };
    const payload = { query: String(args.query ?? ""), count: Number(args.count ?? 5) };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ctx.webSearch?.apiKey ? { authorization: `Bearer ${ctx.webSearch.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    return await res.json();
  }
  throw new Error(`未知工具: ${name}`);
}

function resolveInsideWorkspace(raw: string, workspace: string): string {
  if (!raw) throw new Error("路径不能为空");
  const input = raw.replaceAll("\\", "/");
  if (input.includes("..")) throw new Error("路径不能越过工作目录");
  if (input.startsWith("/") || /^[A-Za-z]:\//.test(input)) throw new Error("不允许绝对路径");
  const base = workspace.replaceAll("\\", "/").replace(/\/$/, "");
  const full = `${base}/${input.replace(/^\.\//, "")}`;
  return full;
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}


