"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture, until } = require("./helpers/mock-runtime.cjs");

const final = (text, language, extra = {}) => ({ text, language, is_final: true, ...extra });

test("speaker mode prepares the voice while the sentence is spoken and plays it only after the endpoint", async t => {
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1);
  stt.send(JSON.stringify({ tokens: [final("Dobrý deň, ", "sk"), final("Guten Tag, ", "de", { source_language: "sk", translation_status: "translation" })] }));
  // Synthesis starts before the end of the sentence…
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Guten Tag, ")), 3000);
  // …and after a pause the provider has returned audio, which is held back.
  await until(() => f.tts.some(s => s.received.some(m => m.text_end)), 4000);
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!ws.messages.some(m => m.type === "tts_stream_start"), "nothing is played before the endpoint");
  assert.equal(ws.audio.length, 0);
  const last = ws.messages.filter(m => m.type === "state").at(-1);
  assert.notEqual(last.state, "speaking"); assert.equal(last.microphone_muted, false, "the speaker can keep talking");
  stt.send(JSON.stringify({ tokens: [final("<end>")] }));
  await until(() => ws.messages.some(m => m.type === "tts_stream_start") && ws.audio.length > 0);
  assert.ok(ws.messages.some(m => m.type === "state" && m.state === "speaking" && m.microphone_muted));
});

