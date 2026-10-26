"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const FIELDS = ["sessions", "audioBytes", "ttsRequests", "ttsAudioBytes", "ttsChars", "sttSeconds", "previewTtsRequests"];

// Reservations are committed before contacting the provider. Failed requests remain
// reserved: the provider may already have billed them. No transcript/audio is stored.
class UsageStore {
  constructor(filename, limits = {}) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.limits = limits;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS usage (user TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user,day)); CREATE TABLE IF NOT EXISTS catalogs (kind TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revoked_users (user TEXT PRIMARY KEY, revoked_at TEXT NOT NULL);");
  }
  day() { return new Date().toISOString().slice(0, 10); }
  read(user, day = this.day()) {
    const row = this.db.prepare("SELECT data FROM usage WHERE user=? AND day=?").get(user, day);
    return { ...Object.fromEntries(FIELDS.map(f => [f, 0])), ...(row ? JSON.parse(row.data) : {}), date: day };
  }
  reserve(user, patch) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const day = this.day();
      const next = this.read(user, day);
      for (const [key, value] of Object.entries(patch)) {
        if (!FIELDS.includes(key) || !Number.isFinite(value) || value < 0) throw new Error("invalid reservation");
        next[key] += value;
        if (next[key] > (this.limits[key] ?? Infinity)) { this.db.exec("ROLLBACK"); return false; }
      }
      this.db.prepare("INSERT INTO usage(user,day,data) VALUES(?,?,?) ON CONFLICT(user,day) DO UPDATE SET data=excluded.data").run(user, day, JSON.stringify(next));
      this.db.exec("COMMIT");
      return true;
    } catch (err) { try { this.db.exec("ROLLBACK"); } catch {} throw err; }
  }
  isRevoked(user) { return Boolean(this.db.prepare("SELECT 1 FROM revoked_users WHERE user=?").get(user)); }
  revokeUser(user) { this.db.prepare("INSERT INTO revoked_users(user,revoked_at) VALUES(?,?) ON CONFLICT(user) DO NOTHING").run(user, new Date().toISOString()); }
  getCatalog(kind) { const row = this.db.prepare("SELECT data FROM catalogs WHERE kind=?").get(kind); return row ? JSON.parse(row.data) : null; }
  saveCatalog(kind, data) { this.db.prepare("INSERT INTO catalogs(kind,data) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data").run(kind, JSON.stringify(data)); }
  prune() { this.db.prepare("DELETE FROM usage WHERE day < ?").run(new Date(Date.now() - 32 * 86400000).toISOString().slice(0, 10)); }
  close() { this.db.close(); }
}
module.exports = { UsageStore };
