import { describe, expect, test } from "bun:test";
import { DatabaseStore } from "../src/db";
import { EventLog } from "../src/event-log";

describe("storage", () => {
  test("session and idempotency persist", () => {
    const dbPath = `temp/.tmp-storage-${Date.now()}-${Math.random()}.db`;
    const db = new DatabaseStore(dbPath);
    const session = db.createSession("main");
    db.insertMessage(session.id, "user", "hello");
    db.saveIdempotent("agent.run", "k1", JSON.stringify({ ok: true }));

    const fetched = db.getSessionByKey("main");
    expect(fetched?.id).toBe(session.id);
    expect(db.findIdempotent("agent.run", "k1")).toBeTruthy();
  });

  test("jsonl event append", async () => {
    const logPath = `temp/.tmp-events-${Date.now()}-${Math.random()}.jsonl`;
    const log = new EventLog(logPath);
    await log.append({ event: "agent.delta", seq: 1 });
    const lines = await Bun.file(logPath).text();
    expect(lines.includes("agent.delta")).toBe(true);
  });

  test("jsonl event multi-append preserves all lines", async () => {
    const logPath = `temp/.tmp-events-multi-${Date.now()}-${Math.random()}.jsonl`;
    const log = new EventLog(logPath);
    await log.append({ event: "first", seq: 1 });
    await log.append({ event: "second", seq: 2 });
    await log.append({ event: "third", seq: 3 });
    const text = await Bun.file(logPath).text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(text.includes('"first"')).toBe(true);
    expect(text.includes('"second"')).toBe(true);
    expect(text.includes('"third"')).toBe(true);
  });

  test("clearChatData clears sessions/messages/idempotency", () => {
    const dbPath = `temp/.tmp-storage-${Date.now()}-${Math.random()}.db`;
    const db = new DatabaseStore(dbPath);
    const session = db.createSession("main");
    db.insertMessage(session.id, "user", "hello");
    db.saveIdempotent("agent.run", "k1", JSON.stringify({ ok: true }));
    db.clearChatData();
    expect(db.listSessions().length).toBe(0);
    expect(db.findIdempotent("agent.run", "k1")).toBeNull();
  });
});


