import { ProcessManager, spawnShell } from "../process-manager";
import { EventLog } from "../event-log";

export type ToolContext = {
  workspace: string;
  processManager: ProcessManager;
  eventLog?: EventLog;
  webSearch?: {
    provider?: string;
    providers?: string[];
    categories?: string[];
    endpoint?: string;
    apiKey?: string;
    timeoutMs?: number;
    customScript?: string;
  };
};

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  if (name === "read") {
    const raw = String(args.path ?? "");
    if (raw.trim() === "." || raw.trim() === "./" || raw.trim() === ".\\") {
      throw new Error(`路径是目录，不能按文件读取: ${dayWorkspaceRoot(ctx.workspace)}`);
    }
    const path = await fuzzyResolveFile(raw, ctx.workspace);
    await assertFileReadable(path, "读取");
    const content = await Bun.file(path).text();
    if (ctx.eventLog) await ctx.eventLog.append({ event: "tool.sensitive", tool: "read", args: { path }, bytes: content.length });
    return { path, content };
  }
  if (name === "write") {
    const path = resolveInsideWorkspace(String(args.path ?? ""), ctx.workspace);
    await ensureParentDir(path);
    const content = String(args.content ?? "");
    await Bun.write(path, content);
    if (ctx.eventLog) await ctx.eventLog.append({ event: "tool.sensitive", tool: "write", args: { path }, bytes: content.length });
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
    if (ctx.eventLog) await ctx.eventLog.append({ event: "tool.sensitive", tool: "edit", args: { path }, changed: oldText !== next });
    return { ok: true, path, changed: oldText !== next };
  }
  if (name === "apply_patch") {
    const path = resolveInsideWorkspace(String(args.path ?? ""), ctx.workspace);
    await ensureParentDir(path);
    const content = String(args.content ?? "");
    await Bun.write(path, content);
    if (ctx.eventLog) await ctx.eventLog.append({ event: "tool.sensitive", tool: "apply_patch", args: { path }, bytes: content.length });
    return { ok: true, path, mode: "replace" };
  }
  if (name === "exec") {
    const command = String(args.command ?? "").trim();
    if (!command) return { error: "command 不能为空" };
    const adapted = adaptCommandForPlatform(command, process.platform);

    // 安全检查：拒绝包含明显危险操作的命令
    const checkOrig = isCommandSafe(command, process.platform);
    const checkAdapted = isCommandSafe(adapted.command, process.platform);
    if (!checkOrig.ok || !checkAdapted.ok) {
      const reason = !checkOrig.ok ? checkOrig.reason : (!checkAdapted.ok ? checkAdapted.reason : "命令被判定为不安全");
      if (ctx.eventLog) await ctx.eventLog.append({ event: "tool.sensitive.blocked", tool: "exec", args: { original: command, adapted: adapted.command, reason } });
      return { status: "denied", reason: reason ?? "命令被判定为不安全" };
    }

    if (ctx.eventLog) await ctx.eventLog.append({ event: "tool.sensitive", tool: "exec", args: { command: adapted.command, background: Boolean(args.background) } });
    if (args.background === true) {
      const session = ctx.processManager.start(adapted.command);
      return { status: "running", sessionId: session.id, command: adapted.command, adaptedFrom: adapted.adaptedFrom };
    }
    const proc = spawnShell(adapted.command);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (ctx.eventLog) await ctx.eventLog.append({ event: "tool.sensitive.result", tool: "exec", exitCode, stdoutLen: stdout.length, stderrLen: stderr.length });
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
    const rawUrl = String(args.url ?? "").trim();
    if (!rawUrl) return { error: "url 不能为空" };
    const normalizedUrl = normalizeHttpUrl(rawUrl);
    if (!normalizedUrl) return { error: "web_fetch 仅支持 http/https URL" };
    const res = await fetch(normalizedUrl);
    const text = await res.text();
    return { url: normalizedUrl, status: res.status, content: stripHtml(text).slice(0, Number(args.maxChars ?? 20000)) };
  }
  if (name === "web_search") {
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "query 不能为空" };
    const count = clampCount(args.count);
    const providers = normalizeProviders(args.providers, ctx.webSearch?.providers, ctx.webSearch?.provider);
    const strictProviders = Boolean(args.strictProviders === true);
    const hasCustom = Boolean(String(ctx.webSearch?.endpoint || "").trim() || String(ctx.webSearch?.customScript || "").trim());
    const plannedProviders = (!strictProviders && hasCustom) ? uniqueStrings<SearchProvider>(["custom", ...(providers as SearchProvider[])]) : providers;
    const timeoutMs = Number(ctx.webSearch?.timeoutMs ?? 8000);
    const focusCategories = Array.isArray(args.categories) ? normalizeCategories(args.categories) : normalizeCategories(ctx.webSearch?.categories);
    return await searchWebNoKey(query, count, plannedProviders, timeoutMs, fetch, {
      endpoint: ctx.webSearch?.endpoint,
      apiKey: ctx.webSearch?.apiKey,
      customScript: ctx.webSearch?.customScript,
      workspace: ctx.workspace,
      strictProviders,
      focusSites: normalizeSites(args.sites),
      focusCategories,
    });
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

