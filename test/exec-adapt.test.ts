import { describe, expect, test } from "bun:test";
import { adaptCommandForPlatform } from "../src/tools/index";

describe("exec 跨平台命令自适配", () => {
  test("非 Windows 下 ipconfig 自动降级", () => {
    const out = adaptCommandForPlatform("ipconfig", "linux");
    expect(out.command.includes("ifconfig")).toBe(true);
    expect(out.command.includes("ip a")).toBe(true);
    expect(out.adaptedFrom).toBe("ipconfig");
  });

  test("Windows 下 ifconfig 自动切换为 ipconfig", () => {
    const out = adaptCommandForPlatform("ifconfig", "win32");
    expect(out.command).toBe("ipconfig");
    expect(out.adaptedFrom).toBe("ifconfig");
  });

  test("普通命令不改写", () => {
    const out = adaptCommandForPlatform("echo hello", "darwin");
    expect(out.command).toBe("echo hello");
    expect(out.adaptedFrom).toBeUndefined();
  });
});

