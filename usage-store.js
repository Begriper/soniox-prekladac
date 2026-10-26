"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const FIELDS = ["sessions", "audioBytes", "ttsRequests", "ttsAudioBytes", "ttsChars", "sttSeconds", "previewTtsRequests"];
const TOTALS = ["sttSeconds", "ttsChars", "ttsRequests", "ttsAudioBytes", "sessions"];
const emptyTotals = () => Object.fromEntries(TOTALS.map(key => [key, 0]));
const median = values => {
  values.sort((a, b) => a - b);
  const i = Math.floor(values.length / 2);
  return values.length ? Math.round(values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2) : null;
};

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
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversation_log (id TEXT PRIMARY KEY, username TEXT NOT NULL, started_at TEXT NOT NULL, duration_ms INTEGER, stt_seconds REAL, tts_chars INTEGER, tts_requests INTEGER, tts_audio_bytes INTEGER, language_a TEXT, language_b TEXT, profile TEXT, latency_median_ms INTEGER, end_code TEXT);
      CREATE INDEX IF NOT EXISTS conversation_log_started ON conversation_log(started_at);`);
    if (!this.db.prepare("PRAGMA table_info(users)").all().some(c => c.name === "webauthn_user_id")) this.db.exec("ALTER TABLE users ADD COLUMN webauthn_user_id TEXT");
    for (const row of this.db.prepare("SELECT username FROM users WHERE webauthn_user_id IS NULL").all()) this.db.prepare("UPDATE users SET webauthn_user_id=? WHERE username=?").run(randomBytes(16).toString("base64url"), row.username);
    this.db.exec(`CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, username TEXT NOT NULL, public_key TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, transports TEXT, label TEXT, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE INDEX IF NOT EXISTS passkeys_username ON passkeys(username);`);
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
    this.statement("INSERT INTO users(username,role,password_hash,created_at,limits_json,note,webauthn_user_id) VALUES(?,?,?,?,?,?,?)").run(username, role, passwordHash, new Date().toISOString(), this.limitsJson(limits), note, randomBytes(16).toString("base64url"));
    return this.getUser(username);
  }
  limitsJson(limits) {
    if (limits == null) return null;
    if (typeof limits !== "object" || Array.isArray(limits)) throw new Error("Invalid limits");
    for (const [key, value] of Object.entries(limits)) if (![...FIELDS.filter(f => f !== "previewTtsRequests"), "sttSecondsMonth"].includes(key) || !Number.isFinite(value) || value < 0 || value > 1e12) throw new Error("Invalid limits");
    return JSON.stringify(limits);
  }
  limitsFor(username) { return { ...this.limits, ...JSON.parse(this.getUser(username)?.limits_json || "{}") }; }
  passkeys(username) { return this.statement("SELECT id,label,created_at,last_used_at FROM passkeys WHERE username=? ORDER BY created_at,id").all(username); }
  getPasskey(id) { return this.statement("SELECT * FROM passkeys WHERE id=?").get(id); }
  deletePasskeys(username) { return this.statement("DELETE FROM passkeys WHERE username=?").run(username).changes; }
  setPasswordHash(username, hash) { return this.statement("UPDATE users SET password_hash=? WHERE username=?").run(hash, username).changes > 0; }
  setDisabled(username, disabled) {
    const at = new Date().toISOString();
    // A savepoint also works inside the admin API's audit transaction.
    this.db.exec("SAVEPOINT set_disabled");
    try {
      // Keep an enabled administrator even when this method is used outside HTTP routes.
      const changed = this.statement("UPDATE users SET disabled_at=? WHERE username=? AND (?=0 OR role!='admin' OR disabled_at IS NOT NULL OR (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled_at IS NULL)>1)").run(disabled ? at : null, username, Number(disabled)).changes > 0;
      // Mirrored into the v3.2 table so a rollback on the same volume still refuses the blocked code.
      if (changed && disabled) this.statement("INSERT INTO revoked_users(user,revoked_at) VALUES(?,?) ON CONFLICT(user) DO NOTHING").run(username, at);
      if (changed && disabled) this.deletePasskeys(username);
      if (changed && !disabled) this.statement("DELETE FROM revoked_users WHERE user=?").run(username);
      this.db.exec("RELEASE set_disabled");
      return changed;
    } catch (err) { try { this.db.exec("ROLLBACK TO set_disabled; RELEASE set_disabled"); } catch {} throw err; }
  }
  setLimits(username, limits) { return this.statement("UPDATE users SET limits_json=? WHERE username=?").run(this.limitsJson(limits), username).changes > 0; }
  setRole(username, role) {
    return this.statement("UPDATE users SET role=? WHERE username=? AND (?='admin' OR role!='admin' OR disabled_at IS NOT NULL OR (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled_at IS NULL)>1)").run(role, username, role).changes > 0;
  }
  deleteUser(username) {
    const user = this.getUser(username);
    if (!user || (user.role === "admin" && !user.disabled_at && this.countAdmins() <= 1)) return false;
    const anonymous = "deleted-" + createHash("sha256").update(username + user.created_at).digest("hex").slice(0, 8);
    // Merge even an unlikely anonymous-id collision so historical totals survive.
    for (const row of this.statement("SELECT day,data FROM usage WHERE user=?").all(username)) {
      const data = JSON.parse(row.data), previous = this.read(anonymous, row.day);
      for (const key of FIELDS) previous[key] += data[key] || 0;
      this.statement("INSERT INTO usage(user,day,data) VALUES(?,?,?) ON CONFLICT(user,day) DO UPDATE SET data=excluded.data").run(anonymous, row.day, JSON.stringify(previous));
    }
    this.statement("DELETE FROM usage WHERE user=?").run(username);
    this.statement("UPDATE conversation_log SET username=? WHERE username=?").run(anonymous, username);
    this.deleteUserSessions(username);
    this.deletePasskeys(username);
    // A leftover legacy revocation would block a future account of the same name on the next start.
    this.statement("DELETE FROM revoked_users WHERE user=?").run(username);
    this.statement("DELETE FROM users WHERE username=?").run(username);
    return true;
  }
  userSessions(username) { return this.statement("SELECT created_at,last_seen_at,device FROM auth_sessions WHERE username=? AND expires_at>? ORDER BY created_at DESC").all(username, Date.now()); }
  recordConversation(username, summary) {
    this.statement("INSERT INTO conversation_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(summary.id, username, summary.started_at, summary.duration_ms, summary.stt_seconds, summary.tts_chars, summary.tts_requests, summary.tts_audio_bytes, summary.language_a, summary.language_b, summary.profile, summary.latency_median_ms, summary.end_code);
  }
  usageRows(from, to, username) {
    return username === undefined ? this.statement("SELECT user,day,data FROM usage WHERE day>=? AND day<=? ORDER BY day,user").all(from, to) : this.statement("SELECT user,day,data FROM usage WHERE day>=? AND day<=? AND user=? ORDER BY day,user").all(from, to, username);
  }
  monthUsage(username) {
    const result = { sttSeconds: 0, ttsAudioBytes: 0, ttsChars: 0, sessions: 0 }, today = this.day();
    for (const row of this.usageRows(today.slice(0, 7) + "-01", today, username)) {
      const data = JSON.parse(row.data);
      for (const key of Object.keys(result)) result[key] += data[key] || 0;
    }
    return result;
  }
  analyzeUsage(from, to, username, prices) {
    const totals = emptyTotals(), users = new Map();
    const cost = data => Math.round((data.sttSeconds / 3600 * prices.stt + data.ttsAudioBytes / 48000 / 3600 * prices.tts) * 100) / 100;
    const days = this.usageRows(from, to, username).map(row => {
      const data = JSON.parse(row.data), values = emptyTotals();
      if (!users.has(row.user)) users.set(row.user, emptyTotals());
      for (const key of TOTALS) { values[key] = data[key] || 0; totals[key] += values[key]; users.get(row.user)[key] += values[key]; }
      return { day: row.day, username: row.user, ...values };
    });
    const sql = "SELECT * FROM conversation_log WHERE started_at>=? AND started_at<?";
    const after = new Date(Date.parse(to + "T00:00:00Z") + 86400000).toISOString();
    const rows = username === undefined ? this.statement(sql).all(from + "T00:00:00.000Z", after) : this.statement(sql + " AND username=?").all(from + "T00:00:00.000Z", after, username);
    const languages = new Map(), profiles = new Map();
    for (const row of rows) {
      const pair = row.language_a + "-" + row.language_b;
      languages.set(pair, (languages.get(pair) || 0) + 1); profiles.set(row.profile, (profiles.get(row.profile) || 0) + 1);
    }
    return { from, to, days, totals: { ...totals, estimated_usd: cost(totals) }, by_user: [...users].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => ({ username: name, ...data, estimated_usd: cost(data) })), conversations: {
      count: rows.length, avg_duration_ms: rows.length ? Math.round(rows.reduce((n, row) => n + row.duration_ms, 0) / rows.length) : null,
      languages: [...languages].map(([pair, count]) => ({ pair, count })), profiles: [...profiles].map(([profile, count]) => ({ profile, count })),
      latency_median_ms: median(rows.map(row => row.latency_median_ms).filter(Number.isFinite)),
    } };
  }
  listAudit(limit) { return this.statement("SELECT * FROM audit_log ORDER BY at DESC,rowid DESC LIMIT ?").all(limit); }
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
  // Every account keeps at most `max` logins; the least recently used ones are signed out first.
  trimUserSessions(username, max) { this.statement("DELETE FROM auth_sessions WHERE id_hash IN (SELECT id_hash FROM auth_sessions WHERE username=? ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?)").run(username, max); }
  audit(actor, action, target = null, detail = null) { this.statement("INSERT INTO audit_log(at,actor,action,target,detail_json) VALUES(?,?,?,?,?)").run(new Date().toISOString(), actor, action, target, detail == null ? null : JSON.stringify(detail)); }
  // Runs on every start: revocations made by an older release (for example after a rollback) are applied
  // again; unblocking removes the legacy row, so this never undoes an unblock.
  migrateRevokedUsers() {
    this.db.exec(`DELETE FROM passkeys WHERE username IN (SELECT user FROM revoked_users);
      DELETE FROM auth_sessions WHERE username IN (SELECT username FROM users WHERE disabled_at IS NULL AND username IN (SELECT user FROM revoked_users));
      UPDATE users SET disabled_at=(SELECT revoked_at FROM revoked_users WHERE user=users.username) WHERE disabled_at IS NULL AND username IN (SELECT user FROM revoked_users);`);
  }
  clearLegacyRevocation(username) { this.statement("DELETE FROM revoked_users WHERE user=?").run(username); }
  getCatalog(kind) { const row = this.db.prepare("SELECT data FROM catalogs WHERE kind=?").get(kind); return row ? JSON.parse(row.data) : null; }
  saveCatalog(kind, data) { this.db.prepare("INSERT INTO catalogs(kind,data) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data").run(kind, JSON.stringify(data)); }
  prune() {
    const day = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    this.statement("DELETE FROM usage WHERE day < ?").run(day);
    this.statement("DELETE FROM conversation_log WHERE started_at < ?").run(day + "T00:00:00.000Z");
  }
  close() { this.db.close(); }
}
module.exports = { UsageStore };
