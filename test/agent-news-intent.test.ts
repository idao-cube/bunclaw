import { describe, expect, test } from "bun:test";
import { shouldForceWebResearch } from "../src/agent";

describe("新闻查询意图识别", () => {
  test("最新消息应强制联网搜索", () => {
    expect(shouldForceWebResearch("2026年3月8日最新消息")).toBe(true);
    expect(shouldForceWebResearch("今天科技新闻头条")).toBe(true);
    expect(shouldForceWebResearch("帮我联网搜索今天的 AI 资讯")).toBe(true);
    expect(shouldForceWebResearch("今日国际黄金价格")).toBe(true);
    expect(shouldForceWebResearch("黄金实时行情")).toBe(true);
  });

  test("普通编码请求不应强制联网搜索", () => {
    expect(shouldForceWebResearch("创建一个文件 1.txt 内容 111111")).toBe(false);
    expect(shouldForceWebResearch("把 readme 改成中文")).toBe(false);
    expect(shouldForceWebResearch("在项目中搜索 TODO")).toBe(false);
    expect(shouldForceWebResearch("查找 workspace 里的 config 文件")).toBe(false);
  });

  test("通用搜索语义应走联网", () => {
    expect(shouldForceWebResearch("联网搜索 OpenAI 最新发布")).toBe(true);
    expect(shouldForceWebResearch("上网查 bun 官方文档")).toBe(true);
    expect(shouldForceWebResearch("获取今天 AI 资讯")).toBe(true);
  });

  test("普通查找不应默认联网", () => {
    expect(shouldForceWebResearch("查找 bun 官方文档")).toBe(false);
    expect(shouldForceWebResearch("获取 map 2026 的写作思路")).toBe(false);
    expect(shouldForceWebResearch("搜索 TODO 列表")).toBe(false);
  });
});
