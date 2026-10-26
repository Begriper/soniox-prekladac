"use strict";
const WebSocket = require("ws");
const { TTS_MODEL } = require("./runtime-models");
const { randomUUID } = require("node:crypto");
const TTS_AUDIO_FORMAT = "pcm_s16le";
const TTS_SAMPLE_RATE = 24000;
const normalizeTtsTransport = value => ["auto", "ws", "rest"].includes(String(value).toLowerCase()) ? String(value).toLowerCase() : "auto";
const createTtsStreamId = (prefix = "tts") => prefix + "-" + randomUUID();
class TtsWebSocketError extends Error {
  constructor(message, options = {}) {
    super(message); this.name = "TtsWebSocketError";
    this.audioStarted = Boolean(options.audioStarted);
    this.errorCode = options.errorCode || null;
    this.cancelled = Boolean(options.cancelled);
  }
}
class SonioxTtsWebSocket {
  constructor(options = {}) {
    Object.assign(this, {
      url: options.url, apiKey: options.apiKey, WebSocketImpl: options.WebSocketImpl || WebSocket,
      connectTimeoutMs: options.connectTimeoutMs ?? 3000, keepAliveMs: options.keepAliveMs ?? 20000,
      firstAudioMs: options.firstAudioMs ?? 3000, idleAudioMs: options.idleAudioMs ?? 5000,
      totalMs: options.totalMs ?? 30000, onState: options.onState || (() => {}),
      onMetric: options.onMetric || (() => {}),
      ws: null, connectPromise: null, streams: new Map(), epoch: 0, reconnects: 0,
    });
  }
  get readyState() { return this.ws?.readyState ?? this.WebSocketImpl.CLOSED; }
  snapshot() { return { ready_state: this.readyState, active_streams: [...this.streams.values()].filter(s => s.active).length, prewarmed_streams: [...this.streams.values()].filter(s => !s.active).length, reconnects: this.reconnects }; }
  connect() {
    if (this.readyState === this.WebSocketImpl.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    const ws = new this.WebSocketImpl(this.url, { maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
    this.ws = ws;
    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = err => {
        if (settled) return; settled = true; clearTimeout(timer);
        this.connectPromise = null; this.rejectConnect = null;
        err ? reject(err) : resolve();
      };
      this.rejectConnect = () => finish(new TtsWebSocketError("Cancelled", { cancelled: true }));
      const timer = setTimeout(() => { finish(new TtsWebSocketError("Connect timeout")); ws.terminate(); }, this.connectTimeoutMs);
      ws.on("open", () => {
        if (this.ws !== ws) { ws.close(); return; }
        this.onState("open", this.snapshot());
        this.keepAlive = setInterval(() => { try { this.sendJson({ keep_alive: true }); } catch {} }, this.keepAliveMs);
        this.keepAlive.unref?.(); finish();
      });
      ws.on("message", data => { if (this.ws === ws) this.handleMessage(data); });
      ws.on("error", () => {
        if (this.ws !== ws) return;
        finish(new TtsWebSocketError("Connection error"));
        for (const s of [...this.streams.values()]) this.fail(s, new TtsWebSocketError("Connection error", { audioStarted: s.audioStarted }));
        ws.terminate();
      });
      ws.on("close", () => {
        finish(new TtsWebSocketError("Connection closed"));
        if (this.ws !== ws) return;
        clearInterval(this.keepAlive); this.ws = null; this.reconnects++;
        for (const s of [...this.streams.values()]) this.fail(s, new TtsWebSocketError("Connection closed", { audioStarted: s.audioStarted }));
        this.onState("closed", this.snapshot());
      });
    });
    return this.connectPromise;
  }
  sendJson(payload) {
    if (this.readyState !== this.WebSocketImpl.OPEN) throw new TtsWebSocketError("Connection unavailable");
    this.ws.send(JSON.stringify(payload));
  }
  createStreamConfig({ streamId, language, voice }) {
    return { api_key: this.apiKey, stream_id: streamId, model: TTS_MODEL, language, voice, audio_format: TTS_AUDIO_FORMAT, sample_rate: TTS_SAMPLE_RATE };
  }
  async prewarm(configs = []) {
    const epoch = this.epoch;
    await this.connect();
    if (epoch !== this.epoch) return;
    for (const config of configs.slice(0, 2)) {
      if (this.streams.size >= 4 || [...this.streams.values()].some(s => s.language === config.language && s.voice === config.voice)) continue;
      const streamId = createTtsStreamId("prewarm");
      const stream = { streamId, ...config, active: false, audioStarted: false };
      this.streams.set(streamId, stream);
      this.sendJson(this.createStreamConfig(stream));
    }
  }
  async synthesize(options = {}) {
    const epoch = this.epoch;
    await this.connect();
    if (epoch !== this.epoch || options.signal?.aborted) throw new TtsWebSocketError("Cancelled", { cancelled: true });
    const language = options.language || "en", voice = options.voice || "Adrian";
    let stream = [...this.streams.values()].find(s => !s.active && s.language === language && s.voice === voice);
    const isNew = !stream;
    if (!stream) stream = { streamId: createTtsStreamId(), language, voice };
    Object.assign(stream, { active: true, audioStarted: false, audioBytes: 0, audioChunks: 0, signal: options.signal, onAudio: options.onAudio || (() => {}) });
    this.streams.set(stream.streamId, stream);
    return new Promise((resolve, reject) => {
      stream.resolve = resolve; stream.reject = reject;
      stream.abort = () => this.fail(stream, new TtsWebSocketError("Cancelled", { cancelled: true, audioStarted: stream.audioStarted }));
      options.signal?.addEventListener("abort", stream.abort, { once: true });
      const timeout = () => this.fail(stream, new TtsWebSocketError("Audio timeout", { audioStarted: stream.audioStarted }));
      stream.waitTimer = setTimeout(timeout, this.firstAudioMs);
      stream.totalTimer = setTimeout(timeout, options.parts ? Math.max(this.totalMs, 120000) : this.totalMs);
      try {
        if (isNew) this.sendJson(this.createStreamConfig(stream));
        options.onStart?.({ streamId: stream.streamId, format: TTS_AUDIO_FORMAT, sampleRate: TTS_SAMPLE_RATE });
        if (options.parts) {
          void (async () => {
            try {
              for await (const part of options.parts) {
                if (!this.streams.has(stream.streamId)) return;
                if (part) this.sendJson({ stream_id: stream.streamId, text: String(part), text_end: false });
              }
              if (this.streams.has(stream.streamId)) this.sendJson({ stream_id: stream.streamId, text: "", text_end: true });
            } catch (err) { this.fail(stream, err); }
          })();
        } else this.sendJson({ stream_id: stream.streamId, text: String(options.text || ""), text_end: true });
      } catch (err) { this.fail(stream, err); }
    });
  }
  cleanup(stream) {
    clearTimeout(stream.waitTimer); clearTimeout(stream.totalTimer);
    stream.signal?.removeEventListener("abort", stream.abort);
    this.streams.delete(stream.streamId);
  }
  fail(stream, err) {
    if (!this.streams.has(stream.streamId)) return;
    this.cleanup(stream);
    try { this.sendJson({ stream_id: stream.streamId, cancel: true }); } catch {}
    err.audioStarted = Boolean(err.audioStarted || stream.audioStarted);
    if (stream.active) stream.reject(err);
  }
  handleMessage(data) {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const stream = this.streams.get(msg.stream_id);
    if (!stream) {
      if (msg.error_code && !msg.stream_id) for (const s of [...this.streams.values()]) this.fail(s, new TtsWebSocketError("Provider rejected request", { errorCode: msg.error_code, audioStarted: s.audioStarted }));
      return;
    }
    if (msg.error_code || msg.error_message) {
      this.fail(stream, new TtsWebSocketError("Provider rejected request", { errorCode: msg.error_code, audioStarted: stream.audioStarted })); return;
    }
    if (stream.active && typeof msg.audio === "string" && msg.audio) {
      const audio = Buffer.from(msg.audio, "base64");
      if (audio.length) {
        stream.audioStarted = true; stream.audioBytes += audio.length; stream.audioChunks++;
        clearTimeout(stream.waitTimer);
        stream.waitTimer = setTimeout(() => this.fail(stream, new TtsWebSocketError("Audio stalled", { audioStarted: true })), this.idleAudioMs);
        try { stream.onAudio(audio, { streamId: stream.streamId, audioEnd: Boolean(msg.audio_end) }); }
        catch (err) { this.fail(stream, err); return; }
      }
    }
    if (msg.terminated && this.streams.has(stream.streamId)) {
      this.cleanup(stream);
      if (stream.active) {
        if (!stream.audioStarted) stream.reject(new TtsWebSocketError("Empty audio"));
        else stream.resolve({ streamId: stream.streamId, audioStarted: true, audioBytes: stream.audioBytes, audioChunks: stream.audioChunks });
      }
    }
  }
  cancelActive() {
    this.epoch++;
    for (const s of [...this.streams.values()]) if (s.active) this.fail(s, new TtsWebSocketError("Cancelled", { cancelled: true, audioStarted: s.audioStarted }));
  }
  close() {
    this.cancelActive(); this.rejectConnect?.(); clearInterval(this.keepAlive);
    for (const s of this.streams.values()) this.cleanup(s);
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.readyState === this.WebSocketImpl.CONNECTING ? ws.terminate() : ws.close(); } catch {} }
  }
}
function isTransportFailure(err) {
  return !err.cancelled && ![400, 401, 402, 403, 404, 413, 422, 429].includes(Number(err.errorCode)) &&
    !["invalid_request", "unauthorized", "quota_exceeded", "rate_limit_exceeded", "client_unavailable"].includes(err.errorCode);
}
module.exports = { SonioxTtsWebSocket, TTS_AUDIO_FORMAT, TTS_MODEL, TTS_SAMPLE_RATE, TtsWebSocketError, createTtsStreamId, normalizeTtsTransport, isTransportFailure };

