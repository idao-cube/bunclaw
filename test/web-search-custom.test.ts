import { describe, expect, test } from "bun:test";
import { searchWebNoKey } from "../src/tools/index";

describe("web_search custom script", () => {
  test("custom endpoint should be used when configured", async () => {
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== "https://custom.example/search") throw new Error("unexpected endpoint");
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.query !== "bun") throw new Error("unexpected query");
      if (String((init?.headers as Record<string, string> | undefined)?.authorization || "") !== "Bearer token-123") {
        throw new Error("missing auth");
      }
      return new Response(
        JSON.stringify({
          results: [{ title: "endpoint result", url: "https://example.com/ep", snippet: "from endpoint", source: "ep" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const out = await searchWebNoKey("bun", 5, ["custom"], 2000, fakeFetch, {
      endpoint: "https://custom.example/search",
      apiKey: "token-123",
      workspace: process.cwd(),
    });

    expect(out.providersTried).toEqual(["custom"]);
    expect(out.providersSucceeded).toEqual(["custom"]);
    expect(out.results[0]?.url).toBe("https://example.com/ep");
  });

  test("custom provider can return results from bun script", async () => {
    const scriptPath = `temp/.tmp-custom-search-${Date.now()}-${Math.floor(Math.random() * 10000)}.ts`;
    await Bun.write(
      scriptPath,
      [
        "const input = JSON.parse(await new Response(Bun.stdin.stream()).text() || '{}');",
        "const q = String(input.query || '').trim();",
        "console.log(JSON.stringify({ results: [{ title: `custom:${q}`, url: 'https://example.com/custom', snippet: 'ok', source: 'custom-script' }] }));",
      ].join("\n"),
    );

    const out = await searchWebNoKey("bun", 5, ["custom"], 2000, fetch, { customScript: scriptPath, workspace: process.cwd() });
    expect(out.providersTried).toEqual(["custom"]);
    expect(out.providersSucceeded).toEqual(["custom"]);
    expect(out.errors.length).toBe(0);
    expect(out.results.length).toBe(1);
    expect(out.results[0]?.url).toBe("https://example.com/custom");
  });

  test("custom endpoint failure should fallback to custom script", async () => {
    const scriptPath = `temp/.tmp-custom-fallback-${Date.now()}-${Math.floor(Math.random() * 10000)}.ts`;
    await Bun.write(
      scriptPath,
      [
        "const input = JSON.parse(await new Response(Bun.stdin.stream()).text() || '{}');",
        "const q = String(input.query || '').trim();",
        "console.log(JSON.stringify({ results: [{ title: `fallback:${q}`, url: 'https://example.com/fallback', snippet: 'ok', source: 'fallback-script' }] }));",
      ].join("\n"),
    );

    const fakeFetch: typeof fetch = (async () => {
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    const out = await searchWebNoKey("bun", 5, ["custom"], 2000, fakeFetch, {
      endpoint: "https://custom.example/search",
      customScript: scriptPath,
      workspace: process.cwd(),
    });

    expect(out.providersSucceeded).toEqual(["custom"]);
    expect(out.results.some((r) => r.url === "https://example.com/fallback")).toBe(true);
    expect(out.errors.some((e) => e.provider === "custom")).toBe(true);
  });

  test("providers should be de-duplicated", async () => {
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.github.com/search/repositories")) {
        return new Response(
          JSON.stringify({
            items: [{ full_name: "idao-cube/bunclaw", html_url: "https://github.com/idao-cube/bunclaw", description: "bunclaw repo" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("network blocked");
    }) as typeof fetch;

    const out = await searchWebNoKey("bun", 5, ["github", "github", "GITHUB"], 2000, fakeFetch);
    expect(out.providersTried).toEqual(["github"]);
  });

  test("custom script failure does not block builtin providers", async () => {
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.github.com/search/repositories")) {
        return new Response(
          JSON.stringify({
            items: [{ full_name: "idao-cube/bunclaw", html_url: "https://github.com/idao-cube/bunclaw", description: "bunclaw repo" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("network blocked");
    }) as typeof fetch;

    const out = await searchWebNoKey("bun", 5, ["custom", "github"], 2000, fakeFetch, {
      customScript: "temp/.not-exists-custom-search.ts",
      workspace: process.cwd(),
    });

    expect(out.providersTried).toEqual(["custom", "github"]);
    expect(out.providersSucceeded.includes("github")).toBe(true);
    expect(out.errors.some((e) => e.provider === "custom")).toBe(true);
    expect(out.results.some((r) => r.provider === "github")).toBe(true);
  });
    test("invalid custom endpoint scheme should report readable error", async () => {
      const out = await searchWebNoKey("bun", 5, ["custom"], 2000, fetch, {
        endpoint: "file:///tmp/search",
        workspace: process.cwd(),
      });
      expect(out.providersSucceeded.includes("custom")).toBe(false);
      expect(out.errors.some((e) => e.provider === "custom" && e.message.includes("http/https"))).toBe(true);
    });

    test("custom script path with traversal should be rejected", async () => {
      const out = await searchWebNoKey("bun", 5, ["custom"], 2000, fetch, {
        customScript: "../hack.ts",
        workspace: process.cwd(),
      });
      expect(out.providersSucceeded.includes("custom")).toBe(false);
      expect(out.errors.some((e) => e.provider === "custom" && e.message.includes("不允许包含 .."))).toBe(true);
    });
});
