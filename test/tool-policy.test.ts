import { describe, expect, test } from "bun:test";
import { resolveAllowedTools } from "../src/tool-policy";

describe("tool policy", () => {
  test("coding profile includes coding core tools", () => {
    const result = resolveAllowedTools({ profile: "coding" });
    expect(result.has("read")).toBe(true);
    expect(result.has("web_fetch")).toBe(true);
    expect(result.has("message")).toBe(false);
  });

  test("deny wins over allow", () => {
    const result = resolveAllowedTools({ profile: "coding", allow: ["message"], deny: ["message"] });
    expect(result.has("message")).toBe(false);
  });
});

