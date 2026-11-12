"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture, until } = require("./helpers/mock-runtime.cjs");

const final = (text, language, extra = {}) => ({ text, language, is_final: true, ...extra });
async function conversation(t, config = { language_a: "sk", language_b: "de" }) {
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), config);
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  return { f, ws, session: [...f.runtime.conversations.values()][0] };
}

test("a dropped Soniox stream reopens inside the conversation and keeps the sentence and its voice", async t => {
  const { f, ws, session } = await conversation(t);
  f.stt.at(-1).send(JSON.stringify({ tokens: [final("Dobrý deň", "sk"), final("Guten Tag", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => ws.messages.some(m => m.type === "token"));
  f.stt.at(-1).close();
  await until(() => f.stt.length === 2 && f.configs.length === 2);
  assert.equal(session.closed, false); assert.ok(!ws.messages.some(m => m.type === "error"));
  const item = session.timeline.items[0];
  assert.equal(item.is_final, true, "the interrupted sentence is finished with what was final");
  await until(() => ws.messages.some(m => m.type === "tts_stream_start" && m.utterance_id === item.id));
  await until(() => ws.messages.some(m => m.type === "state" && m.accept_audio));
});

test("a refused Soniox handshake with no credit is final, not a reconnect loop", async t => {
  const { f, ws, session } = await conversation(t);
  // The next stream is refused at HTTP level, the way an empty balance looks during the handshake.
  const original = session.urls.stt;
  session.urls = { ...session.urls, stt: original.replace("/stt", "/payment-required") };
  f.stt.at(-1).close();
  await until(() => ws.messages.some(m => m.type === "error"));
  const err = ws.messages.find(m => m.type === "error");
  assert.equal(err.code, "provider_credit"); assert.equal(err.fatal, true);
});

test("recognize-language mode still hints the own language", async t => {
  const { f } = await conversation(t, { language_a: "sk", language_b: "auto" });
  assert.deepEqual(f.configs[0].config.language_hints, ["sk"]);
});

test("a quick second push-to-talk release is still finalized a moment later", async t => {
  const { f, ws } = await conversation(t, { language_a: "sk", language_b: "de", conversation_mode: "ptt" });
  const stt = f.stt.at(-1);
  const finalizes = () => stt.received.filter(m => m.type === "finalize").length;
  for (let i = 0; i < 2; i++) { ws.send(JSON.stringify({ type: "ptt_start" })); ws.send(JSON.stringify({ type: "ptt_end" })); }
  await until(() => finalizes() === 1);
  await until(() => finalizes() === 2, 2000);
});

test("a local replay cannot start while a server voice is being prepared", async t => {
  const { ws, session } = await conversation(t);
  session.preparingJob = { itemId: "x" };
  ws.send(JSON.stringify({ type: "local_playback_start", playback_id: "local-1" }));
  await until(() => ws.messages.some(m => m.code === "busy"));
  assert.equal(session.localPlayback, null);
});

test("several quick push-to-talk releases keep the finalize spacing", async t => {
  const { f, ws } = await conversation(t, { language_a: "sk", language_b: "de", conversation_mode: "ptt" });
  const stt = f.stt.at(-1), times = [];
  stt.on("message", (data, binary) => { if (!binary && String(data).includes("finalize")) times.push(Date.now()); });
  for (let i = 0; i < 3; i++) { ws.send(JSON.stringify({ type: "ptt_start" })); ws.send(JSON.stringify({ type: "ptt_end" })); }
  await new Promise(r => setTimeout(r, 1300));
  assert.ok(times.length >= 2, "the later releases are finalized too");
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 450, "spacing " + (times[i] - times[i - 1]) + " ms");
});

test("a language confirmed during a stream recovery does not open a second Soniox stream", async t => {
  // Codex review 2026-11: the delayed restart after a recovery ran even though the confirmation had already opened a stream.
  const { f, ws, session } = await conversation(t, { language_a: "sk", language_b: "auto" });
  f.turn(f.stt[0], true);
  await until(() => ws.messages.some(m => m.type === "language_candidate"));
  f.stt[0].close();
  await until(() => session.sttRecoveries?.length === 1);
  ws.send(JSON.stringify({ type: "confirm_language", language: "de" }));
  await until(() => f.configs.length === 2);
  // Past the 300 ms recovery delay there is still exactly one new stream.
  await new Promise(r => setTimeout(r, 500));
  assert.equal(f.stt.length, 2);
  assert.deepEqual(f.configs[1].config.translation, { type: "two_way", language_a: "sk", language_b: "de" });
});
