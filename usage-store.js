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
    this.db.exec(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('admin','user')), password_hash TEXT NOT NULL, created_at TEXT NOT NULL, disabled_at TEXT, last_login_at TEXT, limits_json TEXT, note TEXT);
      CREATE TABLE IF NOT EXISTS auth_sessions (id_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, device TEXT);
      CREATE INDEX IF NOT EXISTS auth_sessions_username ON auth_sessions(username);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS audit_log (at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail_json TEXT);`);
    this.statements = new Map();
    if (this.listUsers().length) this.migrateRevokedUsers();
  }
  statement(sql) { if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql)); return this.statements.get(sql); }
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
      const limits = this.limitsFor(user);
      for (const [key, value] of Object.entries(patch)) {
        if (!FIELDS.includes(key) || !Number.isFinite(value) || value < 0) throw new Error("invalid reservation");
        next[key] += value;
        if (next[key] > (limits[key] ?? Infinity)) { this.db.exec("ROLLBACK"); return false; }
      }
      if (limits.sttSecondsMonth !== undefined && patch.sttSeconds) {
        const month = day.slice(0, 7);
        const total = this.statement("SELECT COALESCE(SUM(json_extract(data,'$.sttSeconds')),0) AS seconds FROM usage WHERE user=? AND day>=? AND day<?").get(user, month + "-01", month + "-32").seconds;
        if (total + patch.sttSeconds > limits.sttSecondsMonth) { this.db.exec("ROLLBACK"); return false; }
      }
      this.db.prepare("INSERT INTO usage(user,day,data) VALUES(?,?,?) ON CONFLICT(user,day) DO UPDATE SET data=excluded.data").run(user, day, JSON.stringify(next));
      this.db.exec("COMMIT");
      return true;
    } catch (err) { try { this.db.exec("ROLLBACK"); } catch {} throw err; }
  }
  getUser(username) { return this.statement("SELECT * FROM users WHERE username=?").get(username); }
  listUsers() { return this.statement("SELECT * FROM users ORDER BY username").all(); }
  createUser({ username, role, passwordHash, limits = null, note = null }) {
    this.statement("INSERT INTO users(username,role,password_hash,created_at,limits_json,note) VALUES(?,?,?,?,?,?)").run(username, role, passwordHash, new Date().toISOString(), this.limitsJson(limits), note);
    return this.getUser(username);
  }
  limitsJson(limits) {
    if (limits == null) return null;
    if (typeof limits !== "object" || Array.isArray(limits)) throw new Error("Invalid limits");
    for (const [key, value] of Object.entries(limits)) if (![...FIELDS, "sttSecondsMonth"].includes(key) || !Number.isFinite(value) || value < 0) throw new Error("Invalid limits");
    return JSON.stringify(limits);
  }
  limitsFor(username) { return { ...this.limits, ...JSON.parse(this.getUser(username)?.limits_json || "{}") }; }
  setPasswordHash(username, hash) { return this.statement("UPDATE users SET password_hash=? WHERE username=?").run(hash, username).changes > 0; }
  setDisabled(username, disabled) {
    // Keep an enabled administrator even when this method is used outside HTTP routes.
    return this.statement("UPDATE users SET disabled_at=? WHERE username=? AND (?=0 OR role!='admin' OR disabled_at IS NOT NULL OR (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled_at IS NULL)>1)").run(disabled ? new Date().toISOString() : null, username, Number(disabled)).changes > 0;
  }
  setLimits(username, limits) { return this.statement("UPDATE users SET limits_json=? WHERE username=?").run(this.limitsJson(limits), username).changes > 0; }
  touchLogin(username) { this.statement("UPDATE users SET last_login_at=? WHERE username=?").run(new Date().toISOString(), username); }
  countAdmins() { return this.statement("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled_at IS NULL").get().count; }
  createSession({ idHash, username, expiresAt, device = null }) {
    const now = Date.now();
    this.statement("INSERT INTO auth_sessions(id_hash,username,created_at,expires_at,last_seen_at,device) VALUES(?,?,?,?,?,?)").run(idHash, username, new Date(now).toISOString(), expiresAt, now, device);
  }
  getSession(idHash) { return this.statement("SELECT * FROM auth_sessions WHERE id_hash=?").get(idHash); }
  touchSession(idHash, now = Date.now()) { this.statement("UPDATE auth_sessions SET last_seen_at=? WHERE id_hash=?").run(now, idHash); }
  deleteSession(idHash) { this.statement("DELETE FROM auth_sessions WHERE id_hash=?").run(idHash); }
  deleteUserSessions(username) { this.statement("DELETE FROM auth_sessions WHERE username=?").run(username); }
  pruneSessions(now = Date.now()) { this.statement("DELETE FROM auth_sessions WHERE expires_at<=?").run(now); }
  countSessions() { return this.statement("SELECT COUNT(*) AS count FROM auth_sessions").get().count; }
  audit(actor, action, target = null, detail = null) { this.statement("INSERT INTO audit_log(at,actor,action,target,detail_json) VALUES(?,?,?,?,?)").run(new Date().toISOString(), actor, action, target, detail == null ? null : JSON.stringify(detail)); }
  migrateRevokedUsers() {
    if (this.getCatalog("revoked_users_migrated")) return;
    this.db.exec("UPDATE users SET disabled_at=COALESCE(disabled_at,(SELECT revoked_at FROM revoked_users WHERE user=users.username)) WHERE username IN (SELECT user FROM revoked_users)");
    this.saveCatalog("revoked_users_migrated", true);
  }
  getCatalog(kind) { const row = this.db.prepare("SELECT data FROM catalogs WHERE kind=?").get(kind); return row ? JSON.parse(row.data) : null; }
  saveCatalog(kind, data) { this.db.prepare("INSERT INTO catalogs(kind,data) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data").run(kind, JSON.stringify(data)); }
  prune() { this.statement("DELETE FROM usage WHERE day < ?").run(new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)); }
  close() { this.db.close(); }
}
module.exports = { UsageStore };
