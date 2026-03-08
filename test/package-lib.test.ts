import { describe, expect, test } from "bun:test";
import { outputExtension, outputLabel, targetToPlatform } from "../scripts/package-lib";

describe("打包命名", () => {
  test("目标平台识别", () => {
    expect(targetToPlatform("bun-windows-x64")).toBe("windows");
    expect(targetToPlatform("bun-linux-x64")).toBe("linux");
    expect(targetToPlatform("bun-darwin-arm64")).toBe("darwin");
  });

  test("输出后缀应按目标平台决定", () => {
    expect(outputExtension("bun-windows-x64")).toBe(".exe");
    expect(outputExtension("bun-linux-x64")).toBe("");
    expect(outputExtension("bun-darwin-x64")).toBe("");
  });

  test("输出标签", () => {
    expect(outputLabel("bun-linux-x64")).toBe("bun-linux-x64");
    expect(outputLabel("").length > 0).toBe(true);
  });
});

