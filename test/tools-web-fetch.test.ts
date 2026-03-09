import { describe, expect, test } from "bun:test";
import { runTool } from "../src/tools/index";
import { ProcessManager } from "../src/process-manager";

describe("tool web_fetch validation", () => {
  test("empty url should return error", async () => {
    const out = (await runTool("web_fetch", { url: "" }, { workspace: process.cwd(), processManager: new ProcessManager() })) as {
      error?: string;
    };
    expect(String(out.error || "")).toContain("url 不能为空");
  });

  test("non-http url should return error", async () => {
    const out = (await runTool("web_fetch", { url: "file:///etc/passwd" }, { workspace: process.cwd(), processManager: new ProcessManager() })) as {
      error?: string;
    };
    expect(String(out.error || "")).toContain("仅支持 http/https URL");
  });
});
