"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readFileSync } = require("node:fs"), vm = require("node:vm");

// Runs the real client code (up to the wiring section) against small browser stand-ins.
function client({ withPtt = false } = {}) {
  class Node {
    constructor() {
      this.children = []; this.attributes = {}; this.dataset = {}; this.events = {}; this.style = {};
      this.classes = new Set(); this.hidden = false; this.scrollTop = 0; this.scrollHeight = 600; this.clientHeight = 500;
      this.classList = { toggle: (key, on) => on ? this.classes.add(key) : this.classes.delete(key), add: key => this.classes.add(key), remove: key => this.classes.delete(key) };
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return (this.text || "") + this.children.map(n => n.textContent).join(""); }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
    replaceChildren(...nodes) { this.children = []; this.text = ""; this.append(...nodes); }
    addEventListener(key, fn) { this.events[key] = fn; }
    querySelectorAll() { return this.children; }
    closest() { return this; }
    close() { this.open = false; }
    showModal() { this.open = true; }
  }
  const nodes = new Map(), storage = new Map(), sockets = [], timers = new Map(), docEvents = {}, saved = [];
  let nextTimer = 0, reloads = 0;
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  for (const mode of ["conversation", "listen"]) { const b = new Node(); b.dataset.mode = mode; get("sessionMode").append(b); }
  get("profileId").options = [{ value: "conversation" }];
  class FakeAudioContext {
    constructor() { this.state = "running"; this.currentTime = 0; this.resumes = 0; this.listeners = {}; FakeAudioContext.last = this; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    resume() { this.resumes++; return Promise.resolve(); }
    createBuffer(_c, length) { return { duration: length / 24000, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { return { connect() {}, start() {}, stop() {} }; }
    get destination() { return {}; }
  }
  const context = vm.createContext({
    document: {
      getElementById: get, createElement: () => new Node(), createElementNS: () => new Node(), querySelectorAll: () => [], querySelector: () => null, body: new Node(), visibilityState: "visible",
      addEventListener: (type, fn) => { docEvents[type] = fn; }, removeEventListener: type => { delete docEvents[type]; },
    },
    navigator: { onLine: true }, location: { protocol: "https:", host: "test.local", reload: () => { reloads++; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    WebSocket: class { static OPEN = 1; constructor(url) { this.url = url; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); } send(m) { this.sent.push(m); } close() { this.readyState = 3; } },
    setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    crypto: { randomUUID: () => "test-id" }, AbortSignal, AbortController, Int16Array, Float32Array, Uint8Array, Promise,
    AudioContext: FakeAudioContext,
    LocalHistory: { save: async (owner, items) => { saved.push({ owner, count: items.length }); } },
  });
  const source = readFileSync("public/app.js", "utf8");
  vm.runInContext(source.slice(0, source.indexOf("/* ---------- push to talk ---------- */")), context);
  if (withPtt) vm.runInContext(source.slice(source.indexOf("/* ---------- push to talk ---------- */"), source.indexOf("for (const side of [\"A\", \"B\"]) {\n  const button")), context);
  vm.runInContext(source.slice(source.indexOf("function connectivity()"), source.indexOf("window.addEventListener(\"online\"")), context);
  const run = code => vm.runInContext(code, context);
  run('user = "owner"; api = async url => url === "/api/languages" ? { languages: [{ code: "sk", name: "slovenčina" }, { code: "de", name: "nemčina" }] } : url === "/api/voices" ? { voices: [{ id: "Adrian" }], model: "tts-rt-v2" } : {}; unlockAudio = async () => {}; startCapture = async () => {}; lockScreen = async () => {};');
  const fire = (id, ms) => { for (const [key, t] of timers) if (ms === undefined || t.ms === ms) { timers.delete(key); t.fn(); } };
  return { run, get, storage, sockets, timers, fire, saved, docEvents, FakeAudioContext, get reloads() { return reloads; } };
}
const item = (id, text = "Ahoj") => ({ id, source_language: "sk", target_language: "de", source_text: text, translated_text: "Hallo", is_final: true, audio_status: "played" });
async function started(c) {
  await c.run("start()"); const ws = c.sockets.at(-1); ws.onopen();
  c.run('receive({ type: "session_open", conversation_id: "c1" }); receive({ type: "server_ready", conversation_id: "c1" })');
  return ws;
}

test("an expired login keeps the transcript, saves it on the device and returns it to the same account only", async () => {
  const c = client();
  await started(c);
  c.run(`receive({ type: "token", conversation_id: "c1", conversation_items: [${JSON.stringify(item("t1"))}] })`);
  assert.equal(c.run("dirty"), true);
  await c.run("signOut(false)");
  assert.equal(c.run("entries.length"), 1, "the transcript survives");
  assert.match(c.get("loginStatus").textContent, /vypršalo/);
  assert.deepEqual(c.saved, [{ owner: "owner", count: 1 }], "saved to local history");
  await c.run('showApp({ username: "owner", role: "user" })');
  assert.equal(c.run("entries.length"), 1, "the same account gets it back");
  await c.run("signOut(false)");
  await c.run('showApp({ username: "family", role: "user" })');
  assert.equal(c.run("entries.length"), 0, "another account never sees it");
});

test("a second expired answer after the sign-out does not clear the kept transcript", async () => {
  const c = client();
  c.run(`entries = [${JSON.stringify(item("c1/t1"))}]; dirty = true`);
  await c.run("signOut(false)");
  // A voice request that was still in flight answers 401 a moment later.
  await c.run("signOut(false)");
  assert.equal(c.run("entries.length"), 1);
  assert.equal(c.run("keptFor"), "owner");
  await c.run('showApp({ username: "family", role: "user" })');
  assert.equal(c.run("entries.length"), 0, "another account still never sees it");
});

test("a password typed to confirm a passkey is cleared at sign-out", async () => {
  // Codex review 2026-11: the field kept the value for the next account on the same device.
  const c = client();
  c.get("passkeyPassword").value = "tajne-heslo";
  await c.run("signOut(true)");
  assert.equal(c.get("passkeyPassword").value, "");
});

test("the Continue button resumes the interrupted conversation instead of starting a counted new one", async () => {
  // Review 2026-11 (R2): after a call, another app or a longer network drop the manual Continue used up one of the
  // 20 daily conversations each time.
  const c = client();
  await c.run("start()");
  assert.equal(new URL(c.sockets.at(-1).url).search, "", "the microphone starts a new conversation");
  c.run("disconnect(); resumePending = true");
  await c.run("start(false, true)");
  assert.equal(new URL(c.sockets.at(-1).url).search, "?resume=1");
  assert.equal(c.run("reconnectAttempts"), 0, "a manual continue still refills the retry budget");
  c.run("disconnect()");
  await c.run("start(true)");
  assert.equal(new URL(c.sockets.at(-1).url).search, "?resume=1", "the automatic reconnect is unchanged");
  assert.ok(readFileSync("public/app.js", "utf8").includes('$("resumeBtn").addEventListener("click", () => start(false, true)'), "the button asks to resume");
});

test("Stop while the microphone permission is pending never opens the microphone afterwards", async () => {
  // Codex review 2026-11: the connection now opens before getUserMedia settles; Stop then left no new epoch behind
  // and the late permission opened the microphone and worklet during finishing.
  const c = client();
  const source = readFileSync("public/app.js", "utf8");
  c.run(source.slice(source.indexOf("async function startCapture("), source.indexOf("function captureLost(")));
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let grant;
  c.run("navigator.mediaDevices = { getUserMedia: () => new Promise(r => { globalThis.grantMic = r; }) }");
  c.run("AudioWorkletNode = class { constructor() { this.port = {}; } connect() {} disconnect() {} }");
  Object.assign(c.FakeAudioContext.prototype, { audioWorklet: { addModule: async () => {} }, createMediaStreamSource: () => ({ connect() {} }), createGain: () => ({ gain: {}, connect() {} }), close: async () => {} });
  const starting = c.run("start()");
  await new Promise(r => setImmediate(r));
  const ws = c.sockets.at(-1); ws.onopen();
  c.run('receive({ type: "session_open", conversation_id: "c1" }); receive({ type: "server_ready", conversation_id: "c1" })');
  await c.run("pause()");
  assert.ok(ws.sent.some(m => JSON.parse(m).type === "client_stop"));
  grant = c.run("grantMic"); grant(stream);
  await starting;
  assert.equal(track.stopped, true, "the late microphone is released at once");
  assert.equal(c.run("media"), null);
  assert.equal(c.run("worklet"), null);
});

test("a page opened before its first service worker still reloads for a later update", () => {
  // Codex review 2026-11: the first takeover was ignored correctly, but every later update on that page was ignored too.
  const source = readFileSync("public/app.js", "utf8");
  const block = source.slice(source.indexOf('if ("serviceWorker" in navigator) {'));
  let changed, reloads = 0;
  const context = vm.createContext({
    navigator: { serviceWorker: { controller: null, addEventListener: (type, fn) => { changed = fn; }, register: () => Promise.resolve() } },
    toast() {}, maybeReload() { if (reloadOnIdleRef.value) reloads++; }, running: false, dirty: false,
  });
  const reloadOnIdleRef = { get value() { return vm.runInContext("reloadOnIdle", context); } };
  vm.runInContext("var reloadOnIdle = false;\n" + block, context);
  changed();
  assert.equal(reloads, 0, "the first install is not an update");
  changed();
  assert.equal(reloads, 1, "the next worker is a new version");
});

test("a deliberate logout still clears the transcript", async () => {
  const c = client();
  c.run(`entries = [${JSON.stringify(item("c1/t1"))}]`);
  await c.run("signOut(true)");
  assert.equal(c.run("entries.length"), 0);
});

test("the app screen appears only after languages and voices loaded", async () => {
  const c = client(); c.run('user = null; api = async () => { throw new Error("Server neodpovedá."); }');
  c.get("loginShell").hidden = false; c.get("appShell").hidden = true;
  await assert.rejects(c.run('showApp({ username: "owner" })'));
  assert.equal(c.run("user"), null); assert.equal(c.get("appShell").hidden, true);
});

test("a late server state cannot undo a stop and an old finish timer never ends the next conversation", async () => {
  const c = client();
  const ws = await started(c);
  const stopping = c.run("pause()");
  // The server has not seen client_stop yet and still reports listening.
  c.run('receive({ type: "state", conversation_id: "c1", state: "listening", accept_audio: true })');
  assert.equal(c.run("stopping"), true);
  await stopping;
  assert.ok(ws.sent.some(m => JSON.parse(m).type === "client_stop"));
  c.run('receive({ type: "session_finished", conversation_id: "c1", reason: "client_stop" })');
  await started(c);
  c.fire(undefined, 125000);
  assert.equal(c.run("running"), true, "the stale timer did not stop the new conversation");
  assert.notEqual(c.get("errorText").textContent, "Dokončenie trvalo príliš dlho.");
});

test("a suspended playback context resumes and keeps the voice instead of cancelling it", async () => {
  const c = client();
  const ws = await started(c);
  c.run('receive({ type: "tts_stream_start", conversation_id: "c1", playback_id: "p1", utterance_id: "t1" })');
  c.run("ensurePlaybackContext()").state = "interrupted";
  c.run("streamAudio(new Int16Array(480).buffer)");
  assert.ok(c.FakeAudioContext.last.resumes >= 1);
  assert.equal(c.run("playback?.meta.playback_id"), "p1", "the stream was not cancelled");
  assert.ok(!ws.sent.some(m => JSON.parse(m).type === "stop_audio"));
  assert.ok(c.docEvents.pointerdown, "the next tap resumes audio");
  c.FakeAudioContext.last.listeners.statechange();
  assert.ok(c.FakeAudioContext.last.resumes >= 2);
});

test("a refused or outdated client shows the reason and does not retry", async () => {
  const c = client();
  await started(c);
  c.run('receive({ type: "error", conversation_id: "c1", fatal: true, code: "busy_elsewhere", message: "Tvoj účet má rozhovor otvorený na inom zariadení." })');
  assert.equal(c.run("running"), false); assert.equal(c.run("reconnectTimer"), null);
  assert.match(c.get("errorText").textContent, /inom zariadení/);
  await started(c);
  assert.equal(JSON.parse(c.sockets.at(-1).sent[0]).client_version, c.run("APP_VERSION"));
  c.run('receive({ type: "error", conversation_id: "c1", fatal: true, code: "client_outdated", message: "x" })');
  await new Promise(r => setImmediate(r));
  assert.equal(c.reloads, 1);
});

test("a new service worker reloads the page only when nothing would be lost", () => {
  const c = client();
  c.run("reloadOnIdle = true; dirty = true; maybeReload()"); assert.equal(c.reloads, 0);
  c.run("dirty = false; running = true; maybeReload()"); assert.equal(c.reloads, 0);
  c.run("running = false; maybeReload()"); assert.equal(c.reloads, 1);
});

test("a press during the short release phase is kept and starts right after it", async () => {
  const c = client({ withPtt: true });
  c.run('prefs.conversationMode = "ptt"');
  await started(c);
  c.run('receive({ type: "state", conversation_id: "c1", state: "listening", accept_audio: true })');
  c.run('beginPtt("A")');
  const release = c.run('finishPtt("A")');
  c.run('beginPtt("B")');
  assert.equal(c.run("pttQueued"), "B");
  for (let i = 0; i < 20 && c.run("pttEnding"); i++) { c.fire(); await new Promise(r => setImmediate(r)); }
  await release;
  assert.equal(c.run("pttPressed"), true); assert.equal(c.run("pttSide"), "B");
});

test("the online event never restarts a conversation the user or the background stopped", async () => {
  const c = client();
  c.run("resumePending = true; userStopped = true; running = false");
  const before = c.sockets.length;
  c.run("connectivity()");
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(c.sockets.length, before);
  c.run("userStopped = false; resumePending = true; connectivity()");
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(c.sockets.length, before + 1, "a real network drop still resumes");
});

test("the connection opens while the microphone permission is still pending", async () => {
  const c = client();
  c.run("startCapture = () => new Promise(() => {})");
  void c.run("start()");
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  assert.equal(c.sockets.length, 1, "no waiting for the microphone before connecting");
});

test("the first voice chunk gets a small cushion against network jitter", async () => {
  const c = client();
  await started(c);
  const starts = [];
  c.run('receive({ type: "tts_stream_start", conversation_id: "c1", playback_id: "p1", utterance_id: "t1" })');
  const ctx = c.run("ensurePlaybackContext()");
  ctx.createBufferSource = () => ({ connect() {}, start: at => starts.push(at), stop() {} });
  c.run("streamAudio(new Int16Array(2400).buffer); streamAudio(new Int16Array(2400).buffer)");
  assert.ok(Math.abs(starts[0] - 0.12) < 1e-9, "first chunk starts after 120 ms");
  assert.ok(Math.abs(starts[1] - (0.12 + 0.1)) < 1e-9, "the next chunk follows without a gap");
});

test("an update never reloads away a transcript that could not be saved", async () => {
  const c = client();
  await started(c);
  c.run(`receive({ type: "token", conversation_id: "c1", conversation_items: [${JSON.stringify(item("t1"))}] })`);
  c.run('LocalHistory.save = async () => { throw new Error("full"); }');
  c.run('receive({ type: "error", conversation_id: "c1", fatal: true, code: "client_outdated", message: "x" })');
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  assert.equal(c.reloads, 0); assert.equal(c.run("entries.length"), 1); assert.equal(c.run("dirty"), true);
  assert.match(c.get("errorText").textContent, /skopíruj/);
});

test("a slow session check from an old reconnect never restarts a conversation the user stopped meanwhile", async () => {
  const c = client();
  await started(c);
  let release; c.run("api = url => url === '/api/session' ? globalThis.pendingSession : Promise.resolve({})");
  c.run("globalThis.pendingSession = new Promise(r => { globalThis.releaseSession = r; })");
  c.run("connectionLost()");
  c.fire();                                   // the reconnect timer asks the server about the login
  await c.run("start()"); c.sockets.at(-1).onopen();
  c.run('receive({ type: "session_open", conversation_id: "c2" }); receive({ type: "server_ready", conversation_id: "c2" })');
  await c.run("pause()"); c.run("disconnect()");
  const before = c.sockets.length;
  c.run("releaseSession({})");
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(c.sockets.length, before, "no new conversation after the user's stop");
});

test("a voice that cannot play yet is confirmed to the server only when the sound runs", async () => {
  const c = client();
  const ws = await started(c);
  c.run('receive({ type: "tts_stream_start", conversation_id: "c1", playback_id: "p1", utterance_id: "t1" })');
  const ctx = c.run("ensurePlaybackContext()"); ctx.state = "interrupted";
  c.run("streamAudio(new Int16Array(480).buffer)");
  c.fire(undefined, 0);
  assert.ok(!ws.sent.some(m => JSON.parse(m).type === "playback_started"));
  ctx.state = "running"; ctx.listeners.statechange();
  assert.ok(ws.sent.some(m => JSON.parse(m).type === "playback_started"));
});

test("speech during a queued push-to-talk press is sent after the new press starts", async () => {
  const c = client({ withPtt: true });
  c.run('prefs.conversationMode = "ptt"');
  const ws = await started(c);
  c.run('receive({ type: "state", conversation_id: "c1", state: "listening", accept_audio: true })');
  c.run('beginPtt("A")');
  const release = c.run('finishPtt("A")');
  c.run('beginPtt("B")');
  await new Promise(r => setImmediate(r));   // the flush is over, the silence for A is being sent
  assert.equal(c.run("pttDraining"), false);
  c.run("sendPcm(new Int16Array(320).fill(7).buffer)");
  for (let i = 0; i < 20 && c.run("pttEnding"); i++) { c.fire(); await new Promise(r => setImmediate(r)); }
  await release;
  const types = ws.sent.map(m => typeof m === "string" ? JSON.parse(m).type : "audio");
  const startB = types.lastIndexOf("ptt_start");
  assert.ok(startB > types.indexOf("ptt_end"), "B starts after A ended");
  assert.ok(ws.sent.slice(startB + 1).some(m => typeof m !== "string" && new Int16Array(m)[0] === 7), "the buffered speech follows");
});

test("screen readers hear each finished translation once, not every partial word", () => {
  const c = client();
  c.run(`conversationId = "c1"; receive({ type: "token", conversation_id: "c1", conversation_items: [${JSON.stringify({ ...item("t1"), is_final: false, translated_text: "Hal" })}] })`);
  assert.equal(c.get("announce").textContent, "");
  c.run(`receive({ type: "token", conversation_id: "c1", conversation_items: [${JSON.stringify(item("t1"))}] })`);
  assert.equal(c.get("announce").textContent, "Hallo"); assert.equal(c.get("announce").lang, "de");
  c.get("announce").textContent = "";
  c.run(`receive({ type: "token", conversation_id: "c1", conversation_items: [${JSON.stringify({ ...item("t1"), audio_status: "played" })}] })`);
  assert.equal(c.get("announce").textContent, "", "a later status update is not read again");
});

test("someone reading older sentences is not pulled down; a button offers the latest", () => {
  const c = client();
  const feed = c.get("feed"); feed.scrollHeight = 2000; feed.clientHeight = 500; feed.scrollTop = 200;
  c.run(`conversationId = "c1"; receive({ type: "token", conversation_id: "c1", conversation_items: [${JSON.stringify(item("t1"))}] })`);
  assert.equal(feed.scrollTop, 200); assert.equal(c.get("jumpBtn").hidden, false);
  c.run("renderAll()");
  assert.equal(feed.scrollTop, 200, "changing a setting does not jump either");
});

test("language buttons name the language, text size applies, errors reach an open sheet", () => {
  const c = client();
  c.run('languages = [{ code: "sk", name: "slovenčina" }, { code: "de", name: "nemčina" }]; controls()');
  assert.equal(c.get("langABtn").attributes["aria-label"], "Môj jazyk: Slovenčina");
  assert.equal(c.get("langBBtn").attributes["aria-label"], "Jazyk druhej osoby: Nemčina");
  const props = {}; c.get("appShell").style.setProperty = (k, v) => { props[k] = v; };
  c.run('prefs.textScale = "1.5"; controls()'); assert.equal(props["--text-scale"], "1.5");
  c.run('document.querySelector = sel => sel === "dialog[open]" ? {} : null; error("Kopírovanie nie je dostupné.")');
  assert.equal(c.get("toast").textContent, "Kopírovanie nie je dostupné.");
});

test("microphone problems get a cause-specific message with a next step", () => {
  const c = client();
  assert.match(c.run('microphoneError({ name: "NotAllowedError" })'), /Povoľ mikrofón/);
  assert.match(c.run('microphoneError({ name: "NotReadableError" })'), /iná appka/);
  assert.match(c.run('microphoneError({ name: "NotFoundError" })'), /nenašiel mikrofón/);
});

test("a stop that takes long offers to end at once", async () => {
  const c = client();
  await started(c);
  await c.run("pause()");
  assert.equal(c.get("finishNowBar").hidden, true);
  c.fire(undefined, 8000);
  assert.equal(c.get("finishNowBar").hidden, false);
});

test("clearing the conversation also clears the screen reader region", () => {
  const c = client();
  c.run(`conversationId = "c1"; receive({ type: "token", conversation_id: "c1", conversation_items: [${JSON.stringify(item("t1"))}] })`);
  assert.equal(c.get("announce").textContent, "Hallo");
  c.run("clearEntries()");
  assert.equal(c.get("announce").textContent, "");
});
