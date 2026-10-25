import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function requireText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

export class MemoryStore {
  constructor(filename) {
    if (!filename) throw new TypeError('A database filename is required');
    if (filename !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_recent
        ON messages(channel, conversation_id, id DESC);
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        channel TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    this.insertMessage = this.db.prepare(`
      INSERT INTO messages(channel, conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.readRecent = this.db.prepare(`
      SELECT channel, conversation_id AS conversationId, role, content, created_at AS createdAt
      FROM messages WHERE channel = ? AND conversation_id = ? ORDER BY id DESC LIMIT ?
    `);
    this.readAllRecent = this.db.prepare(`
      SELECT channel, conversation_id AS conversationId, role, content, created_at AS createdAt
      FROM messages ORDER BY id DESC LIMIT ?
    `);
    this.writeState = this.db.prepare(`
      INSERT INTO state(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `);
    this.readState = this.db.prepare('SELECT value_json AS valueJson FROM state WHERE key = ?');
    this.insertAction = this.db.prepare(`
      INSERT INTO actions(action, reason, channel, status, created_at) VALUES (?, ?, ?, ?, ?)
    `);
    this.readActions = this.db.prepare(`
      SELECT action, reason, channel, status, created_at AS createdAt
      FROM actions ORDER BY id DESC LIMIT ?
    `);
  }

  appendMessage({ channel, conversationId, role, content, createdAt = new Date().toISOString() }) {
    const cleanRole = requireText(role, 'role');
    if (!['user', 'assistant'].includes(cleanRole)) throw new TypeError('role must be user or assistant');
    this.insertMessage.run(
      requireText(channel, 'channel'),
      requireText(conversationId, 'conversationId'),
      cleanRole,
      String(content ?? ''),
      requireText(createdAt, 'createdAt'),
    );
  }

  recentMessages({ channel, conversationId, limit = 20 }) {
    const rows = this.readRecent.all(
      requireText(channel, 'channel'),
      requireText(conversationId, 'conversationId'),
      Math.max(1, Math.min(200, Math.floor(Number(limit) || 20))),
    );
    return rows.reverse();
  }

  recentAcrossChannels(limit = 20) {
    return this.readAllRecent.all(Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)))).reverse();
  }

  setState(key, value, updatedAt = new Date().toISOString()) {
    this.writeState.run(requireText(key, 'key'), JSON.stringify(value), requireText(updatedAt, 'updatedAt'));
  }

  getState(key, fallback = null) {
    const row = this.readState.get(requireText(key, 'key'));
    return row ? JSON.parse(row.valueJson) : fallback;
  }

  appendAction({ action, reason = '', channel = null, status = 'recorded', createdAt = new Date().toISOString() }) {
    this.insertAction.run(
      requireText(action, 'action'), String(reason), channel == null ? null : String(channel),
      requireText(status, 'status'), requireText(createdAt, 'createdAt'),
    );
  }

  recentActions(limit = 20) {
    return this.readActions.all(Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)))).reverse();
  }

  close() {
    this.db.close();
  }
}
