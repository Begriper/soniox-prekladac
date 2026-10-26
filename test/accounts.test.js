const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const WebSocket = require("ws");
const { UsageStore } = require("../usage-store");
const { hashPassword, verifyPassword } = require("../passwords");
const { fixture, until, CODE } = require("./helpers/mock-runtime.cjs");
const FAMILY = "family-test-access-123456";
function database(t, close) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translator-accounts-test-"));
  t.after(async () => {
    await close();
    for (const name of ["test.sqlite", "test.sqlite-wal", "test.sqlite-shm"]) {
      const file = path.join(dir, name); if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(dir);
  });
  return path.join(dir, "test.sqlite");
}
test("bootstrap imports salted passwords and roles once, with secret-free audit", async t => {
  const f = await fixture(); t.after(() => f.close());
  const store = f.runtime.store, rows = store.listUsers();
  assert.deepEqual(rows.map(u => [u.username, u.role]), [["family", "user"], ["owner", "admin"]]);
  assert.equal(await verifyPassword(FAMILY, store.getUser("family").password_hash), true);
  assert.equal(await verifyPassword(CODE, store.getUser("owner").password_hash), true);
  const audit = store.db.prepare("SELECT * FROM audit_log").all();
  assert.equal(audit.length, 2); assert.ok(audit.every(r => r.action === "bootstrap_import"));
  assert.ok(!JSON.stringify(audit).includes(CODE));
  const single = await fixture({ env: { APP_ACCESS_CODES: "solo:" + CODE, APP_OWNER_USERNAME: "" } }); t.after(() => single.close());
  assert.equal(single.runtime.store.getUser("solo").role, "admin");
});
test("username/password and legacy logins expose roles; invalid credentials share one error", async t => {
  const f = await fixture(); t.after(() => f.close());
  const family = await f.login("family", FAMILY);
  const info = await (await f.request("/api/session", undefined, family)).json();
  assert.equal(info.username, "family"); assert.equal(info.role, "user");
  assert.ok(f.runtime.store.getUser("family").last_login_at);
  const legacy = await f.request("/api/login", { code: FAMILY });
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).role, "user");
  const wrong = await f.request("/api/login", { username: "family", password: "incorrect password" });
  const unknown = await f.request("/api/login", { username: "nobody", password: "incorrect password" });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});
