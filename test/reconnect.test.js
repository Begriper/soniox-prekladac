"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const WebSocket = require("ws");
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

test("another login of the same user is still refused while a conversation runs", async t => {
  const f = await fixture(); t.after(f.close);
  const first = await f.connect(await f.login()); await ready(first);
  assert.equal(await refused(f, await f.login()), 409);
  first.close();
});

test("a reconnect within the resume window does not use another daily session", async t => {
  const f = await fixture({ env: { MAX_USER_SESSIONS_PER_DAY: "1" } }); t.after(f.close);
  const cookie = await f.login();
  const first = await f.connect(cookie); await ready(first);
  first.close();
  await until(() => f.runtime.conversations.size === 0);
  const second = await f.connect(cookie); await ready(second);
  second.close();
  await until(() => f.runtime.conversations.size === 0);
  // A different login has no conversation to resume and gets a readable quota error.
  const other = await f.connect(await f.login());
  await until(() => other.messages.some(m => m.type === "error"));
  const err = other.messages.find(m => m.type === "error");
  assert.equal(err.code, "quota_exceeded");
  assert.equal(err.fatal, true);
  assert.equal(err.conversation_id, other.messages.find(m => m.type === "session_open").conversation_id);
});

test("transient Soniox errors are retryable and credit problems are final", async t => {
  const f = await fixture(); t.after(f.close);
  const cookie = await f.login();
  const first = await f.connect(cookie); await ready(first);
  f.stt.at(-1).send(JSON.stringify({ error_code: 503, error_type: "service_unavailable", error_message: "busy", request_id: "req-1" }));
  await until(() => first.messages.some(m => m.type === "error"));
  assert.equal(first.messages.find(m => m.type === "error").code, "stt_retry");
  await until(() => f.runtime.conversations.size === 0);
  const second = await f.connect(cookie); await ready(second);
  f.stt.at(-1).send(JSON.stringify({ error_code: 402, error_message: "no balance" }));
  await until(() => second.messages.some(m => m.type === "error"));
  assert.equal(second.messages.find(m => m.type === "error").code, "provider_credit");
  const diagnostics = await (await f.request("/api/diagnostics", undefined, cookie)).json();
  assert.equal(diagnostics.last_session_summary.provider_error.status, 402);
});
