"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { fixture, until } = require("./helpers/mock-runtime.cjs");
const { parseMessage } = require("../security");

async function listening(t, config = {}, options) {
  const f = await fixture(options); t.after(f.close);
  const cookie = await f.login();
  const ws = await f.connect(cookie, { mode: "listen", language_a: "sk", language_b: "auto", ...config });
  await until(() => ws.messages.some(m => m.type === "server_ready"));
  return { f, ws, cookie, session: [...f.runtime.conversations.values()][0], provider: f.stt.at(-1) };
}
const token = (text, language, extra = {}) => ({ text, language, is_final: true, ...extra });
const translation = text => token(text, "sk", { source_language: "de", translation_status: "translation" });

for (const source of ["de", "auto"]) test("listen config uses one_way translation with source " + source, async t => {
  const { f, session } = await listening(t, { listen_source: source, conversation_mode: "ptt" });
  const config = f.configs[0].config;
  assert.deepEqual(config.translation, { type: "one_way", target_language: "sk" });
  if (source === "de") assert.deepEqual(config.language_hints, ["de"]);
  else assert.equal("language_hints" in config, false);
  assert.equal(config.enable_language_identification, true);
  assert.equal(config.enable_endpoint_detection, true);
  assert.equal(session.conversationMode, "auto");
  assert.equal(session.idleMs(), 300000);
});

test("listen ignores own-language originals and translations and never confirms a language", async t => {
  const { ws, session, provider } = await listening(t, { listen_source: "de", tts_enabled: false });
  provider.send(JSON.stringify({ tokens: [token("Vlastný hlas.", "sk"), token("Echo", "de", { source_language: "sk", translation_status: "translation" }), token("Guten Tag.", "de"), translation("Dobrý deň."), token("<end>")] }));
  await until(() => ws.messages.some(m => m.type === "token"));
  const items = ws.messages.filter(m => m.type === "token").flatMap(m => m.conversation_items);
  assert.equal(items.length, 1);
  assert.equal(items[0].source_text, "Guten Tag.");
  assert.equal(items[0].translated_text, "Dobrý deň.");
  assert.equal(items[0].audio_status, "text_only");
  assert.equal(session.candidate, null); assert.equal(session.acceptAudio, true);
  assert.ok(!ws.messages.some(m => m.type === "language_candidate" || m.state === "confirm_language"));
  ws.send(JSON.stringify({ type: "confirm_language", language: "de" }));
  ws.send(Buffer.alloc(640));
  await until(() => provider.binaryFrames === 1);
  assert.equal(session.languageB, "auto");
  assert.equal(session.sessionTtsRequests, 0);
});

