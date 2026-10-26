"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SpeechSession } = require("../speech-session");
const { SonioxTtsWebSocket, accountStreams } = require("../tts-transport");
const { synthesizeRest } = require("../tts-rest");
const { Catalog } = require("../catalog");

function session(t, catalog = {}) {
  const client = new EventEmitter(); client.readyState = 1; client.bufferedAmount = 0;
  client.messages = []; client.binary = [];
  client.send = (m, opts) => { if (opts?.binary) client.binary.push(m); else client.messages.push(JSON.parse(m)); };
  client.ping = () => {}; client.terminate = () => { client.readyState = 3; }; client.close = () => { client.readyState = 3; };
  const s = new SpeechSession(client, {
    auth: { id: "test", username: "owner", expiresAt: Date.now() + 3600000 }, ip: "127.0.0.1",
    store: { reserve: () => true },
    catalog: { hasLanguage: () => true, hasVoiceFor: () => true, canSpeak: () => true, ensureVoices: async () => {}, ...catalog },
    urls: { ttsWs: "ws://127.0.0.1:1", ttsRest: "http://127.0.0.1:1/tts" },
    limits: { sessionMs: 3600000, idleMs: 3600000, sessionTtsRequests: 120, sessionTtsBytes: 1e9 },
    endpoint: { delay: 1500, level: 0, sensitivity: 0 }, transport: "rest",
  });
  clearTimeout(s.configTimer); s.configured = true;
  t.after(() => s.close());
  return { s, client };
}
const tick = () => new Promise(r => setImmediate(r));

test("audio cancelled during a catalog refresh does not strand newer voice jobs", async t => {
  let release; const gate = new Promise(r => { release = r; });
  let calls = 0;
  const { s, client } = session(t, { ensureVoices: () => (++calls === 1 ? gate : Promise.resolve()) });
  s.enqueue("first", "de", "one");
  await tick();
  s.cancelAudio();
  s.enqueue("second", "de", "two");
  release(); await tick(); await tick();
  assert.equal(s.queue.length, 0);
  assert.ok(client.messages.some(m => m.type === "tts_stream_start" && m.utterance_id === "two"));
});

test("voice audio waits for a slow phone instead of failing, and the end follows the last chunk", async t => {
  const { s, client } = session(t);
  const op = { abort: new AbortController() }; s.playback = op;
  client.bufferedAmount = 300 * 1024;
  for (let i = 0; i < 40; i++) s.sendAudio(op, Buffer.alloc(16384));
  assert.equal(client.binary.length, 0, "nothing is pushed into a full socket buffer");
  let drained = false; const drain = s.drainAudio().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  client.bufferedAmount = 0;
  await new Promise(r => setTimeout(r, 40)); await drain;
  assert.equal(client.binary.length, 40);
  assert.throws(() => { client.bufferedAmount = 1e9; for (let i = 0; i < 400; i++) s.sendAudio(op, Buffer.alloc(16384)); }, /slow client/);
  s.clearOutbox();
});

test("the speaker microphone mutes at the first audible sample and ignores the loudspeaker tail", t => {
  const { s } = session(t);
  s.acceptAudio = true; s.stt = { readyState: 1, bufferedAmount: 0, sent: [], send(d) { this.sent.push(d); } };
  s.playback = { audioStarted: false, job: { itemId: "x" }, synthesisDone: true, id: "p" };
  assert.equal(s.muted(), false, "waiting for the first audio keeps the microphone open");
  s.playback.audioStarted = true;
  assert.equal(s.muted(), true);
  s.playbackDone({ playback_id: "p", status: "played" });
  s.audio(Buffer.alloc(640));
  assert.equal(s.stt.sent.length, 0, "frames right after playback carry the echo");
  s.echoUntil = 0; s.audio(Buffer.alloc(640));
  assert.equal(s.stt.sent.length, 1);
});

test("REST voice is streamed in even-sized chunks as it arrives", async () => {
  const parts = [Buffer.alloc(3, 1), Buffer.alloc(5, 2), Buffer.alloc(2, 3)];
  const fetchImpl = async () => ({ ok: true, body: (async function* () { yield* parts; })() });
  const received = [];
  const bytes = await synthesizeRest({ url: "http://x", apiKey: "k", text: "a", language: "de", voice: "Adrian", fetchImpl, onChunk: c => { received.push(c.length); } });
  assert.equal(bytes, 10);
  assert.deepEqual(received, [2, 6, 2]);
});

class FakeSocket extends EventEmitter {
  static OPEN = 1; static CLOSED = 3; static CONNECTING = 0;
  constructor() { super(); this.readyState = 0; this.sent = []; queueMicrotask(() => { this.readyState = 1; this.emit("open"); }); }
  send(p) { this.sent.push(JSON.parse(p)); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}

test("prewarm streams never take the last account slot and yield it to real speech", async t => {
  const make = () => new SonioxTtsWebSocket({ url: "ws://x", apiKey: "k", WebSocketImpl: FakeSocket, prewarmMaxAgeMs: 60000 });
  const [a, b, c] = [make(), make(), make()];
  t.after(() => { a.close(); b.close(); c.close(); });
  await a.prewarm([{ language: "de", voice: "Adrian" }]);
  await b.prewarm([{ language: "sk", voice: "Adrian" }]);
  await c.prewarm([{ language: "en", voice: "Maya" }]);
  assert.equal(accountStreams.size, 2, "the third prewarm would use the last slot");
  void b.synthesize({ language: "es", voice: "Maya", text: "hola" }).catch(() => {});
  void c.synthesize({ language: "fr", voice: "Maya", text: "salut" }).catch(() => {});
  await tick();
  assert.equal(accountStreams.size, 3);
  assert.equal([...accountStreams].filter(s => s.active).length, 2);
  void a.synthesize({ language: "it", voice: "Maya", text: "ciao" }).catch(() => {});
  await tick();
  assert.equal([...accountStreams].filter(s => s.active).length, 3, "a prewarm was released for real speech");
  assert.equal(accountStreams.size, 3);
});

test("the voice list refreshes in the background and callers wait only when it is about to expire", async () => {
  const catalog = new Catalog({ store: { getCatalog: () => null, saveCatalog() {} }, urls: {}, apiKey: "k" });
  let refreshes = 0; catalog.refreshVoices = () => { refreshes++; return new Promise(() => {}); };
  catalog.voiceUpdatedAt = Date.now() - 9 * 60000;
  await catalog.ensureVoices();
  assert.equal(refreshes, 1, "refresh started early");
  catalog.voiceUpdatedAt = 0;
  const outcome = await Promise.race([catalog.ensureVoices().then(() => "resolved"), new Promise(r => setTimeout(() => r("waiting"), 30))]);
  assert.equal(outcome, "waiting");
});
