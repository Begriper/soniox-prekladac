"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { fixture, until, CODE } = require("./helpers/mock-runtime.cjs");
const { UsageStore } = require("../usage-store");
const { SpeechSession } = require("../speech-session");
const { backup } = require("../backup-db");

const FAMILY = "family-test-access-123456";
const login = (f, body) => f.request("/api/login", body);

test("successful logins never use up the account budget, failures do", async t => {
  const f = await fixture({ env: { MAX_LOGIN_ATTEMPTS: "1000" } }); t.after(f.close);
  for (let i = 0; i < 12; i++) assert.equal((await login(f, { username: "family", password: FAMILY })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await login(f, { username: "family", password: "wrong-password-" + i })).status, 401);
  assert.equal((await login(f, { username: "family", password: "wrong-again" })).status, 429);
  assert.equal((await login(f, { username: "family", password: FAMILY })).status, 429, "the account stays locked for a while");
  assert.equal((await login(f, { username: "owner", password: CODE })).status, 200, "other accounts are unaffected");
});

test("code-only login attempts share one small budget across all accounts", async t => {
  const f = await fixture({ env: { MAX_LOGIN_ATTEMPTS: "1000" } }); t.after(f.close);
  for (let i = 0; i < 10; i++) assert.equal((await login(f, { code: "guess-number-" + i })).status, 401);
  assert.equal((await login(f, { code: "guess-again" })).status, 429);
  assert.equal((await login(f, { username: "family", password: FAMILY })).status, 200, "named logins are separate");
});

test("a flood of failures cannot lock the owner's break-glass code out", async t => {
  const f = await fixture({ env: { MAX_LOGIN_ATTEMPTS: "1000", MAX_LOGIN_FAILURES_TOTAL: "2" } }); t.after(f.close);
  for (const name of ["a", "b"]) await login(f, { username: name, password: "nothing-here-123" });
  assert.equal((await login(f, { username: "family", password: FAMILY })).status, 429);
  assert.equal((await login(f, { username: "owner", password: CODE })).status, 200);
});

test("failed logins are logged without a readable name or IP", async t => {
  const lines = []; t.mock.method(console, "log", line => lines.push(String(line)));
  const f = await fixture({ env: { LOG_EVENTS: "true" } }); t.after(f.close);
  await login(f, { username: "family", password: "wrong-password-1" });
  const entry = JSON.parse(lines.find(l => l.includes("login_failed")));
  assert.match(entry.user, /^[0-9a-f]{8}$/); assert.match(entry.ip, /^[0-9a-f]{8}$/);
  assert.ok(!lines.join("\n").includes("family") && !lines.join("\n").includes("127.0.0.1"));
  await login(f, { code: FAMILY });
  const success = JSON.parse(lines.find(l => l.includes('"event":"login"')));
  assert.equal(success.method, "code_only", "old code-only logins are visible in the log");
});

test("household-wide daily ceilings and the default monthly cap hold", () => {
  const store = new UsageStore(":memory:", { sttSeconds: 1e9, sttSecondsMonth: 100 }, { sttSeconds: 150, ttsChars: 10 });
  for (const name of ["a", "b"]) store.createUser({ username: name, role: "user", passwordHash: "x" });
  assert.equal(store.reserve("a", { sttSeconds: 90 }), true);
  assert.equal(store.reserve("a", { sttSeconds: 20 }), false, "monthly cap of the account");
  assert.equal(store.reserve("b", { sttSeconds: 70 }), false, "household ceiling: 90 + 70 > 150");
  assert.equal(store.reserve("b", { sttSeconds: 60 }), true);
  assert.equal(store.reserve("b", { ttsChars: 11 }), false);
  store.close();
});

test("a refused conversation says which limit ran out and when it resets", async t => {
  // Codex review 2026-11: an exhausted monthly cap promised a reset at midnight, but it lasts until the next month.
  const f = await fixture({ env: { MAX_TOTAL_STT_MINUTES_PER_DAY: "1" } }); t.after(f.close);
  const store = f.runtime.store;
  assert.equal(store.reserve("owner", { sttSeconds: 1 }), true); assert.equal(store.lastRefusal, null);
  const refused = async () => {
    const ws = await f.connect(await f.login());
    await until(() => ws.messages.some(m => m.type === "error" && m.fatal));
    return ws.messages.find(m => m.type === "error" && m.fatal);
  };
  store.setLimits("owner", { sttSecondsMonth: 5 });
  let error = await refused();
  assert.equal(error.code, "quota_exceeded"); assert.match(error.message, /Mesačný limit/); assert.doesNotMatch(error.message, /polnoci/);
  store.setLimits("owner", { sttSeconds: 5 });
  error = await refused();
  assert.match(error.message, /Denný limit tohto účtu/);
  store.setLimits("owner", null);
  store.record("family", { sttSeconds: 60 });
  error = await refused();
  assert.match(error.message, /celej domácnosti/);
});

