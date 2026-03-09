#!/usr/bin/env bun

type Input = { query?: string; count?: number; timeoutMs?: number };
type Output = { results: Array<{ title: string; url: string; snippet: string; source: string }> };

await main();

async function main(): Promise<void> {
  const inputText = await new Response(Bun.stdin.stream()).text();
  const input = safeParse(inputText);

  const query = String(input.query || "").trim();
  const count = clampCount(input.count);
  const timeoutMs = Math.max(1000, Number(input.timeoutMs ?? 8000));

  if (!query) {
    console.log(JSON.stringify({ results: [] satisfies Output["results"] }));
    return;
  }

  // 示例实现：使用 Hacker News Algolia API（免 Key）返回结构化搜索结果。
  const endpoint = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${count}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { "user-agent": "bunclaw-custom-search/1.0", accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      hits?: Array<{ title?: string; story_title?: string; url?: string; story_url?: string; _highlightResult?: { title?: { value?: string } } }>;
    };

    const rows = (data.hits || [])
      .map((hit) => {
        const title = String(hit.title || hit.story_title || hit._highlightResult?.title?.value || "HN result").replace(/<[^>]+>/g, "").trim();
        const url = String(hit.url || hit.story_url || "").trim();
        return {
          title,
          url,
          snippet: "Hacker News community result",
          source: "HN Algolia",
        };
      })
      .filter((r) => r.url.startsWith("http") && r.title.length > 0)
      .slice(0, count);

    const out: Output = { results: rows };
    console.log(JSON.stringify(out));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

function clampCount(raw: unknown): number {
  const n = Number(raw ?? 8);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

function safeParse(raw: string): Input {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") return parsed as Input;
  } catch {
    // ignore
  }
  return {};
}

export {};
