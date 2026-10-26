"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const WebSocket = require("ws");
const { setTimeout: delay } = require("node:timers/promises");
const { createApplication } = require("../server");

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for request admission");
}

async function fixture(t) {
  let providerCalls = 0;
  const provider = http.createServer((_req, res) => {
    providerCalls++;
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  const providerPort = await listen(provider);
  const code = crypto.randomBytes(24).toString("hex");
  const origin = "http://127.0.0.1:12345";
  const runtime = createApplication({
    NODE_ENV: "test",
    SONIOX_API_KEY: crypto.randomBytes(24).toString("hex"),
    SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
    APP_ACCESS_CODES: "test-user:" + code,
    APP_ORIGINS: origin,
    PORT: "12345",
    USAGE_DB_PATH: ":memory:",
    SONIOX_TTS_REST_URL: "http://127.0.0.1:" + providerPort + "/tts",
    MAX_ACTIVE_WS_TOTAL: "1",
    MAX_ACTIVE_WS_PER_IP: "1",
  });
  const appPort = await listen(runtime.server);
  const base = "http://127.0.0.1:" + appPort;
  t.after(async () => {
    await runtime.close();
    await new Promise(resolve => provider.close(resolve));
  });
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ code }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const post = (route, body = {}) => fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { runtime, base, cookie, origin, post, providerCalls: () => providerCalls };
}

function holdCatalog(runtime) {
  const gate = deferred();
  let calls = 0;
  runtime.catalog.refreshVoices = () => { calls++; return gate.promise; };
  runtime.catalog.hasVoiceFor = () => true;
  runtime.catalog.canSpeak = () => true;
  return { release: gate.release, calls: () => calls };
}

function connect(url, cookie, origin) {
  return new Promise(resolve => {
    const client = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } });
    client.on("error", () => {});
    client.once("open", () => resolve({ accepted: true, client }));
    client.once("unexpected-response", (_req, response) => {
      response.resume();
      resolve({ accepted: false, status: response.statusCode, client });
    });
  });
}

test("parallel previews reserve one per-user slot before catalog refresh", async t => {
  const f = await fixture(t);
  const gate = holdCatalog(f.runtime);
  const first = f.post("/api/preview-voice", { language: "sk", voice: "Adrian" });
  await waitFor(() => gate.calls() === 1);
  const second = f.post("/api/preview-voice", { language: "sk", voice: "Adrian" });
  await Promise.race([second.then(() => {}), waitFor(() => gate.calls() === 2), delay(100)]);
  gate.release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 429]);
  assert.equal(f.providerCalls(), 1);
});

test("replay holds the shared voice slot during catalog refresh and logout cancels it", async t => {
  const f = await fixture(t);
  const gate = holdCatalog(f.runtime);
  const replay = f.post("/api/replay", { text: "Ahoj.", language: "sk", voice: "Adrian" });
  await waitFor(() => gate.calls() === 1);
  const preview = await f.post("/api/preview-voice", { language: "sk", voice: "Adrian" });
  assert.equal(preview.status, 429);
  const logout = await f.post("/api/logout");
  assert.equal(logout.status, 200);
  gate.release();
  assert.equal((await replay).status, 401);
  assert.equal(f.providerCalls(), 0);
});

test("parallel websocket upgrades cannot exceed active conversation limits", async t => {
  const f = await fixture(t);
  const gate = holdCatalog(f.runtime);
  const wsUrl = f.base.replace("http:", "ws:");
  const first = connect(wsUrl, f.cookie, f.origin);
  await waitFor(() => gate.calls() === 1);
  const second = connect(wsUrl, f.cookie, f.origin);
  await Promise.race([second.then(() => {}), waitFor(() => gate.calls() === 2), delay(100)]);
  gate.release();
  const results = await Promise.all([first, second]);
  // The same login may take over its own conversation, but never runs two at once.
  await waitFor(() => results.filter(r => r.accepted && r.client.readyState === WebSocket.OPEN).length === 1);
  assert.equal(f.runtime.conversations.size, 1);
  for (const result of results) result.client.terminate();
});
