import { describe, expect, test } from "bun:test";

describe("纯 Bun 约束", () => {
  test("项目代码不应包含 node:* 导入", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs}");
    for await (const file of glob.scan({ cwd: process.cwd(), absolute: false })) {
      if (file.startsWith(".git/") || file.startsWith("node_modules/")) continue;
      const text = await Bun.file(file).text();
      expect(/from\s+["']node:/.test(text)).toBe(false);
      expect(/import\s+["']node:/.test(text)).toBe(false);
    }
  });
});