async function fuzzyResolveFile(raw: string, workspace: string): Promise<string> {
  if (!raw) throw new Error("路径不能为空");
  const input = raw.replaceAll("\\", "/");
  if (input.includes("..")) throw new Error("路径不能越过工作目录");
  if (input.startsWith("/") || /^[A-Za-z]:\//.test(input)) throw new Error("不允许绝对路径");

  const todayPath = resolveInsideWorkspace(raw, workspace);
  const stat = await Bun.file(todayPath).stat().catch(() => null);
  if (stat && !stat.isDirectory()) return todayPath;

  const normalized = input.replace(/^\.\//, "");
  if (!normalized || normalized === ".") return todayPath;

  const base = workspace.replaceAll("\\", "/").replace(/\/$/, "");
  const glob = new Bun.Glob("????????");
  for await (const entry of glob.scan({ cwd: base, onlyFiles: false })) {
    if (!/^\d{8}$/.test(entry)) continue;
    const candidate = `${base}/${entry}/${normalized}`;
    const s = await Bun.file(candidate).stat().catch(() => null);
    if (s && !s.isDirectory()) return candidate;
  }

  return todayPath;
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function assertFileReadable(path: string, action: string): Promise<void> {
  const stat = await Bun.file(path).stat().catch(() => null);
  if (!stat) throw new Error(`文件不存在: ${path}`);
  if (stat.isDirectory()) throw new Error(`路径是目录，不能按文件${action}: ${path}`);
}

type SearchProvider = "bing" | "github" | "baidu" | "google" | "duckduckgo" | "sogou" | "so" | "news" | "media" | "custom";
type SearchItem = { title: string; url: string; snippet: string; source: string; provider: SearchProvider };
const DEFAULT_PROVIDERS: SearchProvider[] = ["news", "media", "bing", "google", "duckduckgo", "baidu", "sogou", "so", "github"];

export type SearchSiteCategory = "government" | "education" | "research" | "media" | "forum" | "social" | "tech";

export const SEARCH_SITE_CATALOG: Record<SearchSiteCategory, string[]> = {
  government: [
    "www.gov.cn", "npc.gov.cn", "ndrc.gov.cn", "mofcom.gov.cn", "moe.gov.cn", "miit.gov.cn", "mps.gov.cn", "chinatax.gov.cn",
    "customs.gov.cn", "safe.gov.cn", "pbc.gov.cn", "stats.gov.cn", "samr.gov.cn", "nea.gov.cn", "mohrss.gov.cn", "mfa.gov.cn",
  ],
  education: [
    "edu.cn", "tsinghua.edu.cn", "pku.edu.cn", "zju.edu.cn", "sjtu.edu.cn", "ustc.edu.cn", "fudan.edu.cn", "whu.edu.cn",
    "hit.edu.cn", "nju.edu.cn", "scu.edu.cn", "xjtu.edu.cn", "bit.edu.cn", "buaa.edu.cn", "nankai.edu.cn", "ruc.edu.cn",
  ],
  research: [
    "arxiv.org", "aclanthology.org", "ieeexplore.ieee.org", "dl.acm.org", "springer.com", "nature.com", "science.org", "sciencedirect.com",
    "tandfonline.com", "jstor.org", "mdpi.com", "frontiersin.org", "wiley.com", "cell.com", "openreview.net", "semanticscholar.org",
  ],
  media: [
    "reuters.com", "bbc.com", "nytimes.com", "washingtonpost.com", "wsj.com", "economist.com", "bloomberg.com", "apnews.com",
    "theguardian.com", "cnn.com", "xinhuanet.com", "people.com.cn", "cctv.com", "thepaper.cn", "caixin.com", "36kr.com",
  ],
  forum: [
    "stackoverflow.com", "reddit.com", "v2ex.com", "segmentfault.com", "tieba.baidu.com", "linux.do", "nga.cn", "quora.com",
    "zhihu.com", "discourse.org", "oschina.net", "dev.to", "lobste.rs", "forum.xda-developers.com", "4pda.to", "bbs.hupu.com",
  ],
  social: [
    "x.com", "twitter.com", "weibo.com", "zhihu.com", "douban.com", "bilibili.com", "youtube.com", "tiktok.com",
    "facebook.com", "instagram.com", "linkedin.com", "medium.com", "telegram.org", "discord.com", "xiaohongshu.com", "mastodon.social",
  ],
  tech: [
    "github.com", "gitee.com", "juejin.cn", "csdn.net", "gitlab.com", "stackoverflow.com", "npmjs.com", "pypi.org",
    "rust-lang.org", "nodejs.org", "bun.sh", "deno.com", "cloud.tencent.com", "developer.aliyun.com", "infoq.com", "51cto.com",
  ],
};

export async function searchWebNoKey(
  query: string,
  count: number,
  providers: string[],
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
  options?: {
    endpoint?: string;
    apiKey?: string;
    customScript?: string;
    workspace?: string;
    strictProviders?: boolean;
    focusSites?: string[];
    focusCategories?: SearchSiteCategory[];
  },
): Promise<{
  query: string;
  count: number;
  searchedAt: string;
  intent: string[];
  matchedCategories: string[];
  providersTried: string[];
  providersSucceeded: string[];
  results: SearchItem[];
  errors: Array<{ provider: string; message: string }>;
}> {
  const allProviders: SearchProvider[] = [...DEFAULT_PROVIDERS, "custom"];
  const picked = providers.map((p) => p.toLowerCase()).filter((p): p is SearchProvider => allProviders.includes(p as SearchProvider));
  const baseOrdered = uniqueStrings<SearchProvider>(picked.length > 0 ? picked : DEFAULT_PROVIDERS);
  const plan = buildSearchPlan(query, baseOrdered, {
    strictProviders: Boolean(options?.strictProviders),
    focusSites: options?.focusSites,
  });
  const ordered = plan.providers;
  const errors: Array<{ provider: string; message: string }> = [];
  const success = new Set<string>();
  const all: SearchItem[] = [];

  // custom provider 的优先级：endpoint > customScript。
  if (ordered.includes("custom")) {
    const endpoint = String(options?.endpoint || "").trim();
    const customScript = String(options?.customScript || "").trim();
    if (endpoint) {
      try {
        const customRows = await searchFromCustomEndpoint({
          query: plan.providerQueries.custom,
          count,
          timeoutMs,
          endpoint,
          apiKey: options?.apiKey,
          focusSites: plan.focusSites,
          fetcher,
        });
        if (customRows.length > 0) {
          all.push(...customRows);
          success.add("custom");
        }
      } catch (error) {
        errors.push({ provider: "custom", message: error instanceof Error ? error.message : String(error) });
        if (customScript) {
          try {
            const fallbackRows = await runCustomSearchScript({
              query: plan.providerQueries.custom,
              count,
              timeoutMs,
              scriptPath: customScript,
              workspace: options?.workspace,
            });
            if (fallbackRows.length > 0) {
              all.push(...fallbackRows);
              success.add("custom");
            }
          } catch (fallbackError) {
            errors.push({ provider: "custom", message: `endpoint失败后脚本回退也失败: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}` });
          }
        }
      }
    } else if (customScript) {
      try {
        const customRows = await runCustomSearchScript({
          query: plan.providerQueries.custom,
          count,
          timeoutMs,
          scriptPath: customScript,
          workspace: options?.workspace,
        });
        if (customRows.length > 0) {
          all.push(...customRows);
          success.add("custom");
        }
      } catch (error) {
        errors.push({ provider: "custom", message: error instanceof Error ? error.message : String(error) });
      }
    } else {
      errors.push({ provider: "custom", message: "未配置 tools.webSearch.endpoint 或 customScript" });
    }
  }

  const builtin = ordered.filter((p) => p !== "custom");
  const settled = await Promise.allSettled(
    builtin.map(async (provider) => {
      let items: SearchItem[] = [];
      const q = plan.providerQueries[provider] || query;
      if (provider === "bing") items = await searchBing(q, count, timeoutMs, fetcher);
      else if (provider === "github") items = await searchGithub(q, count, timeoutMs, fetcher);
      else if (provider === "baidu") items = await searchBaidu(q, count, timeoutMs, fetcher);
      else if (provider === "google") items = await searchGoogle(q, count, timeoutMs, fetcher);
      else if (provider === "duckduckgo") items = await searchDuckDuckGo(q, count, timeoutMs, fetcher);
      else if (provider === "sogou") items = await searchSogou(q, count, timeoutMs, fetcher);
      else if (provider === "so") items = await searchSo(q, count, timeoutMs, fetcher);
      else if (provider === "news") items = await searchNews(q, count, timeoutMs, fetcher);
      else if (provider === "media") items = await searchMedia(q, count, timeoutMs, fetcher);
      return { provider, items };
    }),
  );
  settled.forEach((item, idx) => {
    const provider = builtin[idx];
    if (item.status === "rejected") {
      errors.push({ provider, message: item.reason instanceof Error ? item.reason.message : String(item.reason) });
      return;
    }
    if (item.value.items.length > 0) {
      all.push(...item.value.items);
      success.add(provider);
    }
  });

  const results = rankSearchResults(dedupeByUrl(all), plan).slice(0, count);
  return {
    query: plan.finalQuery,
    count,
    searchedAt: new Date().toISOString(),
    intent: plan.intentTags,
    matchedCategories: plan.categories,
    providersTried: ordered,
    providersSucceeded: ordered.filter((p) => success.has(p)),
    results,
    errors,
  };
}

async function searchFromCustomEndpoint(input: {
  query: string;
  count: number;
  timeoutMs: number;
  endpoint: string;
  apiKey?: string;
  focusSites?: string[];
  fetcher: typeof fetch;
}): Promise<SearchItem[]> {
  const endpoint = normalizeHttpUrl(input.endpoint);
  if (!endpoint) throw new Error("custom endpoint 必须是 http/https URL");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "bunclaw/1.0",
  };
  const key = String(input.apiKey || "").trim();
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetchWithTimeout(endpoint, input.timeoutMs, input.fetcher, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: input.query, count: input.count, timeoutMs: input.timeoutMs }),
  });
  if (!res.ok) throw new Error(`custom endpoint failed: ${res.status}`);

  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; snippet?: string; source?: string }>;
    items?: Array<{ title?: string; url?: string; snippet?: string; source?: string }>;
  };
  const rows = Array.isArray(data.results) ? data.results : (Array.isArray(data.items) ? data.items : []);
  return rows
    .map((r) => ({
      title: String(r.title || "自定义结果").trim(),
      url: String(r.url || "").trim(),
      snippet: String(r.snippet || "").trim(),
      source: String(r.source || "Custom Endpoint").trim(),
      provider: "custom" as const,
    }))
    .filter((r) => r.url.startsWith("http") && r.title.length > 0)
    .slice(0, input.count);
}

