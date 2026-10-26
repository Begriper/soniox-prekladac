const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  SonioxTtsWebSocket,
  normalizeTtsTransport,
} = require("../tts-transport");

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    });
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", 1000, Buffer.from("closed"));
  }

  terminate() {
    this.close();
  }

  receive(payload) {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function createClient(options = {}) {
  MockWebSocket.instances = [];
  return new SonioxTtsWebSocket({
    url: "wss://tts.example.test/tts-websocket",
    apiKey: "test-key",
    WebSocketImpl: MockWebSocket,
    connectTimeoutMs: 100,
    keepAliveMs: 60000,
    ...options,
  });
}

test("normalizeTtsTransport accepts supported modes and defaults invalid values", () => {
  assert.equal(normalizeTtsTransport("AUTO"), "auto");
  assert.equal(normalizeTtsTransport("ws"), "ws");
  assert.equal(normalizeTtsTransport("rest"), "rest");
  assert.equal(normalizeTtsTransport("invalid"), "auto");
});

test("prewarm config is reused and PCM chunks are streamed before termination", async () => {
  const client = createClient();
  await client.prewarm([{ language: "de", voice: "Adrian" }]);
  const socket = MockWebSocket.instances[0];
  const config = socket.sent[0];

  assert.equal(config.audio_format, "pcm_s16le");
  assert.equal(config.sample_rate, 24000);
  assert.equal(config.language, "de");

  const audioChunks = [];
  const synthesis = client.synthesize({
    text: "Guten Tag",
    language: "de",
    voice: "Adrian",
    onAudio: (audio) => audioChunks.push(audio),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const textMessage = socket.sent.find((message) => message.text === "Guten Tag");
  assert.equal(textMessage.stream_id, config.stream_id);
  assert.equal(textMessage.text_end, true);

  socket.receive({ stream_id: config.stream_id, audio: Buffer.from([1, 2, 3, 4]).toString("base64") });
  assert.equal(audioChunks.length, 1);
  socket.receive({ stream_id: config.stream_id, terminated: true });

  const result = await synthesis;
  assert.equal(result.audioStarted, true);
  assert.equal(result.audioBytes, 4);
  assert.equal(result.audioChunks, 1);
  client.close();
});

test("stream error reports whether fallback is safe before first audio", async () => {
  const client = createClient();
  const synthesis = client.synthesize({ text: "Hallo", language: "de", voice: "Adrian" });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = MockWebSocket.instances[0];
  const textMessage = socket.sent.find((message) => message.text === "Hallo");

  socket.receive({
    stream_id: textMessage.stream_id,
    error_code: 503,
    error_message: "temporarily unavailable",
  });

  await assert.rejects(synthesis, (err) => {
    assert.equal(err.audioStarted, false);
    assert.equal(err.errorCode, 503);
    return true;
  });
  client.close();
});

test("cancelActive sends a stream-scoped cancel message", async () => {
  const client = createClient();
  const synthesis = client.synthesize({ text: "Stop me", language: "en", voice: "Maya" });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = MockWebSocket.instances[0];
  const textMessage = socket.sent.find((message) => message.text === "Stop me");

  client.cancelActive();
  assert.ok(socket.sent.some((message) => message.stream_id === textMessage.stream_id && message.cancel === true));
  await assert.rejects(synthesis, (err) => {
    assert.equal(err.cancelled, true);
    assert.equal(err.audioStarted, false);
    return true;
  });
  client.close();
});

test("connection loss after PCM started rejects without allowing duplicate fallback", async () => {
  const client = createClient();
  const synthesis = client.synthesize({ text: "Partial", language: "en", voice: "Maya" });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = MockWebSocket.instances[0];
  const textMessage = socket.sent.find((message) => message.text === "Partial");

  socket.receive({ stream_id: textMessage.stream_id, audio: Buffer.from([1, 2]).toString("base64") });
  socket.close();

  await assert.rejects(synthesis, (err) => {
    assert.equal(err.audioStarted, true);
    return true;
  });
});
test("a new TTS stream reconnects after an unexpected socket close", async () => {
  const client = createClient();
  const first = client.synthesize({ text: "First", language: "en", voice: "Maya" });
  await new Promise((resolve) => setImmediate(resolve));
  MockWebSocket.instances[0].close();
  await assert.rejects(first);

  const second = client.synthesize({ text: "Second", language: "en", voice: "Maya" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(MockWebSocket.instances.length, 2);
  const secondSocket = MockWebSocket.instances[1];
  const textMessage = secondSocket.sent.find((message) => message.text === "Second");
  secondSocket.receive({ stream_id: textMessage.stream_id, audio: Buffer.from([3, 4]).toString("base64") });
  secondSocket.receive({ stream_id: textMessage.stream_id, terminated: true });

  const result = await second;
  assert.equal(result.audioBytes, 2);
  assert.equal(client.snapshot().reconnects, 1);
  client.close();
});

test("first audio deadline cancels the stream before fallback", async () => {
  const client = createClient({ firstAudioMs: 20 });
  try {
    await assert.rejects(client.synthesize({ text: "timeout", language: "en" }), err => !err.audioStarted && /timeout/.test(err.message));
    assert.ok(MockWebSocket.instances[0].sent.some(m => m.cancel));
  } finally { client.close(); }
});
test("idle audio deadline preserves partial-playback failure", async () => {
  const client = createClient({ idleAudioMs: 20 });
  const promise = client.synthesize({ text: "partial", language: "en" });
  const rejected = assert.rejects(promise, err => err.audioStarted && /stalled/.test(err.message));
  await new Promise(r => setImmediate(r));
  const ws = MockWebSocket.instances[0], msg = ws.sent.find(m => m.text_end);
  ws.receive({ stream_id: msg.stream_id, audio: Buffer.from([1,2]).toString("base64") });
  await rejected; client.close();
});
test("total deadline ends an otherwise continuously active stream", async () => {
  const client = createClient({ totalMs: 50, idleAudioMs: 100 });
  const promise = client.synthesize({ text: "ongoing", language: "en" });
  const rejected = assert.rejects(promise, err => err.audioStarted);
  await new Promise(r => setImmediate(r));
  const ws = MockWebSocket.instances[0], msg = ws.sent.find(m => m.text_end);
  const timer = setInterval(() => ws.receive({stream_id:msg.stream_id,audio:Buffer.from([0,1]).toString("base64")}),5);
  try { await rejected; } finally { clearInterval(timer); client.close(); }
});
test("cancelling while connecting sends no later synthesis text", async () => {
  const client = createClient();
  const promise = client.synthesize({text:"must not speak"});
  client.cancelActive();
  await assert.rejects(promise, err => err.cancelled);
  assert.equal(MockWebSocket.instances[0].sent.filter(m=>m.text_end).length,0);
  client.close();
});

test("late error from cancelled stream cannot fail the next synthesis", async () => {
  const client = createClient();
  const first = client.synthesize({text:"cancelled"});
  const rejected = assert.rejects(first);
  await new Promise(r=>setImmediate(r));
  const ws=MockWebSocket.instances[0], old=ws.sent.find(m=>m.text_end).stream_id;
  client.cancelActive(); await rejected;
  const next=client.synthesize({text:"current"});
  await new Promise(r=>setImmediate(r));
  const id=ws.sent.find(m=>m.text==="current").stream_id;
  ws.receive({stream_id:old,error_code:401});
  ws.receive({stream_id:id,audio:Buffer.from([1,2]).toString("base64")});
  ws.receive({stream_id:id,terminated:true});
  assert.equal((await next).audioBytes,2);client.close();
});
