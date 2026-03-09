import { describe, expect, test } from "bun:test";
import { searchWebNoKey } from "../src/tools/index";

describe("web_search intent planning", () => {
  test("source-code intent should prioritize github in non-strict mode", async () => {
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com/search/repositories")) {
        return new Response(
          JSON.stringify({
            items: [{ full_name: "OpenClaw/OpenClaw", html_url: "https://github.com/OpenClaw/OpenClaw", description: "openclaw source" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // other providers fail, should be skipped
      throw new Error("network blocked");
    }) as typeof fetch;

    const out = await searchWebNoKey("openclaw源码", 5, [], 2000, fakeFetch, { strictProviders: false });
    expect(out.providersTried[0]).toBe("github");
    expect(out.intent.includes("source-code")).toBe(true);
    expect(out.providersSucceeded.includes("github")).toBe(true);
  });

  test("official-site query should carry site hint when site: is provided", async () => {
    let seenBingUrl = "";
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("www.bing.com/search")) {
        seenBingUrl = url;
        return new Response("<html><body><a href='https://openclaw.example.com'>OpenClaw Official</a></body></html>", { status: 200 });
      }
      throw new Error("network blocked");
    }) as typeof fetch;

    const out = await searchWebNoKey("openclaw 官网 site:github.com", 5, ["bing"], 2000, fakeFetch, { strictProviders: true });
    expect(out.intent.includes("official-site")).toBe(true);
    expect(seenBingUrl.includes("site%3Agithub.com")).toBe(true);
    expect(out.results.length).toBe(1);
  });

  test("strictProviders should preserve original provider order", async () => {
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com/search/repositories")) {
        return new Response(
          JSON.stringify({
            items: [{ full_name: "OpenClaw/OpenClaw", html_url: "https://github.com/OpenClaw/OpenClaw", description: "openclaw source" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<html><body><a href='https://example.com/a'>A</a></body></html>", { status: 200 });
    }) as typeof fetch;

    const out = await searchWebNoKey("openclaw源码", 5, ["bing", "github"], 2000, fakeFetch, { strictProviders: true });
    expect(out.providersTried.slice(0, 2)).toEqual(["bing", "github"]);
  });
});