function normalizeProviders(argsProviders: unknown, cfgProviders?: string[], cfgProvider?: string): string[] {
  if (Array.isArray(argsProviders)) return argsProviders.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean);
  if (Array.isArray(cfgProviders) && cfgProviders.length > 0) return cfgProviders.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean);
  if (cfgProvider && cfgProvider.trim()) return [cfgProvider.trim().toLowerCase()];
  return DEFAULT_PROVIDERS;
}

function normalizeSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item || "").trim().toLowerCase();
    if (!s) continue;
    const host = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) out.push(host);
  }
  return uniqueStrings(out);
}

function normalizeCategories(raw: unknown): SearchSiteCategory[] {
  if (!Array.isArray(raw)) return [];
  const all = new Set<SearchSiteCategory>(["government", "education", "research", "media", "forum", "social", "tech"]);
  const out: SearchSiteCategory[] = [];
  for (const item of raw) {
    const v = String(item || "").trim().toLowerCase() as SearchSiteCategory;
    if (all.has(v)) out.push(v);
  }
  return uniqueStrings(out);
}

type SearchPlan = {
  finalQuery: string;
  providers: SearchProvider[];
  providerQueries: Record<SearchProvider, string>;
  focusSites: string[];
  categories: SearchSiteCategory[];
  intentTags: string[];
};

