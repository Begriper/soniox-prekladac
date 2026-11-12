"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SpeechSession } = require("../speech-session");
const { Catalog } = require("../catalog");
const { TTS_MODEL, STT_MODEL } = require("../runtime-models");
const { fixture, until } = require("./helpers/mock-runtime.cjs");

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function session(t, limits = {}) {
  const client = new EventEmitter(); client.readyState = 1; client.bufferedAmount = 0; client.messages = [];
  client.send = (m, opts) => { if (!opts?.binary) client.messages.push(JSON.parse(m)); };
  client.ping = () => {}; client.terminate = () => { client.readyState = 3; }; client.close = () => { client.readyState = 3; };
  const s = new SpeechSession(client, {
    auth: { id: "test", username: "owner", expiresAt: Date.now() + 3600000 }, ip: "127.0.0.1",
    store: { reserve: () => true },
    catalog: { hasLanguage: () => true, hasVoiceFor: () => true, canSpeak: () => true, ensureVoices: async () => {} },
    urls: { ttsWs: "ws://127.0.0.1:1", ttsRest: "http://127.0.0.1:1/tts" },
    limits: { sessionMs: 3600000, idleMs: 3600000, sessionTtsRequests: 120, sessionTtsBytes: 1e9, ...limits },
    endpoint: { delay: 1500, level: 0, sensitivity: 0 }, transport: "rest",
  });
  clearTimeout(s.configTimer); s.configured = true;
  t.after(() => s.close());
  return { s, client };
}
const idle = s => until(() => !s.playback && !s.preparingJob && !s.queue.length, 4000);

test("the session runs on stt-rt-v6", () => {
  assert.equal(STT_MODEL, "stt-rt-v6");
});

test("the voice cap counts spoken utterances and reports it only once", async t => {
  const { s, client } = session(t, { sessionTtsRequests: 2 });
  for (const id of ["one", "two", "three", "four"]) s.enqueue("text " + id, "de", id);
  await idle(s);
  const starts = client.messages.filter(m => m.type === "tts_stream_start").map(m => m.utterance_id);
  assert.deepEqual(starts, ["one", "two"]);
  assert.equal(client.messages.filter(m => m.code === "voice_limit").length, 1, "one message per session");
  assert.equal(s.audioStates.get("three"), "not_spoken"); assert.equal(s.audioStates.get("four"), "not_spoken");
  assert.ok(!client.messages.some(m => m.type === "audio_cancelled"), "later utterances do not cancel audio");
});

test("several streams of one utterance use a single slot of the voice cap", async t => {
  const { s, client } = session(t, { sessionTtsRequests: 1 });
  s.enqueue("first part", "de", "one"); s.enqueue("second part", "de", "one");
  await idle(s);
  assert.equal(client.messages.filter(m => m.type === "tts_stream_start").length, 2);
  assert.ok(!client.messages.some(m => m.code === "voice_limit"));
});

async function listening(t, config = {}) {
  const f = await fixture(); t.after(f.close);
  const cookie = await f.login();
  const ws = await f.connect(cookie, { mode: "listen", language_a: "sk", language_b: "auto", listen_source: "de", tts_enabled: false, ...config });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  return { f, ws, session: [...f.runtime.conversations.values()][0], provider: f.stt.at(-1) };
}

test("listening keeps running after far more than 40 000 characters and keeps only the recent transcript", async t => {
  const { ws, session: s, provider } = await listening(t);
  const filler = "A".repeat(1000);
  for (let i = 0; i < 60; i++) {
    provider.send(JSON.stringify({ tokens: [
      { text: filler, language: "de", is_final: true },
      { text: filler, language: "sk", is_final: true, source_language: "de", translation_status: "translation" },
      { text: "<end>", is_final: true },
    ] }));
  }
  await until(() => s.timeline.nextId > 60);
  assert.ok(!s.closed && !s.finishing, "the session is still running");
  assert.ok(!ws.messages.some(m => m.type === "error" || m.type === "session_finished"));
  const chars = s.timeline.items.reduce((n, i) => n + i.source_text.length + i.translated_text.length, 0);
  assert.ok(chars <= 32000, "old items are dropped (" + chars + ")");
  assert.ok(s.timeline.items.length > 1);
  assert.ok(s.sentItems.size <= s.timeline.items.length, "per-item bookkeeping does not grow without bound");
});

