import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type ChatMessage = {
  id: number;
  chatId: string;
  userId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

export class ChatHistory {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp)
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        content=messages,
        content_rowid=id,
        tokenize='unicode61 remove_diacritics 2'
      )
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
      END
    `);
  }

  addMessage(
    chatId: string,
    userId: string,
    role: "user" | "assistant",
    text: string,
  ): void {
    this.db
      .query(
        "INSERT INTO messages (chat_id, user_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)",
      )
      .run(chatId, userId, role, text, Date.now());
  }

  getRecent(chatId: string, limit = 20): ChatMessage[] {
    return this.db
      .query(
        "SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(chatId, limit)
      .reverse() as ChatMessage[];
  }

  search(chatId: string, query: string, limit = 20): ChatMessage[] {
    return this.db
      .query(
        `SELECT m.* FROM messages m
         JOIN messages_fts f ON m.id = f.rowid
         WHERE m.chat_id = ? AND messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(chatId, query, limit) as ChatMessage[];
  }

  getStats(chatId: string): { total: number; first: number; last: number } {
    const row = this.db
      .query(
        "SELECT COUNT(*) as total, MIN(timestamp) as first, MAX(timestamp) as last FROM messages WHERE chat_id = ?",
      )
      .get(chatId) as { total: number; first: number; last: number } | null;
    return row ?? { total: 0, first: 0, last: 0 };
  }

  cleanup(maxAge = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const result = this.db
      .query("DELETE FROM messages WHERE timestamp < ?")
      .run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
