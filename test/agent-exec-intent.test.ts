import { describe, expect, test } from "bun:test";
import { extractForcedExecCommand, extractForcedWebFetchUrl } from "../src/agent";

describe("命令执行意图识别", () => {
  test("中文执行语句可提取命令", () => {
    expect(extractForcedExecCommand("执行 ipconfig 看看结果")).toBe("ipconfig");
    expect(extractForcedExecCommand("执行   dir /a   查看输出")).toBe("dir /a");
  });

  test("英文 run 语句可提取命令", () => {
    expect(extractForcedExecCommand("run ipconfig /all")).toBe("ipconfig /all");
  });

  test("普通聊天不应识别为命令执行", () => {
    expect(extractForcedExecCommand("帮我解释一下 ipconfig")).toBeNull();
    expect(extractForcedExecCommand("创建文件 1.txt")).toBeNull();
  });

  test("URL 抓取语句可提取链接", () => {
    expect(extractForcedWebFetchUrl("获取 https://example.com 的内容")).toBe("https://example.com");
    expect(extractForcedWebFetchUrl("帮我抓取网页 http://example.org/news")).toBe("http://example.org/news");
    expect(extractForcedWebFetchUrl("https://example.com 是什么")).toBeNull();
  });
});
