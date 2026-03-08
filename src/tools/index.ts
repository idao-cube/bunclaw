import { ProcessManager, spawnShell } from "../process-manager";

export type ToolContext = {
  workspace: string;
  processManager: ProcessManager;
  webSearch?: {
    provider?: string;
    providers?: string[];
    endpoint?: string;
    apiKey?: string;
    timeoutMs?: number;
  };
};

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  if (name === "read") {
    const raw = String(args.path ?? "");
    if (raw.trim() === "." || raw.trim() === "./" || raw.trim() === ".\\") {
      throw new Error(`路径是目录，不能按文件读取: ${dayWorkspaceRoot(ctx.workspace)}`);
    }
    const path = resolveInsideWorkspace(raw, ctx.workspace);
    await assertFileReadable(path, "读取");
    return { path, content: await Bun.file(path).text() };
  }
  if (name === "write") {
    const path = resolveInsideWorkspace(String(args.path ?? ""), ctx.workspace);
    await ensureParentDir(path);
    await Bun.write(path, String(args.content ?? ""));
    return { ok: true, path };
  }
  if (name === "edit") {
    const raw = String(args.path ?? "");
    if (raw.trim() === "." || raw.trim() === "./" || raw.trim() === ".\\") {
      throw new Error(`路径是目录，不能按文件编辑: ${dayWorkspaceRoot(ctx.workspace)}`);
    }
    const path = resolveInsideWorkspace(raw, ctx.workspace);
    await assertFileReadable(path, "编辑");
    const oldText = await Bun.file(path).text();
    const next = oldText.replaceAll(String(args.find ?? ""), String(args.replace ?? ""));
    await ensureParentDir(path);
    await Bun.write(path, next);
    return { ok: true, path, changed: oldText !== next };
  }
  if (name === "apply_patch") {
    const path = resolveInsideWorkspace(String(args.path ?? ""), ctx.workspace);
    await ensureParentDir(path);
    await Bun.write(path, String(args.content ?? ""));
    return { ok: true, path, mode: "replace" };
  }
  if (name === "exec") {
    const command = String(args.command ?? "").trim();
    if (!command) return { error: "command 不能为空" };
    const adapted = adaptCommandForPlatform(command, process.platform);
    if (args.background === true) {
      const session = ctx.processManager.start(adapted.command);
      return { status: "running", sessionId: session.id, command: adapted.command, adaptedFrom: adapted.adaptedFrom };
    }
    const proc = spawnShell(adapted.command);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { status: "done", exitCode, stdout, stderr, command: adapted.command, adaptedFrom: adapted.adaptedFrom };
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
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "query 不能为空" };
    const count = clampCount(args.count);
    const providers = normalizeProviders(args.providers, ctx.webSearch?.providers, ctx.webSearch?.provider);
    const timeoutMs = Number(ctx.webSearch?.timeoutMs ?? 8000);
    return await searchWebNoKey(query, count, providers, timeoutMs);
  }
  throw new Error(`未知工具: ${name}`);
}