function catalogFor(state) {
  return new Catalog({
    store: { getCatalog: () => null, saveCatalog: () => {} }, apiKey: "test", ownerUsername: "owner",
    urls: { stt: "https://unit.test/stt", tts: "https://unit.test/tts", shared: "https://unit.test/shared", custom: "https://unit.test/custom" },
    fetchImpl: async url => {
      const u = new URL(url);
      if (u.pathname === "/tts") return { ok: true, json: async () => ({ models: [{ id: TTS_MODEL, languages: ["sk", "de"], voices: [{ id: "Adrian" }] }] }) };
      if (u.pathname === "/shared") { state.sharedCalls++; return { ok: true, json: async () => ({ voices: [{ id: "Adrian" }], next_page_cursor: null }) }; }
      if (u.pathname === "/custom") {
        if (state.customHangs) return new Promise(() => {});
        if (state.customFails) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ voices: [{ id: UUID, name: "my voice", models: [{ model: TTS_MODEL, status: "ready" }] }], next_page_cursor: null }) };
      }
      throw new Error("unexpected request");
    },
  });
}

test("a failed refresh of the custom voices keeps the last good list while it is still valid", async () => {
  const state = { sharedCalls: 0 }, catalog = catalogFor(state);
  await catalog.voicesFor("owner");
  assert.equal(catalog.ownerVoice().status, "ready");
  catalog.voiceUpdatedAt -= 9 * 60000; catalog.customUpdatedAt -= 9 * 60000;
  state.customFails = true;
  await catalog.refreshVoices();
  assert.equal(catalog.ownerVoice().status, "ready", "the clone survives one failed refresh");
  assert.equal(catalog.hasVoiceFor("owner", UUID), true);
  assert.ok(Date.now() - catalog.voiceUpdatedAt < 5000, "the shared list was refreshed anyway");
  assert.ok(catalog.voiceRetryAt > Date.now(), "the failed part is retried soon");
});

test("an unreachable custom voice endpoint never makes shared voices wait", async () => {
  const state = { sharedCalls: 0 }, catalog = catalogFor(state);
  await catalog.voicesFor("owner");
  catalog.customUpdatedAt -= 11 * 60000; // custom list expired, shared list fresh
  state.customHangs = true;
  const outcome = await Promise.race([catalog.ensureVoices().then(() => "resolved"), new Promise(r => setTimeout(() => r("waiting"), 100))]);
  assert.equal(outcome, "resolved");
  assert.equal(catalog.hasVoiceFor("owner", "Adrian"), true);
  assert.equal(catalog.ownerVoice().status, "unavailable");
});

test("each conversation writes one JSON log line without text or a readable username", async t => {
  const lines = []; t.mock.method(console, "log", line => lines.push(String(line)));
  const f = await fixture({ env: { LOG_EVENTS: "true" } }); t.after(f.close);
  const ws = await f.connect(await f.login());
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  ws.send(JSON.stringify({ type: "client_stop" }));
  await until(() => ws.messages.some(m => m.type === "session_finished"));
  await until(() => lines.some(l => l.includes("session_end")));
  const entry = JSON.parse(lines.find(l => l.includes("session_end")));
  assert.equal(entry.event, "session_end");
  assert.equal(entry.end_code, "finished");
  assert.match(entry.user, /^[0-9a-f]{8}$/);
  assert.ok(!lines.join("\n").includes("owner"), "no readable username");
  for (const key of ["duration_ms", "stt_seconds", "tts_chars", "latency", "provider_error"]) assert.ok(key in entry, key);
  assert.ok(!("timings" in entry) && !("source_text" in entry));
});

test("a cloned voice waits for the expired custom list, shared voices do not", async () => {
  const state = { sharedCalls: 0 }, catalog = catalogFor(state);
  await catalog.voicesFor("owner");
  catalog.customUpdatedAt -= 11 * 60000;
  const before = catalog.customUpdatedAt;
  await catalog.ensureVoices(UUID);
  assert.ok(catalog.customUpdatedAt > before, "refreshed before the clone was checked");
  assert.equal(catalog.hasVoiceFor("owner", UUID), true);
});

test("replaying an item the server no longer holds gets an answer instead of silence", async t => {
  const { ws, session: s } = await listening(t);
  ws.send(JSON.stringify({ type: "replay_translation", item_id: "turn-999" }));
  await until(() => ws.messages.some(m => m.code === "replay_unavailable"));
  assert.ok(!s.closed);
});

test("listening still stops when a single utterance without an endpoint grows past the cap", async t => {
  const { ws, provider } = await listening(t);
  provider.send(JSON.stringify({ tokens: [{ text: "B".repeat(45000), language: "de", is_final: true }] }));
  await until(() => ws.messages.some(m => m.type === "session_finished"));
});

test("the default daily voice request limit leaves room for hours of listening with voice", async t => {
  // Review 2026-11 (R1): 600 requests were used up by about an hour of listening (one request per spoken sentence),
  // after which the conversation ended with a quota error until midnight UTC.
  const f = await fixture(); t.after(f.close);
  const usage = await (await f.request("/api/usage", undefined, await f.login())).json();
  assert.equal(usage.limits.ttsRequests, 3000);
  // The cost guards stay as they were.
  assert.equal(usage.limits.ttsChars, 200000);
});
