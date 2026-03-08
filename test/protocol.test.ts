import { describe, expect, test } from "bun:test";
import { validateFirstFrame } from "../src/protocol";

describe("protocol", () => {
  test("rejects non-connect first frame", () => {
    const result = validateFirstFrame({ type: "req", method: "health" });
    expect(result.ok).toBe(false);
  });

  test("accepts connect frame", () => {
    const result = validateFirstFrame({ type: "connect", auth: { token: "x" } });
    expect(result.ok).toBe(true);
  });
});