test("replay checks the voice quota before paying and records what was already paid", async t => {
  const f = await fixture(); t.after(f.close);
  const cookie = await f.login();
  f.runtime.store.statement("UPDATE users SET limits_json=? WHERE username=?").run(JSON.stringify({ ttsAudioBytes: 1 }), "owner");
  const body = { text: "Ahoj.", language: "sk", voice: "Adrian" };
  assert.equal((await f.request("/api/replay", body, cookie)).status, 200, "paid audio is delivered");
  assert.ok(f.runtime.store.read("owner", f.runtime.store.day()).ttsAudioBytes > 1, "and recorded above the limit");
  assert.equal((await f.request("/api/replay", body, cookie)).status, 429);
  assert.equal(f.rest.length, 1, "no second paid synthesis");
});

test("malformed and oversized requests get client errors, not 503", async t => {
  const f = await fixture(); t.after(f.close);
  const post = body => fetch(f.url + "/api/login", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body });
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post(JSON.stringify({ code: "x".repeat(20000) }))).status, 413);
});

test("microphone bytes are reserved in batches, and the rest is recorded at the end", t => {
  const client = new EventEmitter(); client.readyState = 1; client.bufferedAmount = 0;
  client.send = () => {}; client.ping = () => {}; client.terminate = () => {}; client.close = () => {};
  const reserved = [], recorded = [];
  const s = new SpeechSession(client, {
    auth: { id: "a", username: "owner", expiresAt: Date.now() + 3600000 }, ip: "127.0.0.1",
    store: { reserve: (_u, patch) => { reserved.push(patch); return true; }, record: (_u, patch) => recorded.push(patch) },
    catalog: { hasLanguage: () => true }, urls: { ttsWs: "ws://127.0.0.1:1" },
    limits: { sessionMs: 3600000, idleMs: 3600000, sessionAudioBytes: 1e9, sessionTtsRequests: 120 }, endpoint: { delay: 1500, level: 0, sensitivity: 0 }, transport: "rest",
  });
  clearTimeout(s.configTimer); s.configured = true; s.acceptAudio = true;
  s.stt = { readyState: 1, bufferedAmount: 0, send() {}, terminate() {} };
  for (let i = 0; i < 100; i++) s.audio(Buffer.alloc(2048));
  const audioReservations = reserved.filter(p => p.audioBytes);
  assert.ok(audioReservations.length <= 4, "not one transaction per frame (" + audioReservations.length + ")");
  s.close();
  const total = [...audioReservations, ...recorded].reduce((n, p) => n + p.audioBytes, 0);
  assert.equal(total, 100 * 2048, "every byte is accounted for");
});

test("the backup script writes a consistent copy and keeps the newest seven", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translator-backup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage.sqlite");
  const store = new UsageStore(file); store.createUser({ username: "family", role: "user", passwordHash: "x" }); store.close();
  fs.mkdirSync(path.join(dir, "backups"));
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, "backups", "usage-2026-01-0" + (i + 1) + ".sqlite"), "");
  const copy = backup(file);
  const db = new DatabaseSync(copy);
  assert.equal(db.prepare("SELECT username FROM users").get().username, "family"); db.close();
  assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 7);
  assert.ok(fs.existsSync(copy));
});

test("a shutdown tells running conversations to reconnect", async t => {
  const f = await fixture(); let closed = false; t.after(() => closed || f.close());
  const ws = await f.connect(await f.login());
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const closing = f.close(); closed = true;
  await until(() => ws.messages.some(m => m.code === "server_restart"));
  await closing;
});

test("parallel wrong passwords cannot run past the account budget", async t => {
  const f = await fixture({ env: { MAX_LOGIN_ATTEMPTS: "1000" } }); t.after(f.close);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => login(f, { username: "family", password: "parallel-wrong-" + i })));
  const checked = results.filter(r => r.status === 401).length;
  assert.ok(checked <= 10, checked + " passwords were checked");
  assert.equal(results.filter(r => r.status === 429).length, 30 - checked);
});

test("audio sent after the quota ran out is still recorded", t => {
  const client = new EventEmitter(); client.readyState = 1; client.bufferedAmount = 0;
  client.send = () => {}; client.ping = () => {}; client.terminate = () => {}; client.close = () => {};
  const recorded = []; let allowed = 1;
  const s = new SpeechSession(client, {
    auth: { id: "a", username: "owner", expiresAt: Date.now() + 3600000 }, ip: "127.0.0.1",
    store: { reserve: (_u, patch) => !patch.audioBytes || allowed-- > 0, record: (_u, patch) => recorded.push(patch) },
    catalog: { hasLanguage: () => true }, urls: { ttsWs: "ws://127.0.0.1:1" },
    limits: { sessionMs: 3600000, idleMs: 3600000, sessionAudioBytes: 1e9, sessionTtsRequests: 120 }, endpoint: { delay: 1500, level: 0, sensitivity: 0 }, transport: "rest",
  });
  clearTimeout(s.configTimer); s.configured = true; s.acceptAudio = true;
  s.stt = { readyState: 1, bufferedAmount: 0, send() {}, terminate() {} };
  for (let i = 0; i < 70; i++) s.audio(Buffer.alloc(2048));
  s.close();
  assert.ok(recorded.reduce((n, p) => n + p.audioBytes, 0) > 0, "the refused batch is recorded at the end");
});
