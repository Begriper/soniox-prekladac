"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const WebSocket = require("ws");
const net = require("node:net");
const { fixture, until } = require("./helpers/mock-runtime.cjs");

const ready = ws => until(() => ws.messages.some(m => m.type === "server_ready"));
async function refused(f, cookie) {
  return new Promise(resolve => {
    const ws = new WebSocket(f.url.replace("http", "ws"), { origin: f.origin, headers: { Cookie: cookie } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("open", () => { ws.terminate(); resolve("open"); });
    ws.on("error", () => {});
  });
}

test("the same login takes over its own conversation after a silent network drop", async t => {
  const f = await fixture(); t.after(f.close);
  const cookie = await f.login();
  const first = await f.connect(cookie); await ready(first);
  // The phone vanished: the server never receives a close frame from the old socket.
  first._socket.pause();
  const second = await f.connect(cookie); await ready(second);
  assert.equal(f.runtime.conversations.size, 1);
  assert.equal(f.stt[0].readyState === WebSocket.OPEN, false, "old Soniox stream is closed, not left billing");
  second.close(); first.terminate();
});

test("another login of the same user is still refused while a conversation runs, with a readable reason", async t => {
  const f = await fixture(); t.after(f.close);
  const first = await f.connect(await f.login()); await ready(first);
  // The phone gets a typed error instead of a bare 409 that looks like a dropped network.
  const second = await f.connect(await f.login(), null);
  await until(() => second.messages.some(m => m.type === "error"));
  const err = second.messages.find(m => m.type === "error");
  assert.equal(err.code, "busy_elsewhere"); assert.equal(err.fatal, true);
  await until(() => second.readyState === WebSocket.CLOSED);
  assert.equal(f.runtime.conversations.size, 1, "the running conversation is untouched");
  first.close();
});

test("a client of another app version is told to update", async t => {
  const f = await fixture(); t.after(f.close);
  const ws = await f.connect(await f.login(), { language_a: "sk", language_b: "de", client_version: "0.0.1" });
  await until(() => ws.messages.some(m => m.code === "client_outdated"));
  const current = await f.connect(await f.login(), { language_a: "sk", language_b: "de", client_version: require("../package.json").version });
  await ready(current); current.close();
});

test("a reconnect within the resume window does not use another daily session", async t => {
  const f = await fixture({ env: { MAX_USER_SESSIONS_PER_DAY: "1" } }); t.after(f.close);
  const cookie = await f.login();
  const first = await f.connect(cookie); await ready(first);
  first.close();
  await until(() => f.runtime.conversations.size === 0);
  const second = await f.connect(cookie, undefined, "/?resume=1"); await ready(second);
  second.close();
  await until(() => f.runtime.conversations.size === 0);
  // A conversation the user starts again is a new one, also within the resume window.
  const fresh = await f.connect(cookie);
  await until(() => fresh.messages.some(m => m.type === "error"));
  assert.equal(fresh.messages.find(m => m.type === "error").code, "quota_exceeded");
  // A different login has no conversation to resume and gets a readable quota error.
  const other = await f.connect(await f.login());
  await until(() => other.messages.some(m => m.type === "error"));
  const err = other.messages.find(m => m.type === "error");
  assert.equal(err.code, "quota_exceeded");
  assert.equal(err.fatal, true);
  assert.equal(err.conversation_id, other.messages.find(m => m.type === "session_open").conversation_id);
  // An unmasked client frame is a protocol error; it must not crash the server.
  const probeCookie = await f.login();
  await new Promise(resolve => {
    const { port } = new URL(f.url);
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write(["GET / HTTP/1.1", "Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "Origin: " + f.origin, "Cookie: " + probeCookie, "", ""].join("\r\n"));
      socket.write(Buffer.from([0x81, 0x01, 0x61]));
    });
    socket.on("error", () => {}); socket.on("close", resolve); socket.resume();
  });
  assert.equal((await f.request("/health")).status, 200);
});

test("transient Soniox errors are retryable and credit problems are final", async t => {
  const f = await fixture(); t.after(f.close);
  const cookie = await f.login();
  const first = await f.connect(cookie); await ready(first);
  // A transient error reopens the Soniox stream inside the same conversation, up to twice a minute.
  for (let i = 1; i <= 2; i++) {
    f.stt.at(-1).send(JSON.stringify({ error_code: 503, error_type: "service_unavailable", error_message: "busy", request_id: "req-" + i }));
    await until(() => f.stt.length === i + 1 && f.configs.length === i + 1);
  }
  assert.equal(f.runtime.conversations.size, 1); assert.ok(!first.messages.some(m => m.type === "error"));
  f.stt.at(-1).send(JSON.stringify({ error_code: 503, error_type: "service_unavailable", error_message: "busy", request_id: "req-3" }));
  await until(() => first.messages.some(m => m.type === "error"));
  assert.equal(first.messages.find(m => m.type === "error").code, "stt_retry", "then the client's reconnect takes over");
  await until(() => f.runtime.conversations.size === 0);
  const second = await f.connect(cookie); await ready(second);
  f.stt.at(-1).send(JSON.stringify({ error_code: 402, error_message: "no balance" }));
  await until(() => second.messages.some(m => m.type === "error"));
  assert.equal(second.messages.find(m => m.type === "error").code, "provider_credit");
  const diagnostics = await (await f.request("/api/diagnostics", undefined, cookie)).json();
  assert.equal(diagnostics.last_session_summary.provider_error.status, 402);
});
