import { describe, expect, test } from "bun:test";
import { searchWebNoKey } from "../src/tools/index";

describe("web_search 无 Key 聚合", () => {
  test("不可用 provider 应跳过并返回可用结果", async () => {
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.github.com/search/repositories")) {
        return new Response(
          JSON.stringify({
            items: [
              { full_name: "idao-cube/bunclaw", html_url: "https://github.com/idao-cube/bunclaw", description: "bunclaw repo" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("www.bing.com/search")) {
        return new Response("<html><body><a href='https://example.com/a'>A 结果</a></body></html>", { status: 200 });
      }
      throw new Error("network blocked");
    }) as typeof fetch;

    const out = await searchWebNoKey("bunclaw", 5, ["github", "bing", "google"], 2000, fakeFetch);
    expect(out.providersTried).toEqual(["github", "bing", "google"]);
    expect(out.providersSucceeded.includes("github")).toBe(true);
    expect(out.providersSucceeded.includes("bing")).toBe(true);
    expect(out.providersSucceeded.includes("google")).toBe(false);
    expect(out.errors.some((e) => e.provider === "google")).toBe(true);
    expect(out.results.length >= 2).toBe(true);
  });
});