function buildSearchPlan(
  query: string,
  providers: SearchProvider[],
  options?: { strictProviders?: boolean; focusSites?: string[]; focusCategories?: SearchSiteCategory[] },
): SearchPlan {
  const raw = query.trim();
  const lower = raw.toLowerCase();
  const tags: string[] = [];
  const inferredCategories = inferCategoriesFromQuery(raw);
  const categories = uniqueStrings<SearchSiteCategory>([...(options?.focusCategories || []), ...inferredCategories]);
  const categorySites = categories.flatMap((c) => SEARCH_SITE_CATALOG[c] || []);
  const focusSites = uniqueStrings([...(options?.focusSites || []), ...extractSitesFromQuery(raw), ...categorySites]);

  const sourceIntent = /(源码|源代码|code|repository|repo|github|gitlab)/i.test(lower);
  const officialIntent = /(官网|官方网站|official|official site|official website)/i.test(lower);
  const newsIntent = /(最新|今日|今天|实时|快讯|news|breaking|trending|release|发布)/i.test(lower);

  if (sourceIntent) tags.push("source-code");
  if (officialIntent) tags.push("official-site");
  if (newsIntent) tags.push("freshness");
  if (focusSites.length > 0) tags.push("focus-sites");
  categories.forEach((c) => tags.push(`category:${c}`));

  const keyword = extractMainKeyword(raw);
  let finalQuery = raw;
  if (officialIntent && keyword) {
    finalQuery = `${keyword} 官网 official website`;
  } else if (sourceIntent && keyword) {
    finalQuery = `${keyword} github source code`;
  }

  const reordered = [...providers];
  if (!options?.strictProviders) {
    // 非强制 provider 模式下，根据意图重排优先级。
    if (sourceIntent) {
      applyPriority(reordered, ["github", "google", "bing"]);
    }
    if (officialIntent) {
      applyPriority(reordered, ["google", "bing", "baidu"]);
    }
    if (newsIntent) {
      applyPriority(reordered, ["news", "media"]);
    }
  }

  const providerQueries: Record<SearchProvider, string> = {
    bing: withSiteHints(finalQuery, focusSites),
    google: withSiteHints(finalQuery, focusSites),
    baidu: withSiteHints(finalQuery, focusSites),
    duckduckgo: withSiteHints(finalQuery, focusSites),
    sogou: withSiteHints(finalQuery, focusSites),
    so: withSiteHints(finalQuery, focusSites),
    github: sourceIntent && keyword ? `${keyword} in:name,description` : finalQuery,
    news: finalQuery,
    media: finalQuery,
    custom: finalQuery,
  };

  return {
    finalQuery,
    providers: uniqueStrings(reordered) as SearchProvider[],
    providerQueries,
    focusSites,
    categories,
    intentTags: tags,
  };
}

