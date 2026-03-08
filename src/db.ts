import { Database } from "bun:sqlite";
import type { Message, Session } from "./types";

export class DatabaseStore {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_key TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        method TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (method, idem_key)
      );
    `);
    this.addColumnIfMissing("ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;");
    this.addColumnIfMissing("ALTER TABLE messages ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;");
    this.addColumnIfMissing("ALTER TABLE messages ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;");
  }

  private addColumnIfMissing(sql: string): void {
    try {
      this.db.exec(sql);
    } catch {
      // 旧库已存在列时忽略
    }
  }

  createSession(sessionKey: string): Session {
    const existing = this.getSessionByKey(sessionKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    const session: Session = { id: crypto.randomUUID(), sessionKey, createdAt: now, updatedAt: now };
    this.db.query("INSERT INTO sessions (id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(session.id, session.sessionKey, session.createdAt, session.updatedAt);
    return session;
  }

  listSessions(): Session[] {
    const rows = this.db.query("SELECT id, session_key, created_at, updated_at FROM sessions ORDER BY updated_at DESC").all() as Array<Record<string, string>>;
    return rows.map((r) => ({ id: r.id, sessionKey: r.session_key, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  getSessionByKey(sessionKey: string): Session | null {
    const row = this.db.query("SELECT id, session_key, created_at, updated_at FROM sessions WHERE session_key = ?").get(sessionKey) as Record<string, string> | null;
    if (!row) return null;
    return { id: row.id, sessionKey: row.session_key, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  touchSession(sessionId: string): void {
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
  }

  insertMessage(sessionId: string, role: string, content: string, tokens?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): Message {
    const message: Message = {
      id: crypto.randomUUID(),
      sessionId,
      role,
      content,
      createdAt: new Date().toISOString(),
      promptTokens: Number(tokens?.promptTokens ?? 0),
      completionTokens: Number(tokens?.completionTokens ?? 0),
      totalTokens: Number(tokens?.totalTokens ?? 0),
    };
    this.db.query("INSERT INTO messages (id, session_id, role, content, prompt_tokens, completion_tokens, total_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.promptTokens ?? 0,
        message.completionTokens ?? 0,
        message.totalTokens ?? 0,
        message.createdAt,
      );
    this.touchSession(sessionId);
    return message;
  }

  listMessages(sessionId: string, limit = 50): Message[] {
    const rows = this.db.query("SELECT id, session_id, role, content, prompt_tokens, completion_tokens, total_tokens, created_at FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(sessionId, limit) as Array<Record<string, string>>;
    return rows
      .map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        promptTokens: Number(r.prompt_tokens ?? 0),
        completionTokens: Number(r.completion_tokens ?? 0),
        totalTokens: Number(r.total_tokens ?? 0),
        createdAt: r.created_at,
      }))
      .reverse();
  }

  saveIdempotent(method: string, idemKey: string, responseJson: string): void {
    this.db
      .query("INSERT OR REPLACE INTO idempotency (method, idem_key, response_json, created_at) VALUES (?, ?, ?, ?)")
      .run(method, idemKey, responseJson, new Date().toISOString());
  }

  findIdempotent(method: string, idemKey: string): string | null {
    const row = this.db.query("SELECT response_json FROM idempotency WHERE method = ? AND idem_key = ?").get(method, idemKey) as { response_json: string } | null;
    return row?.response_json ?? null;
  }

  clearChatData(): void {
    this.db.exec(`
      DELETE FROM messages;
      DELETE FROM idempotency;
      DELETE FROM sessions;
      VACUUM;
    `);
  }

  countSessions(): number {
    const row = this.db.query("SELECT COUNT(1) AS c FROM sessions").get() as { c: number } | null;
    return Number(row?.c ?? 0);
  }

  countMessages(): number {
    const row = this.db.query("SELECT COUNT(1) AS c FROM messages").get() as { c: number } | null;
    return Number(row?.c ?? 0);
  }

  countTotalTokens(): number {
    const row = this.db.query("SELECT COALESCE(SUM(total_tokens), 0) AS c FROM messages").get() as { c: number } | null;
    return Number(row?.c ?? 0);
  }
}