test("per-username limiter applies in addition to the IP limiter", async t => {
  const f = await fixture({ env: { MAX_LOGIN_ATTEMPTS: "50" } }); t.after(() => f.close());
  for (let i = 0; i < 10; i++) assert.equal((await f.request("/api/login", { username: "family", password: "incorrect password" })).status, 401);
  assert.equal((await f.request("/api/login", { username: "family", password: FAMILY })).status, 429);
  assert.equal((await f.request("/api/login", { username: "owner", password: CODE })).status, 200);
});
test("a database admin can disable users, deleting every login and ending live speech", async t => {
  const f = await fixture(); t.after(() => f.close());
  const store = f.runtime.store;
  store.createUser({ username: "manager", role: "admin", passwordHash: await hashPassword("manager-password-123") });
  const manager = await f.login("manager", "manager-password-123"), family = await f.login("family", FAMILY), second = await f.login("family", FAMILY);
  const ws = await f.connect(family); await until(() => ws.messages.some(m => m.type === "server_ready"));
  assert.equal([...f.runtime.conversations.values()][0].auth.role, "user");
  assert.equal((await f.request("/api/admin/users", undefined, family)).status, 403);
  assert.equal((await f.request("/api/admin/users", undefined, manager)).status, 200);
  assert.equal((await f.request("/api/admin/users/manager/revoke", {}, manager)).status, 400);
  assert.equal((await f.request("/api/admin/users/family/revoke", {}, manager)).status, 200);
  await until(() => ws.readyState === WebSocket.CLOSED);
  for (const cookie of [family, second]) assert.equal((await f.request("/api/session", undefined, cookie)).status, 401);
  for (const body of [{ username: "family", password: FAMILY }, { code: FAMILY }]) {
    const res = await f.request("/api/login", body); assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "Nesprávne meno alebo heslo, alebo je účet zablokovaný.");
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE username='family'").get().n, 0);
  assert.equal(store.db.prepare("SELECT actor FROM audit_log WHERE action='disable_user'").get().actor, "manager");
});
test("disable cancels a voice preview while the provider is still working", async t => {
  const f = await fixture(); t.after(() => f.close());
  const owner = await f.login(), family = await f.login("family", FAMILY);
  f.state.restDelay = 100;
  const preview = f.request("/api/preview-voice", { language: "sk", voice: "Adrian" }, family);
  await until(() => f.state.rest.length === 1);
  assert.equal((await f.request("/api/admin/users/family/revoke", {}, owner)).status, 200);
  assert.equal((await preview).status, 401);
});
test("sessions persist hashed across application recreation; bootstrap does not overwrite passwords", async t => {
  let f;
  const db = database(t, async () => { if (f) await f.close(); });
  f = await fixture({ db });
  f.runtime.store.setPasswordHash("family", await hashPassword("new-family-password"));
  const cookie = await f.login("family", "new-family-password");
  const id = cookie.split("=")[1].split(".")[0], hash = crypto.createHash("sha256").update(id).digest("hex");
  const row = f.runtime.store.getSession(hash);
  assert.equal(row.id_hash.length, 64); assert.equal(f.runtime.store.getSession(id), undefined);
  assert.ok(row.device.length <= 120); assert.ok(row.expires_at > Date.now() + 29 * 86400000);
  await f.close(); f = null;
  f = await fixture({ db, env: { APP_ACCESS_CODES: "owner:" + CODE + ",family:changed-env-code-123456" } });
  assert.equal((await f.request("/api/session", undefined, cookie)).status, 200);
  assert.equal(f.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='bootstrap_import'").get().n, 2);
  assert.equal((await f.request("/api/login", { username: "family", password: "new-family-password" })).status, 200);
  assert.equal((await f.request("/api/login", { code: FAMILY })).status, 401);
  const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
  assert.equal((await f.request("/api/session", undefined, tampered)).status, 401);
  f.runtime.store.db.prepare("UPDATE auth_sessions SET expires_at=? WHERE id_hash=?").run(Date.now() - 1, hash);
  assert.equal((await f.request("/api/session", undefined, cookie)).status, 401);
  assert.equal(f.runtime.store.getSession(hash), undefined);
});
test("legacy revocations migrate once after bootstrap and never undo an unblock", async t => {
  let f;
  const db = database(t, async () => { if (f) await f.close(); }), old = new UsageStore(db);
  old.db.prepare("INSERT INTO revoked_users VALUES(?,?)").run("family", "2026-01-01T00:00:00.000Z"); old.close();
  f = await fixture({ db });
  assert.equal(f.runtime.store.getUser("family").disabled_at, "2026-01-01T00:00:00.000Z");
  assert.equal((await f.request("/api/login", { code: FAMILY })).status, 401);
  f.runtime.store.setDisabled("family", false);
  await f.close(); f = null; f = await fixture({ db });
  assert.equal(f.runtime.store.getUser("family").disabled_at, null);
  assert.equal((await f.request("/api/login", { username: "family", password: FAMILY })).status, 200);
});
test("owner env code restores a disabled or missing admin after its DB password changes", async t => {
  const f = await fixture(); t.after(() => f.close());
  const store = f.runtime.store;
  store.createUser({ username: "manager", role: "admin", passwordHash: await hashPassword("manager-password-123") });
  store.setPasswordHash("owner", await hashPassword("different-owner-password"));
  assert.equal(store.setDisabled("owner", true), true);
  assert.equal((await f.request("/api/login", { username: "owner", password: "different-owner-password" })).status, 401);
  for (const body of [{ username: "owner", password: CODE }, { code: CODE }]) {
    store.setDisabled("owner", true);
    const res = await f.request("/api/login", body); assert.equal(res.status, 200); assert.equal((await res.json()).role, "admin");
    assert.equal(store.getUser("owner").disabled_at, null);
  }
  store.db.prepare("DELETE FROM users WHERE username='owner'").run();
  assert.equal((await f.request("/api/login", { username: "owner", password: CODE })).status, 200);
  assert.equal(store.getUser("owner").role, "admin");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='break_glass'").get().n, 3);
});
test("the last enabled admin and one's own account cannot be disabled", async t => {
  const f = await fixture(); t.after(() => f.close());
  const cookie = await f.login(), store = f.runtime.store;
  assert.equal(store.countAdmins(), 1); assert.equal(store.setDisabled("owner", true), false);
  assert.equal((await f.request("/api/admin/users/owner/revoke", {}, cookie)).status, 400);
  assert.equal(store.getUser("owner").disabled_at, null);
});
test("per-user daily and UTC monthly limits are atomic, inherited and reset at month boundaries", t => {
  const store = new UsageStore(":memory:", { sessions: 1, sttSeconds: 20, ttsChars: 10 }); t.after(() => store.close());
  store.createUser({ username: "family", role: "user", passwordHash: "unused", limits: { sessions: 2, sttSeconds: 10, sttSecondsMonth: 15 } });
  let day = "2026-10-01"; store.day = () => day;
  assert.deepEqual(store.limitsFor("family"), { sessions: 2, sttSeconds: 10, ttsChars: 10, sttSecondsMonth: 15 });
  assert.equal(store.reserve("other", { sessions: 2 }), false);
  assert.equal(store.reserve("family", { sessions: 2, sttSeconds: 10 }), true);
  assert.equal(store.reserve("family", { sttSeconds: 1 }), false);
  day = "2026-10-02";
  assert.equal(store.reserve("family", { sessions: 1, sttSeconds: 6 }), false);
  assert.equal(store.read("family").sessions, 0);
  assert.equal(store.reserve("family", { sttSeconds: 5 }), true);
  day = "2026-11-01";
  assert.equal(store.reserve("family", { sttSeconds: 10 }), true);
  assert.equal(store.reserve("family", { ttsChars: 11 }), false);
  store.setLimits("family", { sttSecondsMonth: 0 });
  assert.equal(store.reserve("family", { sttSeconds: 1 }), false);
  store.setLimits("family", null);
  assert.equal(store.reserve("family", { sttSeconds: 1 }), true);
  for (const limits of [{ sttSeconds: -1 }, { sessions: null }, { unknown: 5 }]) assert.throws(() => store.setLimits("family", limits));
});
test("usage retention keeps 400 days and session pruning removes only expired rows", t => {
  const store = new UsageStore(":memory:"); t.after(() => store.close());
  const before = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  for (const days of [32, 399, 400, 401]) store.db.prepare("INSERT INTO usage VALUES(?,?,?)").run("family", before(days), "{}");
  store.prune();
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 3);
  const now = Date.now();
  store.createSession({ idHash: "old", username: "family", expiresAt: now });
  store.createSession({ idHash: "new", username: "family", expiresAt: now + 10000 });
  store.pruneSessions(now); assert.equal(store.getSession("old"), undefined); assert.ok(store.getSession("new"));
});
test("logins are capped per account, so one account cannot lock out the owner", async t => {
  const f = await fixture(); t.after(() => f.close());
  for (let i = 0; i < 300; i++) f.runtime.store.createSession({ idHash: "h" + i, username: "family", expiresAt: Date.now() + 86400000 });
  assert.equal((await f.request("/api/login", { username: "family", password: FAMILY })).status, 200);
  assert.equal(f.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE username='family'").get().n, 10);
  assert.equal((await f.request("/api/login", { username: "owner", password: CODE })).status, 200);
});
test("blocking is mirrored for rollbacks and legacy revocations apply again on upgrade", async t => {
  let f;
  const db = database(t, async () => { if (f) await f.close(); });
  f = await fixture({ db });
  const owner = await f.login();
  assert.equal((await f.request("/api/admin/users/family/revoke", {}, owner)).status, 200);
  assert.ok(f.runtime.store.db.prepare("SELECT 1 FROM revoked_users WHERE user='family'").get(), "v3.2 still sees the block");
  f.runtime.store.setDisabled("family", false);
  assert.equal(f.runtime.store.db.prepare("SELECT 1 FROM revoked_users WHERE user='family'").get(), undefined);
  const cookie = (await f.request("/api/login", { username: "family", password: FAMILY })).headers.get("set-cookie").split(";")[0];
  await f.close();
  // An older release revoked the account while rolled back on the same volume.
  const old = new UsageStore(db); old.db.prepare("INSERT INTO revoked_users VALUES(?,?)").run("family", "2026-02-01T00:00:00.000Z"); old.close();
  f = await fixture({ db });
  assert.ok(f.runtime.store.getUser("family").disabled_at);
  assert.equal((await f.request("/api/session", undefined, cookie)).status, 401);
});