function inferCategoriesFromQuery(query: string): SearchSiteCategory[] {
  const text = query.toLowerCase();
  const out: SearchSiteCategory[] = [];
  if (/(政府|政务|政策|部委|监管|gov|government)/i.test(text)) out.push("government");
  if (/(学校|高校|大学|学院|招生|教务|edu|campus)/i.test(text)) out.push("education");
  if (/(论文|期刊|学术|研究|arxiv|ieee|acm|nature|science|journal)/i.test(text)) out.push("research");
  if (/(媒体|新闻|报道|快讯|news|media|press)/i.test(text)) out.push("media");
  if (/(论坛|社区|问答|讨论|贴吧|v2ex|forum|reddit|stack)/i.test(text)) out.push("forum");
  if (/(社交|微博|推特|知乎|小红书|social|twitter|facebook|instagram|linkedin|youtube|bilibili)/i.test(text)) out.push("social");
  if (/(技术|开发|编程|源码|开源|掘金|csdn|gitee|github|gitlab|框架|前端|后端|ai|模型)/i.test(text)) out.push("tech");
  return uniqueStrings(out);
}

function extractSitesFromQuery(query: string): string[] {
  const sites = new Set<string>();
  for (const m of query.matchAll(/site:([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = String(m[1] || "").toLowerCase();
    if (host) sites.add(host);
  }
  return [...sites];
}

function withSiteHints(query: string, sites: string[]): string {
  if (sites.length === 0) return query;
  const hints = sites.slice(0, 2).map((s) => `site:${s}`).join(" OR ");
  return `${query} ${hints}`.trim();
}

function extractMainKeyword(query: string): string {
  const cleaned = query
    .replace(/site:[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/(官网|官方网站|official|official site|official website|源码|源代码|code|repository|repo|搜索|查询|去|在|上|请|帮我)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(/\s+/g).filter(Boolean);
  return parts[0] || "";
}

function applyPriority(list: SearchProvider[], priority: SearchProvider[]): void {
  const exists = new Set<SearchProvider>(list);
  const prefix = priority.filter((p) => exists.has(p));
  const prefixSet = new Set<SearchProvider>(prefix);
  const rest = list.filter((p) => !prefixSet.has(p));
  list.splice(0, list.length, ...prefix, ...rest);
}

function rankSearchResults(items: SearchItem[], plan: SearchPlan): SearchItem[] {
  const now = Date.now();
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  return [...items].sort((a, b) => score(b) - score(a));

  function score(item: SearchItem): number {
    let s = 0;
    const host = safeHost(item.url);
    if (item.provider === "github") s += 18;
    if (item.provider === "news") s += 12;
    if (item.provider === "media") s += 10;

    if (plan.intentTags.includes("source-code") && /github\.com|gitlab\.com/i.test(host)) s += 30;
    if (plan.intentTags.includes("official-site") && host && looksOfficialHost(host, plan.finalQuery)) s += 22;
    if (plan.focusSites.some((site) => host === site || host.endsWith(`.${site}`))) s += 35;

    const text = `${item.title} ${item.snippet}`;
    if (/(\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|today|latest|updated|release|发布|更新)/i.test(text)) s += 8;
    if (/(论坛|转载|采集|镜像)/i.test(text)) s -= 5;

    // 过老内容轻微降权（仅通过标题/摘要中的年份近似判断）
    const year = extractYear(text);
    if (year > 0) {
      const age = now - new Date(year, 0, 1).getTime();
      if (age > oneYearMs * 5) s -= 8;
    }
    return s;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function looksOfficialHost(host: string, query: string): boolean {
  const keyword = extractMainKeyword(query).toLowerCase();
  if (!keyword) return /(official|docs|www)/i.test(host);
  return host.includes(keyword.toLowerCase()) || /official|docs|www/i.test(host);
}

function extractYear(text: string): number {
  const m = text.match(/(20\d{2})/);
  if (!m) return 0;
  const y = Number(m[1]);
  if (!Number.isFinite(y) || y < 2000 || y > 2100) return 0;
  return y;
}

function uniqueStrings<T extends string>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

async function runCustomSearchScript(input: {
  query: string;
  count: number;
  timeoutMs: number;
  scriptPath: string;
  workspace?: string;
}): Promise<SearchItem[]> {
  const script = resolveScriptPath(input.scriptPath);
  const payload = JSON.stringify({ query: input.query, count: input.count, timeoutMs: input.timeoutMs });
  const proc = Bun.spawn(["bun", script], {
    cwd: input.workspace || process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), Math.max(1000, input.timeoutMs));
  try {
    if (proc.stdin) {
      await proc.stdin.write(payload);
      await proc.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`自定义搜索脚本执行失败(code=${exitCode}): ${stderr.trim() || "unknown error"}`);
    }
    const parsed = JSON.parse(stdout || "{}") as { results?: Array<{ title?: string; url?: string; snippet?: string; source?: string }> };
    const rows = Array.isArray(parsed.results) ? parsed.results : [];
    return rows
      .map((r) => ({
        title: String(r.title || "自定义结果").trim(),
        url: String(r.url || "").trim(),
        snippet: String(r.snippet || "").trim(),
        source: String(r.source || "Custom Script").trim(),
        provider: "custom" as const,
      }))
      .filter((r) => r.url.startsWith("http") && r.title.length > 0)
      .slice(0, input.count);
  } finally {
    clearTimeout(timer);
  }
}

function resolveScriptPath(raw: string): string {
  const normalized = raw.replaceAll("\\", "/").trim();
  if (!normalized) throw new Error("customScript 不能为空");
  if (normalized.includes("..")) throw new Error("customScript 不允许包含 ..");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return raw;
  return `${process.cwd().replaceAll("\\", "/").replace(/\/$/, "")}/${normalized}`;
}

function normalizeHttpUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
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

async function searchDuckDuckGo(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, timeoutMs, fetcher);
  return parseHtmlAnchors(html, "duckduckgo", "DuckDuckGo", count);
}

async function searchSogou(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  const html = await fetchText(url, timeoutMs, fetcher);
  return parseHtmlAnchors(html, "sogou", "Sogou", count);
}

async function searchSo(query: string, count: number, timeoutMs: number, fetcher: typeof fetch): Promise<SearchItem[]> {
  const url = `https://www.so.com/s?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, timeoutMs, fetcher);
  return parseHtmlAnchors(html, "so", "360 Search", count);
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
  return `${base}/${y}${m}${d}`;
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

function isCommandSafe(command: string, platform: NodeJS.Platform): { ok: true } | { ok: false; reason: string } {
  const cmd = String(command || "");
  if (!cmd.trim()) return { ok: false, reason: "空命令" };
  const lower = cmd.toLowerCase();

  const banned: Array<{ re: RegExp; reason: string }> = [
    { re: /\brm\s+-rf\b/i, reason: "包含 rm -rf" },
    { re: /\bdd\s+if=/i, reason: "包含 dd 写设备" },
    { re: /\bmkfs\b/i, reason: "可能格式化分区" },
    { re: /\bshutdown\b|\breboot\b|\bpoweroff\b/i, reason: "关机/重启相关命令" },
    { re: /:\s*\(\)\s*\{\s*:\|:\s*\|\s*:\s*;?/i, reason: "fork 炸弹样式" },
    { re: /curl\s+[^|]+\|\s*(sh|bash|dash|zsh)/i, reason: "通过 curl|wget 管道执行脚本" },
  ];

  for (const p of banned) {
    if (p.re.test(lower)) return { ok: false, reason: p.reason };
  }

  // 禁止直接操作 /dev 或写入设备
  if (/\/dev\//.test(lower) || /\\windows\\system32/i.test(lower)) return { ok: false, reason: "包含系统设备路径" };

  // 保守拒绝复杂重定向或管道（允许简单的 echo/ls/grep 等）
  if (/[|&;<>]/.test(cmd) && !/^\s*(echo|ls|cat|grep|sed|awk|head|tail|tr|cut|sort|uniq|wc)\b/i.test(cmd)) {
    return { ok: false, reason: "包含复杂重定向或管道，出于安全被拒绝" };
  }

  return { ok: true };
}


