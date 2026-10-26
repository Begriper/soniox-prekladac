"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readFileSync } = require("node:fs"), vm = require("node:vm");

// Exercise the real client lifecycle and event handlers without microphone or browser access.
function client() {
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
  const nodes = new Map(), storage = new Map(), sockets = [], timers = new Map(); let nextTimer = 0;
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  for (const mode of ["conversation", "listen"]) { const b = new Node(); b.dataset.mode = mode; get("sessionMode").append(b); }
  get("profileId").options = [{ value: "conversation" }];
  const context = vm.createContext({
    document: { getElementById: get, createElement: () => new Node(), createElementNS: () => new Node(), querySelectorAll: () => [], body: new Node(), visibilityState: "visible" },
    navigator: { onLine: true }, location: { protocol: "https:", host: "test.local" },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); } send(m) { this.sent.push(m); } close() { this.readyState = 3; } },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    crypto: { randomUUID: () => "test-id" }, AbortSignal, Int16Array,
  });
  const source = readFileSync("public/app.js", "utf8");
  vm.runInContext(source.slice(0, source.indexOf("/* ---------- push to talk ---------- */")), context);
  const run = code => vm.runInContext(code, context);
  run('user = "owner"; api = async () => ({}); unlockAudio = async () => {}; startCapture = async () => {}; lockScreen = async () => {};');
  const chooseMode = value => get("sessionMode").events.click({ target: get("sessionMode").children.find(b => b.dataset.mode === value) });
  const toggle = (id, value) => { get(id).checked = value; get(id).events.change(); };
  return { run, get, storage, sockets, chooseMode, toggle, timers };
}

test("listen mode hides conversation controls and locks mode and languages while running", async () => {
  const c = client(); c.run('prefs.conversationMode = "ptt"; faceMode = true;');
  c.chooseMode("listen"); await c.run("start()"); c.sockets[0].onopen();
  const config = JSON.parse(c.sockets[0].sent[0]);
  assert.equal(config.mode, "listen"); assert.equal(config.listen_source, "auto"); assert.equal(config.conversation_mode, "auto");
  for (const id of ["faceBtn", "facePanel", "swapBtn", "pttControls"]) assert.equal(c.get(id).hidden, true, id);
  assert.equal(c.get("feed").hidden, false); assert.equal(c.get("autoControls").hidden, false);
  assert.equal(c.get("langABtn").disabled, true); assert.equal(c.get("langBBtn").disabled, true);
  assert.ok(c.get("sessionMode").children.every(b => b.disabled));
  c.chooseMode("conversation"); assert.equal(c.run("mode"), "listen");
  assert.equal(c.get("listenSubtitles").disabled, undefined); assert.equal(c.get("listenVoice").disabled, undefined);
});

test("listen toggles keep an output on, persist independently and preserve hidden subtitles", () => {
  const c = client(); c.chooseMode("listen");
  c.run('conversationId = "one"; receive({type:"token", conversation_id:"one", conversation_items:[{id:"turn-1", source_text:"Hallo", translated_text:"Ahoj", source_language:"de", target_language:"sk", is_final:false}]});');
  c.toggle("listenSubtitles", false);
  assert.equal(c.get("feed").hidden, true); assert.equal(c.get("listenCalm").hidden, false);
  assert.equal(c.run("entries.length"), 1);
  c.toggle("listenVoice", false);
  assert.equal(c.get("listenSubtitles").checked, true); assert.equal(c.get("feed").hidden, false);
  assert.equal(c.run('nodes.get("one/turn-1").tr.textContent'), "Ahoj");
  assert.equal(c.run('nodes.get("one/turn-1").article.classes.has("live")'), true);
  assert.equal(c.run('nodes.get("one/turn-1").audio.textContent'), "Priebežný preklad");
  assert.match(c.get("toast").textContent, /Titulky/);
  c.toggle("listenSubtitles", false);
  assert.equal(c.get("listenVoice").checked, true); assert.match(c.get("toast").textContent, /Hlas/);
  assert.equal(c.storage.get("translator.mode"), "listen");
  assert.equal(c.storage.get("translator.listenSubtitles"), "false"); assert.equal(c.storage.get("translator.listenVoice"), "true");
});

