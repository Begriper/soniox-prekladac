const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { fixture, until } = require("./helpers/mock-runtime.cjs");
const { Catalog } = require("../catalog");
const { TTS_MODEL } = require("../runtime-models");
const UUID = "497f6eca-6276-4993-bfeb-53cbbbba6f08";

test("voice catalog follows all pages, keeps metadata, and isolates the ready owner clone", async () => {
  const calls = [];
  const data = new Catalog({
    store: { getCatalog: () => null, saveCatalog: () => {} }, apiKey: "test", ownerUsername: "owner",
    urls: { stt: "https://unit.test/stt", tts: "https://unit.test/tts", shared: "https://unit.test/shared", custom: "https://unit.test/custom" },
    fetchImpl: async url => {
      const u = new URL(url); calls.push(u);
      if (u.pathname === "/tts") return { ok: true, json: async () => ({ models: [{ id: TTS_MODEL, languages: ["sk", "de"], voices: [{ id: "Adrian" }] }] }) };
      if (u.pathname === "/shared") return { ok: true, json: async () => u.searchParams.has("cursor") ? { voices: [{ id: "Maya", gender: "female", style: ["warm"] }], next_page_cursor: null } : { voices: [{ id: "Adrian", age: "middle_aged", accent: "british" }], next_page_cursor: "second" } };
      if (u.pathname === "/custom") return { ok: true, json: async () => ({ voices: [{ id: UUID, name: "my voice", models: [{ model: TTS_MODEL, status: "ready" }] }], next_page_cursor: null }) };
      throw new Error("unexpected request");
    }
  });
  const owner = await data.voicesFor("owner"), family = await data.voicesFor("family");
  assert.equal(owner.count, 3); assert.equal(family.count, 2);
  assert.equal(owner.voices.at(-1).id, UUID); assert.ok(!family.voices.some(v => v.id === UUID));
  assert.equal(owner.voices[0].accent, "british");
  assert.equal(calls.filter(u => u.pathname === "/shared").length, 2);
  assert.equal(calls.find(u => u.pathname === "/shared").searchParams.get("model"), TTS_MODEL);
  assert.equal(data.hasVoiceFor("family", UUID), false);
  data.custom[0].models[0].status = "not_computed";
  assert.equal(data.ownerVoice().status, "not_computed");
  assert.equal(data.hasVoiceFor("owner", UUID), false);
  const unavailable = await data.voicesFor("owner");
  assert.equal(unavailable.custom_voice.status, "not_computed");
  assert.ok(!unavailable.voices.some(v => v.id === UUID));
});

test("owner can revoke a family code and its active websocket", async t => {
  const f = await fixture({ env: { APP_OWNER_USERNAME: "owner" } }); t.after(() => f.close());
  const owner = await f.login();
  const familyResponse = await f.request("/api/login", { code: "family-test-access-123456" });
  const family = familyResponse.headers.get("set-cookie").split(";")[0];
  const ws = await f.connect(family);
  await until(() => f.state.configs.length === 1);
  assert.equal((await f.request("/api/admin/users", undefined, family)).status, 403);
  assert.equal((await f.request("/api/admin/users/family/revoke", {}, owner)).status, 200);
  await until(() => ws.readyState === WebSocket.CLOSED);
  assert.equal((await f.request("/api/session", undefined, family)).status, 401);
  assert.equal((await f.request("/api/login", { code: "family-test-access-123456" })).status, 401);
});

