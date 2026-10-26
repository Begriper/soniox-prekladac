"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture, until } = require("./helpers/mock-runtime.cjs");
const { DatabaseSync } = require("node:sqlite");
const { UsageStore } = require("../usage-store");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const FAMILY = "family-test-access-123456", root = "/api/passkeys";
const hash = value => crypto.createHash("sha256").update(value).digest();
const b64 = value => Buffer.from(value).toString("base64url");
const sessionCookie = res => res.headers.getSetCookie().find(c => c.startsWith("sl_session=")).split(";")[0];
// A software platform authenticator: no CBOR parser or hardware is needed by these ceremonies.
function authenticator(alg = -7) {
  const pair = alg === -7 ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }) : crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const id = crypto.randomBytes(32).toString("base64url"), publicKey = b64(pair.publicKey.export({ type: "spki", format: "der" }));
  function response(options, origin, create, patch = {}) {
    const client = { type: create ? "webauthn.create" : "webauthn.get", challenge: options.challenge, origin, crossOrigin: false, ...patch.client };
    const clientData = Buffer.from(JSON.stringify(client)), auth = Buffer.alloc(37);
    hash(patch.rpId || options.rp?.id || options.rpId).copy(auth);
    auth[32] = patch.flags ?? (create ? 0x45 : 0x05); auth.writeUInt32BE(patch.count ?? 0, 33);
    const body = { id, rawId: id, type: "public-key", response: { clientDataJSON: b64(clientData), authenticatorData: b64(auth) } };
    if (create) Object.assign(body.response, { attestationObject: b64(Buffer.from([0xa0])), publicKey, publicKeyAlgorithm: alg, transports: ["internal"] });
    else Object.assign(body.response, { signature: b64(crypto.sign("sha256", Buffer.concat([auth, hash(clientData)]), pair.privateKey)), userHandle: options.userHandle });
    return body;
  }
  return { id, response, publicKey };
}
async function setup(t, env) {
  const f = await fixture({ env: { MAX_LOGIN_ATTEMPTS: "1000", ...env } }); t.after(() => f.close());
  f.owner = await f.login(); f.family = await f.login("family", FAMILY); return f;
}
async function registerOptions(f, cookie = f.family) {
  const res = await f.request(root + "/register/options", {}, cookie); assert.equal(res.status, 200); return res.json();
}
async function register(f, a = authenticator(), cookie = f.family, patch = {}) {
  const options = await registerOptions(f, cookie), body = a.response(options, f.origin, true, patch);
  const res = await f.request(root + "/register", { ...body, label: "Test phone" }, cookie); assert.equal(res.status, 200, await res.text());
  return a;
}
async function loginOptions(f, a, username = "family") {
  const res = await f.request(root + "/login/options", {}); assert.equal(res.status, 200);
  return { cookie: res.headers.get("set-cookie").split(";")[0], options: { ...await res.json(), userHandle: f.runtime.store.getUser(username).webauthn_user_id } };
}
async function login(f, a, patch = {}, username) {
  const { options, cookie } = await loginOptions(f, a, username);
  return f.request(root + "/login", a.response(options, f.origin, false, patch), cookie);
}
test("passkey registration and discoverable ES256 login issue a normal capped session", async t => {
  const f = await setup(t), store = f.runtime.store, a = authenticator();
  const options = await registerOptions(f);
  assert.deepEqual(options.rp, { id: "127.0.0.1", name: "Prekladač" });
  assert.equal(Buffer.from(options.user.id, "base64url").length, 16);
  assert.deepEqual(options.authenticatorSelection, { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" });
  assert.deepEqual(options.pubKeyCredParams.map(p => p.alg), [-7, -257]); assert.equal(options.attestation, "none");
  assert.equal((await f.request(root + "/register", { ...a.response(options, f.origin, true), label: "x".repeat(80) }, f.family)).status, 200);
  assert.equal(store.getPasskey(a.id).label.length, 60);
  assert.equal((await registerOptions(f)).excludeCredentials[0].id, a.id);
  for (let i = 0; i < 15; i++) store.createSession({ idHash: "extra-" + i, username: "family", expiresAt: Date.now() + 100000 });
  const pending = await loginOptions(f, a);
  assert.deepEqual(pending.options.allowCredentials, []); assert.equal(pending.options.userVerification, "required");
  const res = await f.request(root + "/login", a.response(pending.options, f.origin, false, { count: 1 }), pending.cookie);
  assert.equal(res.status, 200); const data = await res.json();
  assert.equal(data.authenticated, true); assert.equal(data.username, "family"); assert.equal(data.role, "user"); assert.equal(data.usage.user, "family");
  const cookie = sessionCookie(res); assert.match(res.headers.getSetCookie().find(c => c.startsWith("sl_session=")), /HttpOnly; SameSite=Strict; Max-Age=2592000/);
  assert.equal((await f.request("/api/session", undefined, cookie)).status, 200);
  assert.equal(store.userSessions("family").length, 10); assert.ok(store.getUser("family").last_login_at);
  assert.equal(store.getPasskey(a.id).sign_count, 1); assert.ok(store.getPasskey(a.id).last_used_at);
  const list = await (await f.request(root, undefined, cookie)).json();
  assert.deepEqual(Object.keys(list.passkeys[0]).sort(), ["created_at", "id", "label", "last_used_at"]);
  assert.equal((await (await f.request(root, undefined, f.owner)).json()).passkeys.length, 0);
  assert.equal(store.listAudit(1)[0].action, "passkey_login");
  assert.ok(!JSON.stringify(store.listAudit(20)).includes(a.publicKey));
});
test("RS256 registration and PKCS1 SHA256 login are supported", async t => {
  const f = await setup(t), a = await register(f, authenticator(-257));
  assert.equal((await login(f, a)).status, 200);
});
test("registration rejects wrong client data, rp hash, flags and malformed keys", async t => {
  const f = await setup(t), a = authenticator();
  for (const patch of [{ client: { origin: "https://evil.example" } }, { client: { type: "webauthn.get" } }, { client: { challenge: "wrong" } }, { client: { crossOrigin: true } }, { client: { topOrigin: f.origin } }, { rpId: "evil.example" }, { flags: 0x41 }, { flags: 0x44 }, { flags: 0x05 }, { flags: 0x55 }]) {
    const body = a.response(await registerOptions(f), f.origin, true, patch);
    assert.equal((await f.request(root + "/register", body, f.family)).status, 400, JSON.stringify(patch));
  }
  for (const patch of [{ publicKey: "bad" }, { publicKeyAlgorithm: -8 }, { publicKeyAlgorithm: -257 }, { authenticatorData: "YQ" }, { transports: "internal" }]) {
    const body = a.response(await registerOptions(f), f.origin, true); Object.assign(body.response, patch);
    assert.equal((await f.request(root + "/register", body, f.family)).status, 400);
  }
  const missing = a.response(await registerOptions(f), f.origin, true); delete missing.response.publicKey;
  const res = await f.request(root + "/register", missing, f.family); assert.equal(res.status, 400); assert.match((await res.json()).error, /Prehliadač/);
  assert.equal(f.runtime.store.passkeys("family").length, 0);
});
test("registration challenges are session-bound, single-use and replaced by newer options", async t => {
  const f = await setup(t), a = authenticator(), second = await f.login("family", FAMILY);
  const firstOptions = await registerOptions(f), body = a.response(firstOptions, f.origin, true);
  assert.equal((await f.request(root + "/register", body, second)).status, 400);
  assert.equal((await f.request(root + "/register", body, f.owner)).status, 400);
  assert.equal((await f.request(root + "/register", body, f.family)).status, 200);
  assert.equal((await f.request(root + "/register", body, f.family)).status, 400);
  const old = await registerOptions(f); await registerOptions(f);
  assert.equal((await f.request(root + "/register", authenticator().response(old, f.origin, true), f.family)).status, 400);
});
test("registration and login challenges expire after five minutes", async t => {
  const f = await setup(t), a = await register(f), registration = await registerOptions(f), pending = await loginOptions(f, a);
  const now = Date.now(); t.mock.method(Date, "now", () => now + 300001);
  assert.equal((await f.request(root + "/register", authenticator().response(registration, f.origin, true), f.family)).status, 400);
  assert.equal((await f.request(root + "/login", a.response(pending.options, f.origin, false), pending.cookie)).status, 400);
});
test("assertions reject bad origins, rp hashes, UV/UP, handles and signatures", async t => {
  const f = await setup(t), a = await register(f);
  for (const patch of [{ client: { origin: "https://evil.example" } }, { client: { type: "webauthn.create" } }, { client: { challenge: "wrong" } }, { client: { crossOrigin: true } }, { rpId: "evil.example" }, { flags: 1 }, { flags: 4 }]) {
    assert.equal((await login(f, a, patch)).status, 400, JSON.stringify(patch));
  }
  for (const patch of [{ userHandle: null }, { userHandle: f.runtime.store.getUser("owner").webauthn_user_id }, { signature: b64(crypto.randomBytes(70)) }, { authenticatorData: "YQ" }]) {
    const pending = await loginOptions(f, a), body = a.response(pending.options, f.origin, false); Object.assign(body.response, patch);
    assert.equal((await f.request(root + "/login", body, pending.cookie)).status, 400, JSON.stringify(patch));
  }
  assert.equal(f.runtime.store.getPasskey(a.id).last_used_at, null);
});
test("assertion challenge cookies are signed, client-bound and single-use even on failure", async t => {
  const f = await setup(t), a = await register(f), first = await loginOptions(f, a), second = await loginOptions(f, a);
  const body = a.response(first.options, f.origin, false);
  assert.equal((await f.request(root + "/login", body)).status, 400);
  assert.equal((await f.request(root + "/login", body, first.cookie + "x")).status, 400);
  assert.equal((await f.request(root + "/login", body, second.cookie)).status, 400);
  assert.equal((await f.request(root + "/login", body, first.cookie)).status, 200);
  assert.equal((await f.request(root + "/login", body, first.cookie)).status, 400);
  const third = await loginOptions(f, a), bad = a.response(third.options, f.origin, false, { flags: 1 });
  assert.equal((await f.request(root + "/login", bad, third.cookie)).status, 400);
  assert.equal((await f.request(root + "/login", a.response(third.options, f.origin, false), third.cookie)).status, 400);
});
test("nonzero counters must increase and can never be reset to zero", async t => {
  const f = await setup(t), a = await register(f, authenticator(), f.family, { count: 4 });
  for (const [count, status] of [[5, 200], [5, 400], [4, 400], [0, 400], [6, 200]]) assert.equal((await login(f, a, { count })).status, status);
  assert.equal(f.runtime.store.getPasskey(a.id).sign_count, 6);
});
test("zero-valued platform counters remain usable while they stay zero", async t => {
  const f = await setup(t), a = await register(f, authenticator(), f.family, { count: 0 });
  for (const count of [0, 0]) assert.equal((await login(f, a, { count })).status, 200);
  assert.equal(f.runtime.store.getPasskey(a.id).sign_count, 0);
});
test("unknown, disabled and deleted credentials cannot log in; users can delete only their own", async t => {
  const f = await setup(t), a = await register(f), unknown = await login(f, authenticator());
  assert.equal(unknown.status, 401); assert.equal((await unknown.json()).code, "unknown_credential");
  assert.equal((await f.request(root + "/" + a.id + "/delete", {}, f.owner)).status, 404);
  assert.ok(f.runtime.store.getPasskey(a.id));
  // Keep the credential to test the disabled-user guard independently of recovery removal.
  f.runtime.store.statement("UPDATE users SET disabled_at=? WHERE username='family'").run(new Date().toISOString());
  assert.equal((await login(f, a)).status, 400);
  f.runtime.store.statement("UPDATE users SET disabled_at=NULL WHERE username='family'").run();
  assert.equal((await f.request(root + "/" + a.id + "/delete", {}, f.family)).status, 200);
  assert.equal(f.runtime.store.getPasskey(a.id), undefined);
  assert.equal((await login(f, a)).status, 401);
  assert.equal(f.runtime.store.listAudit(1)[0].action, "delete_passkey");
});
test("max ten passkeys per user, including already issued registration options; ids are unique globally", async t => {
  const f = await setup(t), a = await register(f), pending = await registerOptions(f);
  const duplicate = a.response(await registerOptions(f, f.owner), f.origin, true);
  assert.equal((await f.request(root + "/register", duplicate, f.owner)).status, 400);
  for (let i = 1; i < 10; i++) await register(f);
  assert.equal((await f.request(root + "/register/options", {}, f.family)).status, 400);
  // A different logged-in session can hold options issued before the cap was reached.
  const second = await f.login("family", FAMILY);
  await f.request(root + "/" + a.id + "/delete", {}, f.family);
  const secondOptions = await registerOptions(f, second); await register(f);
  assert.equal((await f.request(root + "/register", authenticator().response(secondOptions, f.origin, true), second)).status, 400);
  assert.equal((await f.request(root + "/register", authenticator().response(pending, f.origin, true), f.family)).status, 400);
  assert.equal(f.runtime.store.passkeys("family").length, 10);
});
test("admin counts and recovery mutations remove passkeys with audited changes", async t => {
  const f = await setup(t), store = f.runtime.store;
  for (const action of ["passkeys/delete", "password", "disable", "delete"]) {
    f.family = await f.login("family", FAMILY); const a = await register(f);
    const users = await (await f.request("/api/admin/users", undefined, f.owner)).json();
    assert.equal(users.users.find(u => u.username === "family").passkeys, 1);
    const res = await f.request("/api/admin/users/family/" + action, action === "password" ? { password: FAMILY } : {}, f.owner);
    assert.equal(res.status, 200, action); assert.equal(store.getPasskey(a.id), undefined);
    const audit = store.listAudit(1)[0]; assert.equal(audit.actor, "owner"); assert.equal(JSON.parse(audit.detail_json).passkeys_deleted, 1);
    if (action === "disable") assert.equal((await f.request("/api/admin/users/family/enable", {}, f.owner)).status, 200);
  }
});
test("passkey administration and password reset roll back before ending live operations on audit failure", async t => {
  const f = await setup(t), a = await register(f), store = f.runtime.store;
  const ws = await f.connect(f.family); await until(() => ws.messages.some(m => m.type === "server_ready"));
  const original = store.audit; store.audit = () => { throw new Error("audit unavailable"); };
  for (const action of ["passkeys/delete", "password", "disable"]) {
    assert.equal((await f.request("/api/admin/users/family/" + action, {}, f.owner)).status, 503);
    assert.ok(store.getPasskey(a.id)); assert.equal(store.getUser("family").disabled_at, null);
    assert.equal((await f.request("/api/session", undefined, f.family)).status, 200); assert.equal(ws.readyState, 1);
  }
  store.audit = original;
});
test("registration, deletion and login session/counter updates roll back with failed audit", async t => {
  const f = await setup(t), a = await register(f), store = f.runtime.store, original = store.audit;
  const options = await registerOptions(f), fresh = authenticator(), pending = await loginOptions(f, a), previousSessions = store.userSessions("family").length;
  store.audit = () => { throw new Error("audit unavailable"); };
  assert.equal((await f.request(root + "/register", fresh.response(options, f.origin, true), f.family)).status, 503);
  assert.equal(store.getPasskey(fresh.id), undefined);
  assert.equal((await f.request(root + "/" + a.id + "/delete", {}, f.family)).status, 503); assert.ok(store.getPasskey(a.id));
  assert.equal((await f.request(root + "/login", a.response(pending.options, f.origin, false, { count: 5 }), pending.cookie)).status, 503);
  assert.equal(store.getPasskey(a.id).sign_count, 0); assert.equal(store.getPasskey(a.id).last_used_at, null);
  assert.equal(store.userSessions("family").length, previousSessions); store.audit = original;
});
test("passkey endpoints require sessions or valid same-origin requests; admin removal requires admin", async t => {
  const f = await setup(t);
  for (const [url, body] of [[root, undefined], [root + "/register/options", {}], [root + "/register", {}], [root + "/abc/delete", {}]]) assert.equal((await f.request(url, body)).status, 401);
  for (const cookie of [undefined, f.family]) assert.equal((await f.request("/api/admin/users/family/passkeys/delete", {}, cookie)).status, 403);
  const res = await fetch(f.url + root + "/login/options", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
});
test("login options and assertions share a per-IP rate limit and signed strict cookie", async t => {
  const f = await setup(t, { MAX_LOGIN_ATTEMPTS: "3" });
  const first = await f.request(root + "/login/options", {}); assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie"), /^sl_webauthn=[\w-]{43}\.[\w-]{43}; Path=\/api\/passkeys\/login; HttpOnly; SameSite=Strict; Max-Age=300/);
  assert.equal((await f.request(root + "/login", {})).status, 400);
  assert.equal((await f.request(root + "/login/options", {})).status, 200);
  assert.equal((await f.request(root + "/login/options", {})).status, 429);
  assert.equal((await f.request(root + "/login", {})).status, 429);
});
test("safe legacy migration assigns stable random user handles and preserves them on reopen", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translator-passkey-test-")), file = path.join(dir, "test.sqlite");
  t.after(() => { for (const name of ["test.sqlite", "test.sqlite-wal", "test.sqlite-shm"]) { const p = path.join(dir, name); if (fs.existsSync(p)) fs.unlinkSync(p); } fs.rmdirSync(dir); });
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE users(username TEXT PRIMARY KEY,role TEXT,password_hash TEXT,created_at TEXT,disabled_at TEXT,last_login_at TEXT,limits_json TEXT,note TEXT); INSERT INTO users(username,role,password_hash,created_at) VALUES('family','user','unused','2026-01-01')"); legacy.close();
  let store = new UsageStore(file); const id = store.getUser("family").webauthn_user_id;
  assert.equal(Buffer.from(id, "base64url").length, 16); store.close();
  store = new UsageStore(file); assert.equal(store.getUser("family").webauthn_user_id, id);
  store.createUser({ username: "second", role: "user", passwordHash: "unused" }); assert.notEqual(store.getUser("second").webauthn_user_id, id); store.close();
});