function resolveInsideWorkspace(raw: string, workspace: string): string {
  if (!raw) throw new Error("路径不能为空");
  const input = raw.replaceAll("\\", "/");
  if (input.includes("..")) throw new Error("路径不能越过工作目录");
  if (input.startsWith("/") || /^[A-Za-z]:\//.test(input)) throw new Error("不允许绝对路径");
  const base = dayWorkspaceRoot(workspace).replaceAll("\\", "/").replace(/\/$/, "");
  const normalized = input.replace(/^\.\//, "");
  if (!normalized || normalized === ".") return base;
  const full = `${base}/${normalized}`;
  return full;
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function assertFileReadable(path: string, action: string): Promise<void> {
  const stat = await Bun.file(path).stat().catch(() => null);
  if (!stat) throw new Error(`文件不存在: ${path}`);
  if (stat.isDirectory()) throw new Error(`路径是目录，不能按文件${action}: ${path}`);
}

type SearchProvider = "bing" | "github" | "baidu" | "google" | "news" | "media";
type SearchItem = { title: string; url: string; snippet: string; source: string; provider: SearchProvider };
const DEFAULT_PROVIDERS: SearchProvider[] = ["news", "media", "bing", "google", "baidu", "github"];

export async function searchWebNoKey(
  query: string,
  count: number,
  providers: string[],
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<{
  query: string;
  count: number;
  providersTried: string[];
  providersSucceeded: string[];
  results: SearchItem[];
  errors: Array<{ provider: string; message: string }>;
}> {
  const picked = providers.map((p) => p.toLowerCase()).filter((p): p is SearchProvider => DEFAULT_PROVIDERS.includes(p as SearchProvider));
  const ordered = picked.length > 0 ? picked : DEFAULT_PROVIDERS;
  const errors: Array<{ provider: string; message: string }> = [];
  const success: string[] = [];
  const all: SearchItem[] = [];

  for (const provider of ordered) {
    try {
      let items: SearchItem[] = [];
      if (provider === "bing") items = await searchBing(query, count, timeoutMs, fetcher);
      else if (provider === "github") items = await searchGithub(query, count, timeoutMs, fetcher);
      else if (provider === "baidu") items = await searchBaidu(query, count, timeoutMs, fetcher);
      else if (provider === "google") items = await searchGoogle(query, count, timeoutMs, fetcher);
      else if (provider === "news") items = await searchNews(query, count, timeoutMs, fetcher);
      else if (provider === "media") items = await searchMedia(query, count, timeoutMs, fetcher);
      if (items.length > 0) {
        all.push(...items);
        success.push(provider);
      }
    } catch (error) {
      errors.push({ provider, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const results = dedupeByUrl(all).slice(0, count);
  return {
    query,
    count,
    providersTried: ordered,
    providersSucceeded: success,
    results,
    errors,
  };
}

function normalizeProviders(argsProviders: unknown, cfgProviders?: string[], cfgProvider?: string): string[] {
  if (Array.isArray(argsProviders)) return argsProviders.map((v) => String(v || "").trim()).filter(Boolean);
  if (Array.isArray(cfgProviders) && cfgProviders.length > 0) return cfgProviders;
  if (cfgProvider && cfgProvider.trim()) return [cfgProvider.trim()];
  return DEFAULT_PROVIDERS;
}

function clampCount(raw: unknown): number {
  const n = Number(raw ?? 8);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

async function searchBing(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}`;
  const html = await fetchText(url, timeoutMs, fetcher);
  return parseHtmlAnchors(html, "bing", "Bing", count);
}

async function searchGoogle(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${count}&hl=zh-CN`;
  const html = await fetchText(url, timeoutMs, fetcher);
  const rows = parseHtmlAnchors(html, "google", "Google", count * 2, true);
  return rows
    .map((item) => ({ ...item, url: normalizeGoogleUrl(item.url) }))
    .filter((item) => item.url.startsWith("http"))
    .slice(0, count);
}

async function searchBaidu(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${count}`;
  const html = await fetchText(url, timeoutMs, fetcher);
  return parseHtmlAnchors(html, "baidu", "Baidu", count);
}

async function searchGithub(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${count}`;
  const res = await fetchWithTimeout(url, timeoutMs, fetcher, {
    headers: { "user-agent": "bunclaw/1.0", accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub 搜索失败: ${res.status}`);
  const data = (await res.json()) as { items?: Array<{ html_url?: string; full_name?: string; description?: string }> };
  return (data.items ?? []).slice(0, count).map((repo) => ({
    title: repo.full_name || "GitHub Repository",
    url: String(repo.html_url || ""),
    snippet: String(repo.description || ""),
    source: "GitHub",
    provider: "github",
  }));
}

async function searchNews(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const googleNewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const bingNewsUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  const [googleXml, bingXml] = await Promise.allSettled([
    fetchText(googleNewsUrl, timeoutMs, fetcher),
    fetchText(bingNewsUrl, timeoutMs, fetcher),
  ]);
  const out: SearchItem[] = [];
  if (googleXml.status === "fulfilled") out.push(...parseRssItems(googleXml.value, "Google News", "news", count));
  if (bingXml.status === "fulfilled") out.push(...parseRssItems(bingXml.value, "Bing News", "news", count));
  return dedupeByUrl(out).slice(0, count);
}

async function searchMedia(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const feeds: Array<{ source: string; url: string }> = [
    { source: "Reuters", url: "https://feeds.reuters.com/reuters/topNews" },
    { source: "BBC", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
    { source: "NYTimes", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml" },
    { source: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  ];
  const terms = splitTerms(query);
  const settled = await Promise.allSettled(feeds.map((f) => fetchText(f.url, timeoutMs, fetcher).then((xml) => ({ ...f, xml }))));
  const rows: SearchItem[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const items = parseRssItems(s.value.xml, s.value.source, "media", count * 2);
    const matched = items.filter((item) => matchTerms(`${item.title} ${item.snippet}`, terms));
    rows.push(...(matched.length > 0 ? matched : items.slice(0, Math.max(1, Math.floor(count / 3)))));
  }
  return dedupeByUrl(rows).slice(0, count);
}

async function fetchText(url: string, timeoutMs: number, fetcher: typeof fetch): Promise<string> {
  const res = await fetchWithTimeout(url, timeoutMs, fetcher, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; BunClaw/1.0; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`请求失败: ${res.status}`);
  return await res.text();
}

async function fetchWithTimeout(url: string, timeoutMs: number, fetcher: typeof fetch, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseHtmlAnchors(html: string, provider: SearchProvider, source: string, count: number, keepRelative = false): SearchItem[] {
  const blocks = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const out: SearchItem[] = [];
  for (const m of blocks) {
    if (out.length >= count) break;
    const rawHref = decodeHtmlEntities(m[1] || "").trim();
    const title = decodeHtmlEntities(stripHtml(m[2] || "")).trim();
    if (!rawHref || !title) continue;
    if (rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    if (title.length < 2) continue;
    const url = normalizeUrl(rawHref);
    if (!keepRelative && !url.startsWith("http")) continue;
    out.push({ title, url, snippet: "", source, provider });
  }
  return out;
}

function normalizeGoogleUrl(url: string): string {
  if (!url.startsWith("/url?")) return url;
  const qs = url.slice("/url?".length);
  const params = new URLSearchParams(qs);
  return params.get("q") || params.get("url") || url;
}

function normalizeUrl(raw: string): string {
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return raw;
  return raw;
}

function findTag(xml: string, name: string): string {
  const reg = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = xml.match(reg);
  return m?.[1]?.trim() || "";
}

function parseRssItems(xml: string, source: string, provider: SearchProvider, count: number): SearchItem[] {
  const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/gi)].slice(0, count);
  return items
    .map((m) => {
      const block = m[0];
      return {
        title: decodeHtmlEntities(findTag(block, "title") || "新闻"),
        url: decodeHtmlEntities(findTag(block, "link") || ""),
        snippet: decodeHtmlEntities((findTag(block, "description") || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
        source,
        provider,
      };
    })
    .filter((i) => i.url.startsWith("http"));
}

function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function dedupeByUrl(items: SearchItem[]): SearchItem[] {
  const map = new Map<string, SearchItem>();
  for (const item of items) {
    if (!item.url) continue;
    if (!map.has(item.url)) map.set(item.url, item);
  }
  return [...map.values()];
}

function splitTerms(query: string): string[] {
  const text = query.toLowerCase().trim();
  if (!text) return [];
  const raw = text.split(/[\s,，。:：;；、|/]+/g).map((s) => s.trim()).filter(Boolean);
  return raw.filter((s) => s.length >= 2).slice(0, 8);
}

function matchTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const s = text.toLowerCase();
  return terms.some((t) => s.includes(t));
}

export function adaptCommandForPlatform(command: string, platform: NodeJS.Platform): { command: string; adaptedFrom?: string } {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();

  if (platform !== "win32" && /^(ipconfig)(\s|$)/i.test(lower)) {
    const suffix = trimmed.slice("ipconfig".length).trim();
    const linuxFallback = suffix ? `ifconfig ${suffix} || ip a || ip addr` : "ifconfig || ip a || ip addr";
    return { command: linuxFallback, adaptedFrom: trimmed };
  }

  if (platform === "win32" && /^(ifconfig|ip\s+a|ip\s+addr)(\s|$)/i.test(lower)) {
    return { command: "ipconfig", adaptedFrom: trimmed };
  }

  return { command: trimmed };
}

function dayWorkspaceRoot(workspace: string, now = new Date()): string {
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const base = workspace.replaceAll("\\", "/").replace(/\/$/, "");
  return `${base}/${y}/${m}/${d}`;
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


