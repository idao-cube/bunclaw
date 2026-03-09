import { describe, expect, test } from "bun:test";
import { SEARCH_SITE_CATALOG, searchWebNoKey } from "../src/tools/index";

describe("web_search site catalog", () => {
  test("each category should contain at least 15 sites", () => {
    expect(SEARCH_SITE_CATALOG.government.length).toBeGreaterThanOrEqual(15);
    expect(SEARCH_SITE_CATALOG.education.length).toBeGreaterThanOrEqual(15);
    expect(SEARCH_SITE_CATALOG.research.length).toBeGreaterThanOrEqual(15);
    expect(SEARCH_SITE_CATALOG.media.length).toBeGreaterThanOrEqual(15);
    expect(SEARCH_SITE_CATALOG.forum.length).toBeGreaterThanOrEqual(15);
    expect(SEARCH_SITE_CATALOG.social.length).toBeGreaterThanOrEqual(15);
    expect(SEARCH_SITE_CATALOG.tech.length).toBeGreaterThanOrEqual(15);
  });

  test("query should infer tech category", async () => {
    const fakeFetch: typeof fetch = (async () => {
      return new Response("<html><body><a href='https://github.com/OpenClaw/OpenClaw'>OpenClaw</a></body></html>", { status: 200 });
    }) as typeof fetch;
    const out = await searchWebNoKey("openclaw源码 掘金 csdn", 5, ["bing"], 2000, fakeFetch);
    expect(out.matchedCategories.includes("tech")).toBe(true);
  });
});
