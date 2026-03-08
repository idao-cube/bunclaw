import { describe, expect, test } from "bun:test";

describe("text encoding hygiene", () => {
  test("source/docs should not contain replacement char", async () => {
    const glob = new Bun.Glob("**/*.{ts,md,json,toml}");
    for await (const file of glob.scan({ cwd: process.cwd(), absolute: false })) {
      if (file.startsWith(".git/") || file.startsWith("node_modules/") || file.startsWith(".bunclaw/") || file.startsWith(".tmp-") || file.endsWith("encoding-hygiene.test.ts")) continue;
      const text = await Bun.file(file).text();
      if (text.includes(String.fromCharCode(0xfffd))) {
        throw new Error(`replacement character found in ${file}`);
      }
      expect(true).toBe(true);
    }
  });
});