test("PTT gates microphone frames, sends finalize, and keeps STT session alive", async t => {
  const f = await fixture(); t.after(() => f.close());
  const cookie = await f.login(), ws = await f.connect(cookie, { language_a: "sk", language_b: "de", conversation_mode: "ptt", profile_id: "cnc" });
  await until(() => f.state.configs.length === 1);
  const provider = f.state.stt[0];
  assert.equal(f.state.configs[0].config.context.terms.includes("CNC"), true);
  ws.send(Buffer.alloc(640)); await new Promise(r => setTimeout(r, 20)); assert.equal(provider.binaryFrames, 0);
  ws.send(JSON.stringify({ type: "ptt_start" })); ws.send(Buffer.alloc(640)); ws.send(JSON.stringify({ type: "ptt_end" }));
  await until(() => provider.received.some(m => m.type === "finalize"));
  assert.equal(provider.binaryFrames, 1);
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test("stable translation chunks enter one TTS stream before end and text_end closes it", async t => {
  const f = await fixture(); t.after(() => f.close());
  const cookie = await f.login(), ws = await f.connect(cookie, { language_a: "sk", language_b: "de", output_mode: "headphones" });
  await until(() => f.state.configs.length === 1);
  const provider = f.state.stt[0];
  provider.send(JSON.stringify({ tokens: [{ text: "Ahoj ", language: "sk", is_final: true }, { text: "Hallo ", language: "de", source_language: "sk", translation_status: "translation", is_final: true }] }));
  await until(() => f.state.tts.some(s => s.received.some(m => m.text === "Hallo " && m.text_end === false)));
  provider.send(JSON.stringify({ tokens: [{ text: "svet.", language: "sk", is_final: true }, { text: "Welt.", language: "de", source_language: "sk", translation_status: "translation", is_final: true }, { text: "<end>", is_final: true }] }));
  await until(() => f.state.tts.some(s => s.received.some(m => m.text_end === true)));
  const messages = f.state.tts.flatMap(s => s.received).filter(m => m.text !== undefined);
  assert.deepEqual(messages.map(m => [m.text, m.text_end]), [["Hallo ", false], ["Welt.", false], ["", true]]);
});

test("ready clone is offered only to owner and rejected on every family TTS path", async t => {
  const f = await fixture({ env: { APP_OWNER_USERNAME: "owner" }, customVoices: [{ id: UUID, name: "my voice", models: [{ model: TTS_MODEL, status: "ready" }] }] }); t.after(() => f.close());
  const owner = await f.login();
  const family = (await f.request("/api/login", { code: "family-test-access-123456" })).headers.get("set-cookie").split(";")[0];
  const ownerVoices = await (await f.request("/api/voices", undefined, owner)).json();
  const familyVoices = await (await f.request("/api/voices", undefined, family)).json();
  assert.ok(ownerVoices.voices.some(v => v.id === UUID));
  assert.ok(!familyVoices.voices.some(v => v.id === UUID));
  assert.equal((await f.request("/api/preview-voice", { voice: UUID, language: "sk" }, owner)).status, 200);
  assert.equal(f.state.rest.at(-1).voice, UUID);
  assert.equal((await f.request("/api/preview-voice", { voice: UUID, language: "sk" }, family)).status, 400);
  assert.equal((await f.request("/api/replay", { voice: UUID, language: "sk", text: "Ahoj" }, family)).status, 400);
  const ws = await f.connect(family, { language_a: "sk", language_b: "de", voice_a: UUID });
  await until(() => ws.readyState === WebSocket.CLOSED);
});

test("Soniox keys travel only in the connection header", async t => {
  const f = await fixture(); t.after(() => f.close());
  const cookie = await f.login(), ws = await f.connect(cookie, { language_a: "sk", language_b: "de" });
  await until(() => f.state.configs.length === 1);
  f.turn(f.state.stt[0]);
  await until(() => ws.messages.some(m => m.type === "tts_stream_end"));
  assert.ok(f.state.authHeaders.length >= 2);
  assert.ok(f.state.authHeaders.every(h => h === "Bearer mock-provider-key"));
  assert.equal("api_key" in f.state.configs[0].config, false);
  assert.ok(f.state.tts.flatMap(s => s.received).every(m => !("api_key" in m)));
});

test("released PTT keeps the Soniox stream alive with keepalives", async t => {
  const f = await fixture(); t.after(() => f.close());
  const cookie = await f.login(), ws = await f.connect(cookie, { language_a: "sk", language_b: "de", conversation_mode: "ptt" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const session = [...f.runtime.conversations.values()][0];
  assert.equal(session.needsKeepalive(), true);
  ws.send(JSON.stringify({ type: "ptt_start" }));
  await until(() => session.pttActive);
  assert.equal(session.needsKeepalive(), false);
});

test("a long pause mid-sentence closes the headphone TTS stream and later text starts a new one", async t => {
  const f = await fixture(); t.after(() => f.close());
  const cookie = await f.login(), ws = await f.connect(cookie, { language_a: "sk", language_b: "de", output_mode: "headphones" });
  await until(() => f.state.configs.length === 1);
  const provider = f.state.stt[0];
  provider.send(JSON.stringify({ tokens: [{ text: "Ahoj ", language: "sk", is_final: true }, { text: "Hallo ", language: "de", source_language: "sk", translation_status: "translation", is_final: true }] }));
  await until(() => f.state.tts.some(s => s.received.some(m => m.text_end === true)), 4000);
  const first = ws.messages.find(m => m.type === "tts_stream_start");
  await until(() => ws.messages.some(m => m.type === "tts_stream_end" && m.playback_id === first.playback_id));
  ws.send(JSON.stringify({ type: "playback_done", playback_id: first.playback_id, status: "played" }));
  provider.send(JSON.stringify({ tokens: [{ text: "svet.", language: "sk", is_final: true }, { text: "Welt.", language: "de", source_language: "sk", translation_status: "translation", is_final: true }, { text: "<end>", is_final: true }] }));
  await until(() => ws.messages.filter(m => m.type === "tts_stream_start").length === 2, 4000);
  const texts = f.state.tts.flatMap(s => s.received).filter(m => m.text !== undefined).map(m => [m.text, m.text_end]);
  assert.deepEqual(texts, [["Hallo ", false], ["", true], ["Welt.", false], ["", true]]);
});
