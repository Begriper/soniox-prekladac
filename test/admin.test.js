const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { hashPassword, MIN_PASSWORD_LENGTH } = require("../passwords");
const { createSonioxUsage } = require("../soniox-usage");
const { UsageStore } = require("../usage-store");
const { fixture, until } = require("./helpers/mock-runtime.cjs");
const FAMILY = "family-test-access-123456", PASSWORD = "new-user-password-123";
const root = "/api/admin/users";
const empty = { sttSeconds: 0, ttsChars: 0, ttsRequests: 0, ttsAudioBytes: 0, sessions: 0 };
async function setup(t, options) { const f = await fixture(options); t.after(() => f.close()); return f; }
function log(store, values = {}) {
  const summary = { id: crypto.randomUUID(), started_at: store.day() + "T12:00:00.000Z", duration_ms: 1000, stt_seconds: 10, tts_chars: 10, tts_requests: 1, tts_audio_bytes: 4800, language_a: "sk", language_b: "de", profile: "conversation", latency_median_ms: 100, end_code: "finished", ...values };
  store.recordConversation("family", summary); return summary;
}
test("admin creates supplied and generated passwords, returned only once; new accounts can log in", async t => {
  const f = await setup(t), admin = await f.login();
  for (const [username, password] of [["guest", PASSWORD], ["generated", undefined]]) {
    const res = await f.request(root, { username, role: "user", ...(password ? { password } : {}), note: "Rodina" }, admin);
    assert.equal(res.status, 201);
    const data = await res.json(); assert.ok(data.password.length >= MIN_PASSWORD_LENGTH);
    if (password) assert.equal(data.password, password);
    const cookie = await f.login(username, data.password);
    assert.equal((await f.request("/api/session", undefined, cookie)).status, 200);
    const users = await (await f.request(root, undefined, admin)).json();
    assert.ok(!JSON.stringify(users).includes(data.password)); assert.ok(!JSON.stringify(users).includes("password_hash"));
    const row = users.users.find(u => u.username === username);
    assert.equal(row.note, "Rodina"); assert.equal(row.disabled, false); assert.equal(row.active, false);
    assert.equal(row.sessions.length, 1); assert.equal(row.sessions[0].id_hash, undefined); assert.ok(row.last_login_at);
    assert.deepEqual(row.month, { sttSeconds: 0, ttsAudioBytes: 0, ttsChars: 0, sessions: 0 });
  }
  assert.equal((await f.request(root, { username: "guest", role: "user" }, admin)).status, 409);
});
test("every admin route rejects non-admin and missing sessions with 403", async t => {
  const f = await setup(t), family = await f.login("family", FAMILY);
  const routes = [[root], ["/api/admin/usage"], ["/api/admin/audit"], ["/api/admin/soniox-usage"], [root, { username: "new", role: "user" }],
    ...["password", "limits", "role", "disable", "enable", "revoke", "logout", "delete"].map(action => [root + "/family/" + action, {}])];
  for (const cookie of [family, undefined]) for (const [url, body] of routes) {
    const res = await f.request(url, body, cookie); assert.equal(res.status, 403, url); assert.ok((await res.json()).error);
  }
});
test("admin input and usage query validation reject malformed values without mutations", async t => {
  const f = await setup(t), admin = await f.login(), store = f.runtime.store;
  for (const patch of [{ username: "AName" }, { username: "a" }, { username: "_name" }, { username: "x".repeat(41) }, { role: "owner" }, { password: "short" }, { password: null }, { note: null }, { note: "x".repeat(201) }, { extra: true }, { limits: [] }, { limits: { sessions: "1" } }, { limits: { ttsChars: -1 } }, { limits: { sttSeconds: 1e12 + 1 } }, { limits: { previewTtsRequests: 2 } }, { limits: { constructor: 2 } }]) {
    assert.equal((await f.request(root, { username: "guest", role: "user", ...patch }, admin)).status, 400, JSON.stringify(patch));
  }
  for (const override of [[], { unknown: 1 }, { sessions: null }, { sessions: 1e13 }]) assert.equal((await f.request(root + "/family/limits", { limits: override }, admin)).status, 400);
  for (const path of ["usage?days=0", "usage?days=401", "usage?days=1.5", "usage?days=1&days=2", "usage?username[a]=b", "audit?limit=501", "audit?limit=-1", "audit?limit=abc"]) assert.equal((await f.request("/api/admin/" + path, undefined, admin)).status, 400, path);
  assert.equal((await f.request(root + "/family/limits", {}, admin)).status, 400);
  assert.equal((await f.request(root + "/missing/logout", {}, admin)).status, 404);
  assert.equal(store.listUsers().length, 2); assert.equal(store.listAudit(500).length, 2);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => store.setLimits("family", { sessions: value }));
  const res = await fetch(f.url + root + "/family/logout", { method: "POST", headers: { Cookie: admin, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
});
test("password reset revokes every login and live WebSocket and preview; passwords never enter audit", async t => {
  const f = await setup(t), admin = await f.login(), first = await f.login("family", FAMILY), second = await f.login("family", FAMILY);
  const ws = await f.connect(first); await until(() => ws.messages.some(m => m.type === "server_ready"));
  const users = await (await f.request(root, undefined, admin)).json(); assert.equal(users.users.find(u => u.username === "family").active, true);
  const reset = await f.request(root + "/family/password", { password: PASSWORD }, admin); assert.equal(reset.status, 200); assert.equal((await reset.json()).password, PASSWORD);
  await until(() => ws.readyState === WebSocket.CLOSED);
  for (const cookie of [first, second]) assert.equal((await f.request("/api/session", undefined, cookie)).status, 401);
  assert.equal((await f.request("/api/login", { username: "family", password: FAMILY })).status, 401);
  const cookie = await f.login("family", PASSWORD); f.state.restDelay = 3000;
  const preview = f.request("/api/preview-voice", { language: "sk", voice: "Adrian" }, cookie);
  await until(() => f.state.rest.length === 1);
  const generated = await (await f.request(root + "/family/password", {}, admin)).json();
  assert.ok(generated.password.length >= MIN_PASSWORD_LENGTH); assert.equal((await preview).status, 401);
  assert.equal((await f.request("/api/login", { username: "family", password: generated.password })).status, 200);
  const audit = await (await f.request("/api/admin/audit", undefined, admin)).json();
  assert.equal(audit.audit[0].action, "reset_password");
  for (const secret of [PASSWORD, generated.password, "scrypt$"]) assert.ok(!JSON.stringify(audit).includes(secret));
});
test("a password change during login verification prevents issuing a session for the old password", async t => {
  const f = await setup(t), store = f.runtime.store, newHash = await hashPassword(PASSWORD), getUser = store.getUser;
  let changed = false;
  store.getUser = function(username) {
    const row = getUser.call(this, username);
    if (username === "family" && !changed) { changed = true; this.setPasswordHash(username, newHash); }
    return row;
  };
  const response = await f.request("/api/login", { username: "family", password: FAMILY });
  assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null);
  store.getUser = getUser;
  assert.equal((await f.request("/api/login", { username: "family", password: PASSWORD })).status, 200);
});
test("limits set and clear apply immediately to reserve and expose effective defaults", async t => {
  const f = await setup(t), admin = await f.login(), store = f.runtime.store;
  const overrides = { sessions: 1, sttSecondsMonth: 0, ttsChars: 1e12 };
  assert.equal((await f.request(root + "/family/limits", { limits: overrides }, admin)).status, 200);
  assert.equal(store.reserve("family", { sessions: 1 }), true); assert.equal(store.reserve("family", { sessions: 1 }), false); assert.equal(store.reserve("family", { sttSeconds: 1 }), false);
  let family = (await (await f.request(root, undefined, admin)).json()).users.find(u => u.username === "family");
  assert.deepEqual(family.limits_override, overrides); assert.equal(family.limits_effective.audioBytes, store.limits.audioBytes); assert.equal(family.today.sessions, 1);
  assert.equal((await f.request(root + "/family/limits", { limits: null }, admin)).status, 200);
  assert.equal(store.reserve("family", { sessions: 1, sttSeconds: 10 }), true);
  family = (await (await f.request(root, undefined, admin)).json()).users.find(u => u.username === "family"); assert.equal(family.limits_override, null);
});
test("self and last-enabled-admin guards hold; roles refresh on existing sessions and enable works", async t => {
  const f = await setup(t), owner = await f.login(), family = await f.login("family", FAMILY), store = f.runtime.store;
  for (const action of ["disable", "delete", "revoke"]) assert.equal((await f.request(root + "/owner/" + action, {}, owner)).status, 400);
  assert.equal((await f.request(root + "/owner/role", { role: "user" }, owner)).status, 400);
  assert.equal(store.setRole("owner", "user"), false); assert.equal(store.deleteUser("owner"), false); assert.equal(store.setDisabled("owner", true), false);
  assert.equal((await f.request(root + "/family/role", { role: "admin" }, owner)).status, 200);
  assert.equal((await f.request(root, undefined, family)).status, 200);
  assert.equal((await f.request(root + "/owner/role", { role: "user" }, family)).status, 200);
  assert.equal((await f.request(root, undefined, owner)).status, 403);
  assert.equal(store.setRole("family", "user"), false);
  assert.equal((await f.request(root + "/owner/disable", {}, family)).status, 200); assert.ok(store.getUser("owner").disabled_at);
  assert.equal((await f.request(root + "/owner/enable", {}, family)).status, 200); assert.equal(store.getUser("owner").disabled_at, null);
});
test("logout ends live operations without disabling the account", async t => {
  const f = await setup(t), admin = await f.login(), family = await f.login("family", FAMILY);
  const ws = await f.connect(family); await until(() => ws.messages.some(m => m.type === "server_ready"));
  assert.equal((await f.request(root + "/family/logout", {}, admin)).status, 200);
  await until(() => ws.readyState === WebSocket.CLOSED);
  assert.equal((await f.request("/api/session", undefined, family)).status, 401); assert.equal(f.runtime.store.getUser("family").disabled_at, null);
  assert.equal((await f.request("/api/login", { username: "family", password: FAMILY })).status, 200);
});
test("deletion anonymizes historical and just-ended conversation usage with stable identity", async t => {
  const f = await setup(t), admin = await f.login(), family = await f.login("family", FAMILY), store = f.runtime.store;
  const user = store.getUser("family"), anonymous = "deleted-" + crypto.createHash("sha256").update("family" + user.created_at).digest("hex").slice(0, 8);
  store.reserve("family", { ttsChars: 123 }); log(store);
  const ws = await f.connect(family); await until(() => ws.messages.some(m => m.type === "server_ready"));
  assert.equal((await f.request(root + "/family/delete", {}, admin)).status, 200);
  await until(() => ws.readyState === WebSocket.CLOSED);
  assert.equal(store.getUser("family"), undefined); assert.equal(store.read("family").sessions, 0); assert.equal(store.read(anonymous).sessions, 1); assert.equal(store.read(anonymous).ttsChars, 123);
  const rows = store.db.prepare("SELECT * FROM conversation_log").all(); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.username === anonymous));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE username='family'").get().n, 0);
  const usage = await (await f.request("/api/admin/usage", undefined, admin)).json(); assert.equal(usage.totals.ttsChars, 123); assert.equal(usage.by_user[0].username, anonymous);
});
test("conversation logs capture reserved metrics, configured languages, profile and end codes without text", async t => {
  const f = await setup(t, { env: { TTS_TRANSPORT: "rest" } }), cookie = await f.login("family", FAMILY), store = f.runtime.store;
  const ws = await f.connect(cookie, { language_a: "de", language_b: "sk", profile_id: "conversation" }); await until(() => f.state.stt.length === 1 && f.state.configs.length === 1);
  f.turn(f.state.stt[0]); await until(() => ws.messages.some(m => m.type === "tts_stream_end"));
  const playback = ws.messages.find(m => m.type === "tts_stream_start");
  ws.send(JSON.stringify({ type: "playback_started", playback_id: playback.playback_id }));
  ws.send(JSON.stringify({ type: "playback_done", playback_id: playback.playback_id, status: "played" }));
  ws.send(JSON.stringify({ type: "client_stop" })); await until(() => ws.readyState === WebSocket.CLOSED);
  let rows = store.db.prepare("SELECT * FROM conversation_log").all(); assert.equal(rows.length, 1);
  const row = rows[0], today = store.read("family");
  assert.equal(row.end_code, "finished"); assert.equal(row.language_a, "de"); assert.equal(row.language_b, "sk"); assert.equal(row.profile, "conversation");
  assert.equal(row.stt_seconds, today.sttSeconds); assert.equal(row.tts_chars, today.ttsChars); assert.ok(row.tts_chars > 0); assert.equal(row.tts_requests, today.ttsRequests); assert.equal(row.tts_audio_bytes, today.ttsAudioBytes); assert.ok(row.duration_ms >= 0); assert.ok(Number.isFinite(row.latency_median_ms));
  for (const text of ["Dobrý deň", "Guten Tag", "source_text", "translated_text", "timings"]) assert.ok(!JSON.stringify(rows).includes(text));
  assert.equal(f.state.rest[0].client_reference_id, "family");
  const second = await f.connect(cookie); await until(() => second.messages.some(m => m.type === "server_ready")); second.close();
  await until(() => store.db.prepare("SELECT COUNT(*) AS n FROM conversation_log").get().n === 2);
  rows = store.db.prepare("SELECT * FROM conversation_log ORDER BY rowid").all(); assert.equal(rows[1].end_code, "client_closed");
});
test("REST fallback attributes the user and conversation log counts every reserved TTS attempt", async t => {
  const f = await setup(t), admin = await f.login(), family = await f.login("family", FAMILY), store = f.runtime.store;
  f.state.mode = "fail";
  const ws = await f.connect(family, { language_a: "sk", language_b: "de", tts_speed: "1.2" });
  await until(() => f.state.configs.length === 1); f.turn(f.state.stt[0]);
  await until(() => ws.messages.some(m => m.type === "tts_stream_end"));
  assert.equal(f.state.rest.length, 1); assert.equal(f.state.rest[0].client_reference_id, "family"); assert.equal(f.state.rest[0].speed, 1.2);
  assert.equal((await f.request(root + "/family/logout", {}, admin)).status, 200);
  const row = store.db.prepare("SELECT * FROM conversation_log").get(), usage = store.read("family");
  assert.equal(row.end_code, "auth_expired"); assert.equal(row.tts_requests, 2); assert.equal(row.tts_chars, usage.ttsChars); assert.ok(row.tts_chars > 0);
});
test("usage aggregates UTC dates, users, estimates and conversation distributions", async t => {
  const f = await setup(t, { env: { PRICE_STT_USD_PER_HOUR: "0.24", PRICE_TTS_USD_PER_HOUR: "1.40" } }), admin = await f.login(), store = f.runtime.store;
  const today = store.day(), yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10), old = new Date(Date.parse(today) - 3 * 86400000).toISOString().slice(0, 10);
  for (const [user, day, data] of [["family", today, { sttSeconds: 3600, ttsAudioBytes: 48000 * 3600, sessions: 2 }], ["family", yesterday, { ttsChars: 50, ttsRequests: 2 }], ["owner", today, { sttSeconds: 1800, sessions: 1 }], ["family", old, { sttSeconds: 99999 }]]) store.db.prepare("INSERT INTO usage VALUES(?,?,?)").run(user, day, JSON.stringify(data));
  log(store); log(store, { duration_ms: 3000, latency_median_ms: 300, language_b: "en", profile: "medical" }); log(store, { started_at: old + "T12:00:00.000Z" });
  const data = await (await f.request("/api/admin/usage?days=2", undefined, admin)).json();
  assert.equal(data.from, yesterday); assert.equal(data.to, today); assert.equal(data.days.length, 3);
  assert.deepEqual(data.totals, { ...empty, sttSeconds: 5400, ttsAudioBytes: 48000 * 3600, sessions: 3, ttsChars: 50, ttsRequests: 2, estimated_usd: 1.76 });
  assert.equal(data.by_user.find(u => u.username === "family").estimated_usd, 1.64); assert.equal(data.by_user.find(u => u.username === "owner").estimated_usd, 0.12);
  assert.equal(data.conversations.count, 2); assert.equal(data.conversations.avg_duration_ms, 2000); assert.equal(data.conversations.latency_median_ms, 200);
  assert.deepEqual(data.conversations.languages, [{ pair: "sk-de", count: 1 }, { pair: "sk-en", count: 1 }]); assert.equal(data.conversations.profiles[1].profile, "medical");
  const filtered = await (await f.request("/api/admin/usage?days=1&username=owner", undefined, admin)).json(); assert.equal(filtered.totals.sessions, 1); assert.equal(filtered.conversations.count, 0); assert.equal(filtered.conversations.latency_median_ms, null);
  const nothing = await (await f.request("/api/admin/usage?username=absent", undefined, admin)).json(); assert.deepEqual(nothing.totals, { ...empty, estimated_usd: 0 });
});
test("audit records every successful mutation, newest first, and rolls mutations back if audit fails", async t => {
  const f = await setup(t), admin = await f.login(), store = f.runtime.store;
  await f.request(root, { username: "guest", role: "user", password: PASSWORD }, admin);
  for (const [action, body] of [["password", { password: PASSWORD }], ["limits", { limits: {} }], ["role", { role: "admin" }], ["disable", {}], ["enable", {}], ["logout", {}], ["delete", {}]]) assert.equal((await f.request(root + "/guest/" + action, body, admin)).status, 200);
  const rows = (await (await f.request("/api/admin/audit?limit=8", undefined, admin)).json()).audit;
  assert.deepEqual(rows.map(row => row.action), ["delete_user", "logout_user", "enable_user", "disable_user", "set_role", "set_limits", "reset_password", "create_user"]);
  assert.ok(rows.every(row => row.actor === "owner" && row.target === "guest")); assert.ok(!JSON.stringify(rows).includes(PASSWORD)); assert.ok(!JSON.stringify(rows).includes("scrypt$"));
  const audit = store.audit; store.audit = () => { throw new Error("disk failure"); };
  assert.equal((await f.request(root + "/family/limits", { limits: { sessions: 0 } }, admin)).status, 503);
  store.audit = audit; assert.equal(store.getUser("family").limits_json, null);
});
test("Soniox usage aggregates official paginated fields, server auth and hourly cache", async t => {
  const f = await setup(t, { usagePages: [
    { usage_logs: [{ client_reference_id: "family", cost_usd: "0.1234000000" }, { client_reference_id: "owner", cost_usd: "0.1000000000" }], next_page_cursor: "1" },
    { usage_logs: [{ client_reference_id: "family", cost_usd: "0.1000000000" }, { client_reference_id: null, cost_usd: "0.0020000000" }], next_page_cursor: null },
  ] }), admin = await f.login();
  const result = await f.request("/api/admin/soniox-usage", undefined, admin); assert.equal(result.status, 200);
  const data = await result.json(); assert.equal(data.month, new Date().toISOString().slice(0, 7)); assert.ok(data.fetched_at);
  assert.deepEqual(data.by_reference, [{ client_reference_id: "", cost_usd: 0.002, requests: 1 }, { client_reference_id: "family", cost_usd: 0.2234, requests: 2 }, { client_reference_id: "owner", cost_usd: 0.1, requests: 1 }]); assert.equal(data.total_usd, 0.3254);
  assert.deepEqual(await (await f.request("/api/admin/soniox-usage", undefined, admin)).json(), data); assert.equal(f.state.usageCalls.length, 2);
  const [first, second] = f.state.usageCalls; assert.equal(first.authorization, "Bearer mock-provider-key");
  const query = new URL(first.url, f.url).searchParams; assert.equal(query.get("start_time"), data.month + "-01T00:00:00Z"); assert.equal(query.get("sort"), "end_time_asc"); assert.equal(query.get("limit"), "1000"); assert.ok(query.get("end_time")); assert.equal(new URL(second.url, f.url).searchParams.get("cursor"), "1"); assert.ok(!JSON.stringify(data).includes("mock-provider-key"));
});
test("Soniox errors return secret-free 503 and failed loads are retried", async t => {
  const f = await setup(t), admin = await f.login(); f.state.usageStatus = 401;
  const res = await f.request("/api/admin/soniox-usage", undefined, admin); assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: "Spotreba Soniox momentálne nie je dostupná." });
  f.state.usageStatus = 200; assert.equal((await f.request("/api/admin/soniox-usage", undefined, admin)).status, 200); assert.equal(f.state.usageCalls.length, 2);
});
test("Soniox pagination is bounded; malformed, looping or incomplete responses never cache partial totals", async () => {
  for (const page of [{}, { usage_logs: [{ cost_usd: "bad" }] }, { usage_logs: [{ cost_usd: null }] }, { usage_logs: [], next_page_cursor: 1 }, { usage_logs: [], next_page_cursor: "same" }]) {
    let calls = 0;
    const get = createSonioxUsage({ url: "https://example.test/logs", apiKey: "mock", fetchImpl: async () => { calls++; return Response.json(page); } });
    await assert.rejects(get()); await assert.rejects(get()); assert.ok(calls >= 2);
  }
  let calls = 0;
  const get = createSonioxUsage({ url: "https://example.test/logs", apiKey: "mock", fetchImpl: async (_url, options) => { assert.ok(options.signal); return Response.json({ usage_logs: [], next_page_cursor: String(++calls) }); } });
  await assert.rejects(get(), /page limit/); assert.equal(calls, 50);
});
test("Soniox cache expires hourly and at UTC month rollover and coalesces concurrent loads", async () => {
  let at = new Date("2026-10-31T23:30:00Z"), calls = 0;
  const get = createSonioxUsage({ url: "https://example.test/logs", apiKey: "mock", now: () => at, fetchImpl: async () => { calls++; return Response.json({ usage_logs: [], next_page_cursor: null }); } });
  await Promise.all([get(), get()]); assert.equal(calls, 1);
  at = new Date("2026-11-01T00:00:00Z"); assert.equal((await get()).month, "2026-11"); assert.equal(calls, 2);
  at = new Date("2026-11-01T01:00:00Z"); await get(); assert.equal(calls, 3);
});
test("REST replay and preview include attribution and replay speed is validated", async t => {
  const f = await setup(t), cookie = await f.login("family", FAMILY), payload = { text: "Ahoj", language: "sk", voice: "Adrian" };
  for (const body of [{ ...payload, speed: 1.2 }, { ...payload, tts_speed: 0.7 }, { ...payload, speed: 1.3 }]) assert.equal((await f.request("/api/replay", body, cookie)).status, 200);
  assert.equal((await f.request("/api/preview-voice", { language: "sk", voice: "Adrian" }, cookie)).status, 200);
  assert.ok(f.state.rest.every(body => body.client_reference_id === "family")); assert.deepEqual(f.state.rest.slice(0, 3).map(body => body.speed), [1.2, 0.7, 1.3]);
  for (const speed of [0.6, 1.4, "1.2", null]) assert.equal((await f.request("/api/replay", { ...payload, speed }, cookie)).status, 400);
});
test("conversation retention uses 400 UTC days and default estimates use audio hours", t => {
  const store = new UsageStore(":memory:"); t.after(() => store.close());
  const day = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  for (const days of [399, 400, 401]) log(store, { started_at: day(days) + "T12:00:00.000Z" });
  store.prune(); assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM conversation_log").get().n, 2);
  store.db.prepare("INSERT INTO usage VALUES(?,?,?)").run("family", store.day(), JSON.stringify({ sttSeconds: 3600, ttsAudioBytes: 48000 * 3600 }));
  assert.equal(store.analyzeUsage(store.day(), store.day(), "family", { stt: .12, tts: .70 }).totals.estimated_usd, .82);
});
test("deleting a blocked account leaves no legacy revocation for a future account of the same name", async t => {
  const f = await setup(t), admin = await f.login(), store = f.runtime.store;
  assert.equal((await f.request(root + "/family/disable", {}, admin)).status, 200);
  assert.ok(store.db.prepare("SELECT 1 FROM revoked_users WHERE user='family'").get());
  assert.equal((await f.request(root + "/family/delete", {}, admin)).status, 200);
  assert.equal(store.db.prepare("SELECT 1 FROM revoked_users WHERE user='family'").get(), undefined);
});
test("a recreated account never sees the deleted account's last conversation summary", async t => {
  const f = await setup(t), admin = await f.login(), family = await f.login("family", FAMILY);
  const ws = await f.connect(family); await until(() => ws.messages.some(m => m.type === "server_ready"));
  assert.equal((await f.request(root + "/family/delete", {}, admin)).status, 200);
  await until(() => ws.readyState === WebSocket.CLOSED);
  const row = f.runtime.store.db.prepare("SELECT username FROM conversation_log").get();
  assert.match(row.username, /^deleted-[0-9a-f]{8}$/, "the final log row is anonymized with the history");
  assert.equal((await f.request(root, { username: "family", role: "user", password: PASSWORD }, admin)).status, 201);
  const fresh = await f.login("family", PASSWORD);
  assert.equal((await (await f.request("/api/diagnostics", undefined, fresh)).json()).last_session_summary, null);
});
test("a failed audit leaves the live conversation and logins untouched", async t => {
  const f = await setup(t), admin = await f.login(), family = await f.login("family", FAMILY), store = f.runtime.store;
  const ws = await f.connect(family); await until(() => ws.messages.some(m => m.type === "server_ready"));
  const audit = store.audit; store.audit = () => { throw new Error("disk full"); };
  assert.notEqual((await f.request(root + "/family/disable", {}, admin)).status, 200);
  store.audit = audit;
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal((await f.request("/api/session", undefined, family)).status, 200);
  assert.equal(store.getUser("family").disabled_at, null);
  ws.close();
});