test("stopping releases a prepared voice instead of dropping it", async t => {
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1);
  stt.send(JSON.stringify({ tokens: [final("Ahoj", "sk"), final("Hallo", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Hallo")), 3000);
  ws.send(JSON.stringify({ type: "client_stop" }));
  await until(() => ws.audio.length > 0, 5000);
  assert.ok(ws.messages.some(m => m.type === "tts_stream_start"));
});

test("words in the other language before an endpoint keep the voice prepared and the microphone open", async t => {
  // Codex adversarial review 2026-11 (the same happened in 3.5.0): a foreign word mid-sentence, or the other person
  // cutting in, started the voice at once; the muted microphone then dropped the rest of what was being said.
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1);
  stt.send(JSON.stringify({ tokens: [final("Idem na ", "sk"), final("Ich gehe zum ", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Ich gehe zum ")), 3000);
  stt.send(JSON.stringify({ tokens: [final("Bahnhof ", "de"), final("stanicu ", "sk", { source_language: "de", translation_status: "translation" })] }));
  await until(() => ws.messages.some(m => m.type === "token" && m.conversation_items.some(i => i.translated_text.includes("stanicu"))));
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!ws.messages.some(m => m.type === "tts_stream_start"), "nothing plays while the sentence goes on");
  assert.equal(ws.messages.filter(m => m.type === "state").at(-1).microphone_muted, false);
  // The rest of the sentence still reaches the recognizer.
  const before = stt.binaryFrames; ws.send(Buffer.alloc(640));
  await until(() => stt.binaryFrames === before + 1);
  stt.send(JSON.stringify({ tokens: [final("a potom domov.", "sk"), final("und dann nach Hause.", "de", { source_language: "sk", translation_status: "translation" }), final("<end>")] }));
  // After the endpoint the parts are spoken in the order they were said.
  const starts = () => ws.messages.filter(m => m.type === "tts_stream_start");
  await until(() => starts().length === 1 && ws.messages.some(m => m.type === "tts_stream_end"), 5000);
  assert.ok(starts()[0].text.includes("Ich gehe zum"));
  ws.send(JSON.stringify({ type: "playback_done", playback_id: starts()[0].playback_id, status: "played" }));
  await until(() => starts().length === 2, 4000);
  assert.ok(starts()[1].text.includes("stanicu"));
});

test("a failed stream whose audio was only held back is spoken again over REST", async t => {
  // Codex adversarial review 2026-11: the provider had sent audio, so the fallback was refused, although the phone
  // had received none of it; the sentence then had no voice at all.
  const f = await fixture(); t.after(f.close);
  f.state.mode = "partial";
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1);
  stt.send(JSON.stringify({ tokens: [final("Dobrý deň", "sk"), final("Guten Tag", "de", { source_language: "sk", translation_status: "translation" })] }));
  // After the 2 s pause the stream ends, the provider sends some audio and drops the connection: all of it is held.
  await until(() => ws.messages.some(m => m.type === "tts_fallback"), 5000);
  assert.equal(ws.audio.length, 0);
  stt.send(JSON.stringify({ tokens: [final("<end>")] }));
  await until(() => ws.audio.length > 0 && ws.messages.some(m => m.type === "tts_stream_end"), 4000);
  assert.equal(f.rest.length, 1);
  assert.deepEqual(ws.messages.filter(m => m.type === "tts_stream_start").map(m => m.transport), ["rest"]);
  assert.ok(!ws.messages.some(m => m.type === "error"), "no voice failure is reported");
});

test("a fallback that waits for the end of a sentence which never comes is spoken after 15 s of silence", async t => {
  // Codex adversarial review 2026-11: the REST fallback waits for the complete text; without an endpoint it waited
  // for ever and blocked the voice queue.
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1), session = [...f.runtime.conversations.values()][0];
  stt.send(JSON.stringify({ tokens: [final("Dobrý deň", "sk"), final("Guten Tag", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Guten Tag")), 3000);
  // The voice connection drops in the middle of the sentence and no endpoint follows.
  for (const socket of f.tts) socket.close();
  await until(() => ws.messages.some(m => m.type === "tts_fallback"), 3000);
  assert.equal(f.rest.length, 0, "the fallback waits for the rest of the sentence");
  session.playback.started -= 16000; session.lastActivity -= 16000;
  session.releaseStaleHeld();
  await until(() => f.rest.length === 1 && ws.audio.length > 0 && ws.messages.some(m => m.type === "tts_stream_end"), 4000);
  assert.equal(f.rest[0].text, "Guten Tag");
  // Words recognized later belong to a new voice job instead of being lost.
  const first = ws.messages.find(m => m.type === "tts_stream_start");
  ws.send(JSON.stringify({ type: "playback_done", playback_id: first.playback_id, status: "played" }));
  stt.send(JSON.stringify({ tokens: [final(", ako sa máte?", "sk"), final(", wie geht es Ihnen?", "de", { source_language: "sk", translation_status: "translation" }), final("<end>")] }));
  await until(() => ws.messages.filter(m => m.type === "tts_stream_start").length === 2, 5000);
  assert.ok(ws.messages.filter(m => m.type === "tts_stream_start")[1].text.includes("wie geht es Ihnen"));
});

test("a long sentence keeps its prepared voice held while the speaker is still talking", async t => {
  // Review 2026-11: the 15 s safety release counted from the first translated words, so anyone who spoke longer
  // than that without a pause got the voice (and a muted microphone) in the middle of the sentence.
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1), session = [...f.runtime.conversations.values()][0];
  stt.send(JSON.stringify({ tokens: [final("Prvá časť ", "sk"), final("Erster Teil ", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Erster Teil ")), 3000);
  assert.ok(session.playback?.held);
  // 16 s later the speaker is still talking: a final token has just arrived.
  session.playback.started -= 16000;
  stt.send(JSON.stringify({ tokens: [final("a pokračujem ", "sk"), final("und ich rede weiter ", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "und ich rede weiter ")), 3000);
  session.releaseStaleHeld();
  assert.ok(session.playback?.held, "the voice stays prepared");
  assert.ok(!ws.messages.some(m => m.type === "tts_stream_start"));
  assert.equal(ws.messages.filter(m => m.type === "state").at(-1).microphone_muted, false);
  // Nothing recognized for 15 s and still no endpoint: the voice plays instead of blocking the queue.
  session.lastActivity -= 16000;
  session.releaseStaleHeld();
  await until(() => ws.messages.some(m => m.type === "tts_stream_start"), 3000);
});

test("an endpoint releases the prepared voice also when it is attributed to another item", async t => {
  // A foreign word at the end of the sentence opens a new item; the endpoint then belongs to that item.
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1);
  stt.send(JSON.stringify({ tokens: [final("Idem na ", "sk"), final("Ich gehe zum ", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Ich gehe zum ")), 3000);
  stt.send(JSON.stringify({ tokens: [final("Bahnhof", "de"), final("<end>")] }));
  await until(() => ws.messages.some(m => m.type === "tts_stream_start") && ws.audio.length > 0, 3000);
  assert.ok(ws.messages.find(m => m.type === "tts_stream_start").text.includes("Ich gehe zum"));
});

test("a word briefly taken for the other language does not start the voice in the middle of the sentence", async t => {
  // Review 2026-11: "the item is the last one" was the test for "still being spoken". A non-final token tagged with
  // the other language opens an (empty) item behind the sentence, and the voice then started while the speaker went on.
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1);
  stt.send(JSON.stringify({ tokens: [final("Bývam na ", "sk"), { text: "Haupt", language: "de", is_final: false }] }));
  stt.send(JSON.stringify({ tokens: [final("Ich wohne in der ", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Ich wohne in der ")), 3000);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!ws.messages.some(m => m.type === "tts_stream_start"), "the sentence is not finished yet");
  assert.notEqual(ws.messages.filter(m => m.type === "state").at(-1).state, "speaking");
  stt.send(JSON.stringify({ tokens: [final("Hlavnej ulici.", "sk"), final("Hauptstraße.", "de", { source_language: "sk", translation_status: "translation" }), final("<end>")] }));
  await until(() => ws.messages.some(m => m.type === "tts_stream_start") && ws.audio.length > 0, 4000);
});

test("a voice queued behind another plays without waiting once a later sentence has started", async t => {
  // Seen on Android: "Musím ešte vybaviť | Anmeldung | na úrade." split into three items; the German word waited 10 s.
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", output_mode: "speaker" });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  const stt = f.stt.at(-1);
  stt.send(JSON.stringify({ tokens: [final("Musím ešte vybaviť ", "sk"), final("Ich muss noch erledigen ", "de", { source_language: "sk", translation_status: "translation" })] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Ich muss noch erledigen ")), 3000);
  stt.send(JSON.stringify({ tokens: [final("Anmeldung ", "de"), final("registráciu ", "sk", { source_language: "de", translation_status: "translation" })] }));
  stt.send(JSON.stringify({ tokens: [final("na úrade.", "sk"), final("bei der Behörde.", "de", { source_language: "sk", translation_status: "translation" }), final("<end>")] }));
  await until(() => ws.messages.some(m => m.type === "tts_stream_end"), 5000);
  const first = ws.messages.find(m => m.type === "tts_stream_start");
  ws.send(JSON.stringify({ type: "playback_done", playback_id: first.playback_id, status: "played" }));
  // No further speech arrives: the German word must not be held for its own endpoint.
  await until(() => ws.messages.filter(m => m.type === "tts_stream_start").length >= 2, 4000);
  assert.ok(ws.messages.filter(m => m.type === "tts_stream_start")[1].text.includes("registráciu"));
});
