const http = require("node:http");
const WebSocket = require("ws");
const { createApplication } = require("../../server");
const CODE = "test-only-access-123456";
async function fixture(options = {}) {
  const state = { rest: [], configs: [], stt: [], tts: [], authHeaders: [], restDelay: 0, mode: "ok", autoReply: options.autoReply || false };
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(1000 * Math.sin(i * .04)), i * 2);
  const provider = http.createServer(async (req, res) => {
    let body = ""; for await (const b of req) body += b;
    if (req.url === "/stt-models" || req.url === "/tts-models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [{ id: req.url === "/stt-models" ? "stt-rt-v5" : "tts-rt-v2", languages: ["sk", "de", "es", "en", "ar", "zh"], voices: [{ id: "Adrian", gender: "male" }, { id: "Maya", gender: "female" }] }] })); return;
    }
    if (req.url.startsWith("/shared-voices")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ voices: [{ id: "Adrian", gender: "male", age: "middle_aged", accent: "central_european", style: ["calm"], use_case: ["conversational"] }, { id: "Maya", gender: "female", style: ["warm"] }], next_page_cursor: null })); return;
    }
    if (req.url.startsWith("/voices")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ voices: options.customVoices || [], next_page_cursor: null })); return;
    }
    state.rest.push(JSON.parse(body)); state.onRest?.();
    if (state.restDelay) await new Promise(r => setTimeout(r, state.restDelay));
    if (!res.destroyed) { res.setHeader("Content-Type", "application/octet-stream"); res.end(pcm); }
  });
  const wss = new WebSocket.Server({ server: provider });
  const send = (ws, value) => { if (ws.readyState === 1) ws.send(JSON.stringify(value)); };
  function turn(ws, reverse = false) {
    const config = state.configs.find(c => c.ws === ws)?.config;
    const source = reverse || config?.translation.type === "one_way" ? "de" : "sk";
    send(ws, { tokens: [
      { text: source === "sk" ? "Dobrý deň." : "Guten Tag.", language: source, is_final: true },
      { text: source === "sk" ? "Guten Tag." : "Dobrý deň.", language: source === "sk" ? "de" : "sk", source_language: source, translation_status: "translation", is_final: true },
      { text: "<end>", is_final: true }
    ] });
  }
  wss.on("connection", (ws, req) => {
    ws.on("error", () => {});
    // Mirrors Soniox after 15 Jan 2027: the key must arrive with the connection.
    state.authHeaders.push(req.headers.authorization);
    if (req.headers.authorization !== "Bearer mock-provider-key") { ws.close(4001, "unauthenticated"); return; }
    if (req.url === "/stt") {
      state.stt.push(ws); ws.received = []; ws.binaryFrames = 0;
      ws.on("message", (data, binary) => {
        if (binary) { ws.binaryFrames++; if (state.autoReply && !ws.replied) { ws.replied = true; turn(ws); } return; }
        if (!data.length) { send(ws, { tokens: [{ text: "<fin>", is_final: true }], finished: true }); return; }
        const config = JSON.parse(data); ws.received.push(config);
        if (config.model) { state.configs.push({ ws, config }); state.onConfig?.(); }
      });
    } else {
      state.tts.push(ws); ws.received = [];
      ws.on("message", data => {
        const msg = JSON.parse(data); ws.received.push(msg); if (!msg.text_end) return;
        if (state.mode === "hang") return;
        if (state.mode === "unauthorized") { send(ws, { stream_id: msg.stream_id, error_code: 401 }); return; }
        if (state.mode === "fail") { send(ws, { stream_id: msg.stream_id, error_code: 503 }); return; }
        send(ws, { stream_id: msg.stream_id, audio: pcm.toString("base64") });
        if (state.mode === "partial") { ws.close(); return; }
        send(ws, { stream_id: msg.stream_id, terminated: true });
      });
    }
  });
  await new Promise(r => provider.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + provider.address().port;
  const origin = "http://127.0.0.1:" + (options.port || 3000);
  const runtime = createApplication({
    SONIOX_API_KEY: "mock-provider-key", SESSION_SECRET: "test-session-secret-not-for-production-1234",
    APP_ACCESS_CODES: "owner:" + CODE + ",family:family-test-access-123456", APP_ORIGINS: origin,
    USAGE_DB_PATH: options.db || ":memory:", PORT: String(options.port || 3000),
    SONIOX_STT_URL: base.replace("http", "ws") + "/stt",
    SONIOX_TTS_WS_URL: base.replace("http", "ws") + "/tts",
    SONIOX_TTS_REST_URL: base + "/tts", SONIOX_STT_MODELS_URL: base + "/stt-models",
    SONIOX_TTS_MODELS_URL: base + "/tts-models", SONIOX_SHARED_VOICES_URL: base + "/shared-voices", SONIOX_CUSTOM_VOICES_URL: base + "/voices", ...options.env
  });
  await new Promise(r => runtime.server.listen(options.port || 0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + runtime.server.address().port;
  async function request(path, body, cookie) {
    return fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login() { return (await request("/api/login", { code: CODE })).headers.get("set-cookie").split(";")[0]; }
  async function connect(cookie, config = { language_a: "sk", language_b: "de" }) {
    const ws = new WebSocket(url.replace("http", "ws"), { origin, headers: { Cookie: cookie } });
    ws.messages = []; ws.audio = [];
    ws.on("error", () => {});
    ws.on("message", (data, binary) => { binary ? ws.audio.push(data) : ws.messages.push(JSON.parse(data)); });
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    if (config) ws.send(JSON.stringify({ type: "config", ...config }));
    return ws;
  }
  return { ...state, state, runtime, url, origin, request, login, connect, turn, close: async () => {
    await runtime.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close(); provider.closeAllConnections();
    await new Promise(r => provider.close(r));
  } };
}
async function until(fn, ms = 2500) {
  const deadline = Date.now() + ms;
  while (!fn()) { if (Date.now() > deadline) throw new Error("Condition timed out"); await new Promise(r => setTimeout(r, 5)); }
  return fn();
}
module.exports = { fixture, until, CODE };