test("listen Hlas changes send tts_enabled live and loud speech never interrupts voice playback", async () => {
  const c = client(); c.chooseMode("listen"); await c.run("start()"); c.sockets[0].onopen();
  c.toggle("listenVoice", false);
  assert.ok(c.sockets[0].sent.some(m => typeof m === "string" && JSON.parse(m).type === "update_settings" && JSON.parse(m).tts_enabled === false));
  c.toggle("listenVoice", true);
  assert.ok(c.sockets[0].sent.some(m => typeof m === "string" && JSON.parse(m).type === "update_settings" && JSON.parse(m).tts_enabled === true));
  c.run('ready = true; cancelRequest = ""; prefs.outputMode = "headphones"; playback = { started: true, createdAt: Date.now() - 1000 };');
  c.run('for (let n = 0; n < 8; n++) sendPcm(new Int16Array(320).fill(2000).buffer);');
  assert.equal(c.sockets[0].sent.filter(m => m instanceof ArrayBuffer).length, 8);
  assert.equal(c.run("playback.started"), true); assert.equal(c.run("cancelRequest"), "");
});

test("listen limit renews automatically after finishing and retains subtitles across sessions", () => {
  const c = client();
  c.run('mode = "listen"; running = true; conversationId = "old"; globalThis.restarts = []; start = async automatic => restarts.push(automatic); entries = [{id:"old/turn-1", conversation:"old", source_text:"Hallo", translated_text:"Ahoj", is_final:true}];');
  c.run('renderAll(); receive({type:"state", conversation_id:"old", state:"finishing", accept_audio:false, microphone_muted:false}); receive({type:"session_finished", conversation_id:"old", reason:"limit"});');
  assert.equal(c.run("restarts.length"), 1); assert.equal(c.run("restarts[0]"), true);
  assert.equal(c.run("entries[0].translated_text"), "Ahoj");
  c.run('receive({type:"session_open", conversation_id:"new"}); receive({type:"token", conversation_id:"new", conversation_items:[{id:"turn-1", source_text:"Danke", translated_text:"Ďakujem", is_final:true}]});');
  assert.equal(c.run("entries.length"), 2);
  assert.equal(c.run('nodes.get("new/turn-1").article.classes.has("latest")'), true);
  assert.equal(c.run('nodes.get("old/turn-1").article.classes.has("latest")'), false);
});

test("manual stop, idle, errors and conversation mode never trigger listen renewal", async () => {
  for (const setup of ['mode="listen"; userStopped=true;', 'mode="conversation";', 'mode="listen"; document.visibilityState="hidden";']) {
    const c = client(); c.run('running=true; conversationId="one"; globalThis.restarts=0; start=async()=>restarts++;' + setup);
    c.run('receive({type:"session_finished", conversation_id:"one", reason:"limit"});');
    assert.equal(c.run("restarts"), 0);
  }
  for (const reason of ["client_stop", "idle", "error"]) {
    const c = client(); c.run('mode="listen"; running=true; conversationId="one"; globalThis.restarts=0; start=async()=>restarts++;');
    c.run('receive({type:"session_finished", conversation_id:"one", reason:' + JSON.stringify(reason) + '});');
    assert.equal(c.run("restarts"), 0);
  }
  const c = client(); c.chooseMode("listen"); await c.run("start()"); await c.run("pause()"); assert.equal(c.run("userStopped"), true);
});

test("listen preferences restore from storage and conversation retains its own settings", async () => {
  const c = client();
  for (const [key, value] of Object.entries({ mode: "listen", listen_source: "de", listenSubtitles: "false", listenVoice: "true", conversationMode: "ptt", outputMode: "text" })) c.storage.set("translator." + key, value);
  c.run('api = async url => url === "/api/languages" ? {languages:[{code:"sk",name:"Slovenčina"},{code:"de",name:"Nemčina"}]} : {voices:[{id:"Adrian"}]};');
  await c.run('showApp({username:"owner"})');
  assert.equal(c.run("mode"), "listen"); assert.equal(c.run("listenSource"), "de");
  assert.equal(c.get("listenSubtitles").checked, false); assert.equal(c.get("listenVoice").checked, true);
  assert.equal(c.run("ttsEnabled()"), true); assert.equal(c.run("microphoneMode()"), "auto");
  c.chooseMode("conversation");
  assert.equal(c.run("ttsEnabled()"), false); assert.equal(c.run("microphoneMode()"), "ptt");
  assert.equal(c.get("swapBtn").hidden, false); assert.equal(c.get("faceBtn").hidden, false);
  assert.equal(c.storage.get("translator.ttsEnabled"), "false");
});

test("conversation config is independent of a stored listen source after swapping languages", async () => {
  const c = client(); c.run('chosenA = "de"; chosenB = "sk"; listenSource = "de";');
  await c.run("start()"); c.sockets[0].onopen();
  const config = JSON.parse(c.sockets[0].sent[0]);
  assert.equal(config.mode, "conversation"); assert.equal(config.language_a, "de");
  assert.equal("listen_source" in config, false);
});