for (const source of ["de", "auto"]) test("listen streams voice_a before endpoint and keeps speaker microphone open: " + source, async t => {
  const { f, ws, session, provider } = await listening(t, { listen_source: source, output_mode: "speaker", voice_a: "Maya", tts_speed: "1.15" });
  provider.send(JSON.stringify({ tokens: [token("Guten ", "de"), translation("Dobrý ")] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Dobrý " && m.text_end === false)));
  assert.equal(session.timeline.items[0].is_final, false);
  assert.ok(f.tts.flatMap(s => s.received).some(m => m.language === "sk" && m.voice === "Maya" && m.speed === 1.15));
  provider.send(JSON.stringify({ tokens: [token("Tag.", "de"), translation("deň."), token("<end>")] }));
  await until(() => ws.audio.length > 0 && ws.messages.some(m => m.type === "tts_stream_end"));
  assert.equal(session.muted(), false);
  assert.ok(ws.messages.filter(m => m.type === "state").every(m => m.microphone_muted === false));
  ws.send(Buffer.alloc(640)); await until(() => provider.binaryFrames === 1);
  const playback = ws.messages.find(m => m.type === "tts_stream_start");
  ws.send(JSON.stringify({ type: "playback_done", playback_id: playback.playback_id, status: "played" }));
  await until(() => !session.playback);
  assert.equal(session.echoUntil, 0);
  ws.send(Buffer.alloc(640)); await until(() => provider.binaryFrames === 2);
  ws.send(JSON.stringify({ type: "local_playback_start", playback_id: "local" }));
  await until(() => session.localPlayback === "local");
  assert.equal(session.muted(), false);
  ws.send(Buffer.alloc(640)); await until(() => provider.binaryFrames === 3);
});

test("listen voice can be enabled and disabled live without stopping capture", async t => {
  const { f, ws, session, provider } = await listening(t, { tts_enabled: false });
  provider.send(JSON.stringify({ tokens: [token("Hallo.", "de"), translation("Ahoj."), token("<end>")] }));
  await until(() => ws.messages.some(m => m.type === "token"));
  assert.equal(session.sessionTtsRequests, 0);
  ws.send(JSON.stringify({ type: "update_settings", tts_enabled: true }));
  await until(() => session.ttsEnabled);
  provider.send(JSON.stringify({ tokens: [token("Danke.", "de"), translation("Ďakujem.")] }));
  await until(() => f.tts.some(s => s.received.some(m => m.text === "Ďakujem.")));
  ws.send(JSON.stringify({ type: "update_settings", tts_enabled: false }));
  await until(() => !session.ttsEnabled && !session.playback);
  assert.equal(session.acceptAudio, true); assert.equal(session.muted(), false);
  provider.send(JSON.stringify({ tokens: [token("<end>"), token("Bitte.", "de"), translation("Prosím."), token("<end>")] }));
  await until(() => ws.messages.some(m => m.type === "token" && m.conversation_items.some(i => i.translated_text === "Prosím." && i.audio_status === "text_only")));
});

test("invalid modes and listen sources fail before STT is opened", async t => {
  const f = await fixture(); t.after(f.close); const cookie = await f.login();
  for (const config of [{ mode: "film" }, { mode: 1 }, { listen_source: 1 }, { listen_source: "" }, { listen_source: "xx" }, { language_a: "sk", listen_source: "sk" }]) {
    const ws = await f.connect(cookie, { mode: "listen", ...config });
    await until(() => ws.readyState === 3);
    assert.ok(ws.messages.some(m => m.type === "error" && m.fatal));
    assert.equal(ws.messages.find(m => m.type === "session_finished").reason, "error");
  }
  assert.equal(f.configs.length, 0);
  assert.equal(parseMessage(JSON.stringify({ type: "config", mode: "bad" })), null);
  assert.equal(parseMessage(JSON.stringify({ type: "config", listen_source: {} })), null);
});

test("listen session limit reports limit and resume does not consume another daily session", async t => {
  const { f, ws, cookie, provider, session } = await listening(t, { tts_enabled: false }, { env: { MAX_USER_SESSIONS_PER_DAY: "1" } });
  f.turn(provider);
  await until(() => ws.messages.some(m => m.type === "token"));
  assert.equal(session.limitTimer._idleTimeout, 30 * 60000);
  const expire = session.limitTimer._onTimeout; clearTimeout(session.limitTimer); expire();
  await until(() => ws.messages.some(m => m.type === "session_finished"));
  assert.equal(ws.messages.find(m => m.type === "session_finished").reason, "limit");
  const next = await f.connect(cookie, { mode: "listen", language_a: "sk", tts_enabled: false });
  await until(() => next.messages.some(m => m.type === "server_ready"));
  next.send(JSON.stringify({ type: "client_stop" }));
  await until(() => next.messages.some(m => m.type === "session_finished"));
  assert.equal(next.messages.find(m => m.type === "session_finished").reason, "client_stop");
});

test("listen idle timeout defaults to five minutes and accepts a separate override", async t => {
  const { session, ws } = await listening(t, {}, { env: { IDLE_TIMEOUT_SECONDS: "1", LISTEN_IDLE_TIMEOUT_SECONDS: "30" } });
  assert.equal(session.idleMs(), 30000);
  session.lastActivity = Date.now() - 31000;
  session.tick._onTimeout();
  await until(() => ws.messages.some(m => m.type === "session_finished"));
  assert.equal(ws.messages.find(m => m.type === "session_finished").reason, "idle");
});

test("listening switch and independent output toggles have accessible labels", () => {
  const html = readFileSync("public/index.html", "utf8");
  assert.match(html, /id="sessionMode"[^>]*role="radiogroup"[^>]*aria-label="Režim prekladu"/);
  for (const [mode, text] of [["conversation", "Konverzácia"], ["listen", "Počúvanie"]]) assert.match(html, new RegExp('role="radio"[^>]*data-mode="' + mode + '"[^>]*>' + text + '</button>'));
  for (const [id, label] of [["listenSubtitles", "Titulky"], ["listenVoice", "Hlas"]]) assert.match(html, new RegExp('<label><input id="' + id + '" type="checkbox"[^>]*> ' + label + '</label>'));
});
