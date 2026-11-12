"use strict";
const WebSocket = require("ws");
const { randomUUID } = require("node:crypto");
const { STT_MODEL, TTS_MODEL } = require("./runtime-models");
const { parseMessage } = require("./security");
const { contextFor } = require("./context-profiles");
const { SonioxTtsWebSocket, isTransportFailure } = require("./tts-transport");
const { synthesizeRest } = require("./tts-rest");
const TTS_PAUSE_MS = 2000;
// Voice audio waits in memory while the phone's socket buffer is full instead of failing on a slow network.
const CLIENT_BUFFER_BYTES = 256 * 1024, OUTBOX_MAX_BYTES = 6 * 1024 * 1024;
// Microphone frames captured just before playback ended still carry the loudspeaker's tail.
const ECHO_GUARD_MS = 250;
// Listening can run for hours of dense speech; only the recent part of the transcript is kept on the server.
const LISTEN_KEEP_ITEMS = 400, LISTEN_KEEP_CHARS = 30000;
// A session may open several streams per spoken utterance (pauses, fallback); this bounds runaway retries only.
const STREAMS_PER_ITEM_BUDGET = 4;
// Microphone bytes are reserved in batches: a database transaction per 64 ms frame blocked the event loop.
const AUDIO_RESERVE_BATCH = 64 * 1024;
const { createConversationTimelineState, appendConversationToken, clearConversationNonFinalText, markConversationEndpoint, serializeConversationItems, chunkTextForTts } = require("./server-utils");

class SpeechSession {
  constructor(client, options) {
    Object.assign(this, options);
    this.client = client; this.id = randomUUID(); this.closed = false; this.configured = false;
    this.timeline = createConversationTimelineState({ maxItems: 1000 });
    this.suppressed = new Set(); this.pending = new Map(); this.queue = []; this.playback = null; this.localPlayback = null;
    this.preparingJob = null; this.audioGeneration = 0; this.prewarmed = new Set(); this.sentItems = new Map();
    this.languageA = "sk"; this.languageB = "de"; this.outputMode = "speaker"; this.ttsEnabled = true;
    this.mode = "conversation"; this.listenSource = "auto"; this.finishReason = null;
    this.voiceA = "Adrian"; this.voiceB = "Adrian"; this.ttsSpeed = 1; this.stt = null; this.generation = 0;
    this.profileId = "conversation"; this.conversationMode = "auto"; this.pttActive = false; this.lastFinalizeAt = 0;
    this.acceptAudio = false; this.finishing = false; this.sttFinished = false;
    this.lastActivity = Date.now(); this.startedAt = Date.now(); this.candidate = null;
    this.sessionAudio = 0; this.sessionTtsBytes = 0; this.sessionTtsRequests = 0; this.spokenItems = new Set(); this.voiceLimitNotified = false; this.audioUnreserved = 0; this.utterance = 0;
    this.sessionTtsChars = 0; this.sessionSttSeconds = 0; this.endCode = "client_closed";
    this.ttsFailures = 0; this.restUntil = 0; this.audioStates = new Map(); this.endpointTimes = new Map();
    this.timings = []; this.timerSet = new Set(); this.isAlive = true; this.frameCount = 0;
    this.outbox = []; this.outboxBytes = 0; this.outboxTimer = null; this.drainWaiters = []; this.echoUntil = 0;
    this.synthesis = new SonioxTtsWebSocket({ url: this.urls.ttsWs, apiKey: this.apiKey, clientReferenceId: this.auth.username });
    this.configTimer = this.later(() => this.end("Konfigurácia neprišla včas."), 12000);
    this.scheduleExpiry();
    this.limitTimer = this.later(() => this.stop("limit"), this.limits.sessionMs);
    this.heartbeat = setInterval(() => {
      if (!this.isAlive) { this.close(); client.terminate(); return; }
      this.isAlive = false; client.ping();
    }, 10000);
    this.tick = setInterval(() => this.guard(() => {
      this.frameCount = 0;
      if (this.closed) return;
      this.releaseStaleHeld();
      if (!this.finishing && Date.now() - this.lastActivity > this.idleMs() && !this.playback) { this.stop("idle"); return; }
      if (!this.reserveAudio()) { this.stop(); return; }
      if (this.stt?.readyState === WebSocket.OPEN && !this.sttFinished) {
        if (!this.reserve({ sttSeconds: 10 })) return;
        if (this.needsKeepalive()) this.stt.send(JSON.stringify({ type: "keepalive" }));
      }
    }), 10000);
    client.on("pong", () => { this.isAlive = true; });
    client.on("error", () => this.close());
    client.on("close", () => this.close());
    client.on("message", (data, binary) => this.guard(() => {
      if (++this.frameCount > 1000) { this.end("Príliš veľa správ."); return; }
      if (binary) this.audio(data); else this.message(data);
    }));
    this.send({ type: "session_open", conversation_id: this.id, model: TTS_MODEL });
  }
  scheduleExpiry() {
    const remaining = this.auth.expiresAt - Date.now();
    this.expiryTimer = this.later(() => {
      if (remaining <= 2147483647) this.end("Prihlásenie vypršalo.", "auth_expired");
      else this.scheduleExpiry();
    }, Math.max(1, Math.min(remaining, 2147483647)));
  }
  later(fn, ms) {
    const timer = setTimeout(() => { this.timerSet.delete(timer); this.guard(fn); }, ms);
    this.timerSet.add(timer); return timer;
  }
  guard(fn) { try { fn(); } catch { this.end("Operácia zlyhala. Obnov rozhovor.", "internal_error"); } }
  send(data) {
    if (this.closed || this.client.readyState !== WebSocket.OPEN) return;
    if (this.client.bufferedAmount > 512 * 1024) { this.close(); this.client.close(1013, "slow connection"); return; }
    this.client.send(JSON.stringify({ ...data, conversation_id: this.id }));
  }
  reserve(patch) {
    try { if (this.store.reserve(this.auth.username, patch)) {
      this.sessionTtsChars += patch.ttsChars || 0; this.sessionSttSeconds += patch.sttSeconds || 0;
      return true;
    } }
    catch { this.end("Účtovanie spotreby nie je dostupné.", "usage_unavailable"); return false; }
    const reason = this.store.lastRefusal;
    this.end(reason === "month" ? "Mesačný limit rozpoznávania tohto účtu je vyčerpaný. Obnoví sa 1. dňa ďalšieho mesiaca (UTC); zvýšiť ho môže admin."
      : reason === "household" ? "Denný limit celej domácnosti je vyčerpaný. Obnoví sa o polnoci UTC."
      : "Denný limit tohto účtu je vyčerpaný. Obnoví sa o polnoci UTC.", "quota_exceeded"); return false;
  }
  // Moves the not yet reserved microphone bytes into the daily quota; false when the quota is exhausted.
  reserveAudio() {
    const bytes = this.audioUnreserved; if (!bytes) return true;
    if (!this.reserve({ audioBytes: bytes })) return false;
    this.audioUnreserved = 0; return true;
  }
  idleMs() { return this.mode === "listen" ? this.limits.listenIdleMs ?? 300000 : this.limits.idleMs; }
  fullDuplex() { return this.mode === "listen" || this.outputMode === "headphones"; }
  muted() { return !this.fullDuplex() && Boolean((this.playback?.audioStarted && !this.playback.held) || this.localPlayback); }
  // Until the phone confirms that the voice plays (a suspended iPhone audio may wait for a tap), it gets a longer grace.
  armPlaybackTimer(op) {
    clearTimeout(op.timer);
    op.timer = this.later(() => this.playbackDone({ playback_id: op.id, status: "interrupted" }), Math.ceil(op.bytes / 48000 * 1000) + (op.audibleAt ? 15000 : 60000));
  }
  // A prepared voice whose sentence never got an endpoint is played once nothing new was recognized for 15 s,
  // instead of blocking the queue. While the speaker keeps talking it stays held: playing it would mute the
  // speaker microphone in the middle of a long sentence.
  releaseStaleHeld(now = Date.now()) {
    const op = this.playback;
    if (!op || now - Math.max(op.started, this.lastActivity) <= 15000) return;
    if (op.held) this.releaseHeld();
    // The text is as complete as it will get; a REST fallback waits for exactly that before it starts.
    if (!op.job.ended) this.flushPending();
  }
  // Releases audio prepared before the end of the sentence: the start message, the buffered chunks, then live streaming.
  releaseHeld() {
    const op = this.playback;
    if (!op?.held) return;
    op.held = false;
    if (op.startMessage) this.send({ ...op.startMessage, text: op.job.text });
    try { for (const buffer of op.heldAudio.splice(0)) this.sendAudio(op, buffer); }
    catch { this.cancelAudio(); return; }
    if (op.bytes) { op.audioStarted = true; this.finalizeBeforeMute(); }
    op.release?.(); this.state();
  }
  guardEcho() { if (!this.fullDuplex()) this.echoUntil = Date.now() + ECHO_GUARD_MS; }
  sendAudio(op, buffer) {
    if (this.outboxBytes + buffer.length > OUTBOX_MAX_BYTES) throw Object.assign(new Error("slow client"), { errorCode: "client_unavailable" });
    this.outbox.push({ op, buffer }); this.outboxBytes += buffer.length;
    this.flushOutbox();
  }
  flushOutbox() {
    while (this.outbox.length && !this.closed && this.client.readyState === WebSocket.OPEN && this.client.bufferedAmount < CLIENT_BUFFER_BYTES) {
      const { op, buffer } = this.outbox.shift(); this.outboxBytes -= buffer.length;
      if (this.playback === op && !op.abort.signal.aborted) this.client.send(buffer, { binary: true });
    }
    if (this.outbox.length && !this.closed && !this.outboxTimer) this.outboxTimer = setTimeout(() => { this.outboxTimer = null; this.guard(() => this.flushOutbox()); }, 20);
    if (!this.outbox.length || this.closed) { for (const resolve of this.drainWaiters.splice(0)) resolve(); }
  }
  clearOutbox() {
    this.outbox = []; this.outboxBytes = 0; clearTimeout(this.outboxTimer); this.outboxTimer = null;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
  drainAudio() { return this.outbox.length && !this.closed ? new Promise(resolve => this.drainWaiters.push(resolve)) : Promise.resolve(); }
  // Soniox closes the stream after 20 s without audio or keepalive; PTT drops audio while released.
  needsKeepalive() { return !this.acceptAudio || this.muted() || (this.conversationMode === "ptt" && !this.pttActive); }
  state() {
    // A voice prepared in advance (held) is not speaking yet: the microphone stays open and the UI shows translating.
    const speaking = (this.playback && !this.playback.held) || this.localPlayback;
    this.send({ type: "state", state: this.finishing ? "finishing" : this.candidate ? "confirm_language" : speaking ? "speaking" : this.acceptAudio && this.pending.size ? "translating" : this.acceptAudio ? "listening" : "connecting", microphone_muted: this.muted(), accept_audio: this.acceptAudio });
  }
  snapshot() {
    const latency = {};
    for (const transport of ["websocket", "rest"]) {
      const values = this.timings.filter(t => t.transport === transport && Number.isFinite(t.endpoint_to_playback_ack_ms)).map(t => t.endpoint_to_playback_ack_ms).sort((a,b) => a-b);
      latency[transport] = { samples: values.length, median_ms: values.length ? values[Math.floor(values.length / 2)] : null, p95_ms: values.length ? values[Math.ceil(values.length * .95) - 1] : null };
    }
    const values = this.timings.map(t => t.endpoint_to_playback_ack_ms).filter(Number.isFinite).sort((a, b) => a - b), i = Math.floor(values.length / 2);
    return { id: this.id, started_at: new Date(this.startedAt).toISOString(), language_a: this.languageA, language_b: this.languageB, profile: this.profileId, stt_seconds: this.sessionSttSeconds, tts_chars: this.sessionTtsChars, end_code: this.endCode,
      latency_median_ms: values.length ? Math.round(values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2) : null,
      latency, duration_ms: Date.now() - this.startedAt, audio_bytes: this.sessionAudio, tts_requests: this.sessionTtsRequests, tts_audio_bytes: this.sessionTtsBytes, timings: this.timings.slice(-100), rest_until: this.restUntil, provider_error: this.lastProviderError || null };
  }
  // Sends only items that changed since the last update; long conversations would otherwise
  // resend the whole transcript several times a second over mobile data.
  updateItems(reset = false) {
    if (reset) this.sentItems.clear();
    const changed = [];
    for (const i of serializeConversationItems(this.timeline)) {
      const item = { ...i, audio_status: this.audioStates.get(i.id) || (this.ttsEnabled ? "pending" : "text_only") };
      const key = JSON.stringify(item);
      if (this.sentItems.get(item.id) !== key) { this.sentItems.set(item.id, key); changed.push(item); }
    }
    if (!changed.length && !reset) return;
    this.send({ type: "token", conversation_items: changed, reset, language_a: this.languageA, language_b: this.languageB });
  }
  validSettings(msg) {
    if (msg.language_a !== undefined && !this.catalog.hasLanguage(msg.language_a)) return false;
    if (msg.language_b !== undefined && msg.language_b !== "auto" && !this.catalog.hasLanguage(msg.language_b)) return false;
    if (msg.listen_source !== undefined && msg.listen_source !== "auto" && !this.catalog.hasLanguage(msg.listen_source)) return false;
    if (msg.profile_id !== undefined && !contextFor(msg.profile_id)) return false;
    return [msg.voice_a, msg.voice_b, msg.tts_voice].filter(Boolean).every(v => this.catalog.hasVoiceFor(this.auth.username, v));
  }
  message(raw) {
    const msg = parseMessage(raw);
    if (!msg) { this.end("Neplatná správa.", "invalid_message"); return; }
    if (msg.type === "config") {
      if (this.configured || !this.validSettings(msg)) { this.end("Neplatná konfigurácia."); return; }
      // An open page with an older app.js would mix protocol versions; the new client reloads on this code.
      if (msg.client_version !== undefined && this.appVersion && msg.client_version !== this.appVersion) { this.end("Je dostupná nová verzia appky. Zatvor ju a otvor znova.", "client_outdated"); return; }
      this.configured = true; clearTimeout(this.configTimer);
      this.languageA = msg.language_a || "sk"; this.languageB = msg.language_b || "de";
      this.mode = msg.mode || "conversation"; this.listenSource = msg.listen_source || "auto";
      if ((this.mode === "conversation" && this.languageA === this.languageB) || this.listenSource === this.languageA) { this.end("Vyber dva rôzne jazyky."); return; }
      this.voiceA = msg.voice_a || msg.tts_voice || "Adrian"; this.voiceB = msg.voice_b || msg.tts_voice || "Adrian";
      this.ttsSpeed = msg.tts_speed !== undefined ? Number(msg.tts_speed) : 1;
      this.ttsEnabled = msg.tts_enabled !== false; this.outputMode = msg.output_mode || "speaker";
      this.profileId = msg.profile_id || "conversation"; this.conversationMode = msg.conversation_mode || "auto";
      if (this.mode === "listen") this.conversationMode = "auto";
      this.startStt(); return;
    }
    if (!this.configured) { this.end("Najprv odošli konfiguráciu."); return; }
    if (msg.type === "playback_started") {
      const op = this.playback;
      if (op?.id === msg.playback_id && !op.audibleAt) { op.audibleAt = Date.now(); if (op.synthesisDone) this.armPlaybackTimer(op); }
      return;
    }
    if (msg.type === "playback_done") { this.playbackDone(msg); return; }
    if (msg.type === "stop_audio") { this.cancelAudio(msg.request_id); this.maybeFinish(); return; }
    if (msg.type === "client_stop") { this.stop(); return; }
    if (msg.type === "ptt_start" && this.conversationMode === "ptt" && !this.finishing) {
      this.pttActive = true; this.state(); return;
    }
    if (msg.type === "ptt_end" && this.conversationMode === "ptt" && this.pttActive && !this.finishing) {
      this.pttActive = false; this.state();
      // The client has already sent roughly 200 ms of silence before releasing.
      // Soniox asks not to finalize too often; a quick second release is finalized a moment later instead of never.
      // One timer at most, and the interval is checked again when it fires.
      const finalize = () => {
        this.finalizeTimer = null;
        if (this.stt?.readyState !== WebSocket.OPEN || this.pttActive || this.finishing) return;
        const wait = 500 - (Date.now() - this.lastFinalizeAt);
        if (wait > 0) { this.finalizeTimer = this.later(finalize, wait); return; }
        this.lastFinalizeAt = Date.now(); this.stt.send(JSON.stringify({ type: "finalize" }));
      };
      if (!this.finalizeTimer) finalize();
      return;
    }
    if (msg.type === "local_playback_end") {
      if (this.localPlayback === msg.playback_id) { this.localPlayback = null; clearTimeout(this.localTimer); this.guardEcho(); this.state(); this.pump(); } return;
    }
    if (this.finishing) return;
    if (msg.type === "local_playback_start") {
      if (this.playback || this.localPlayback || this.preparingJob || !msg.playback_id) { this.send({ type: "error", code: "busy", message: "Počkaj na koniec hlasu." }); return; }
      this.localPlayback = msg.playback_id; this.state();
      this.send({ type: "local_playback_ready", playback_id: msg.playback_id });
      this.localTimer = this.later(() => { this.localPlayback = null; this.state(); this.pump(); }, 120000); return;
    }
    if (msg.type === "confirm_language" && this.mode !== "listen") {
      if (!this.candidate || !this.catalog.hasLanguage(msg.language) || msg.language === this.languageA) return;
      this.languageB = msg.language; this.candidate = null; this.pending.clear();
      this.switching = true; this.acceptAudio = false; this.state();
      const old = this.stt; this.generation++; this.stt = null;
      if (old?.readyState === WebSocket.OPEN) { old.send(""); old.close(); }
      else old?.terminate();
      this.send({ type: "language_confirmed", language: this.languageB });
      this.startStt(); return;
    }
    if (msg.type === "update_settings") {
      if (!this.validSettings(msg)) { this.send({ type: "error", message: "Hlas nie je dostupný." }); return; }
      this.voiceA = msg.voice_a || this.voiceA; this.voiceB = msg.voice_b || this.voiceB;
      if (msg.tts_speed !== undefined) this.ttsSpeed = Number(msg.tts_speed);
      this.outputMode = msg.output_mode || this.outputMode; this.ttsEnabled = msg.tts_enabled ?? this.ttsEnabled;
      if (!this.ttsEnabled) this.cancelAudio(); this.state(); return;
    }
    if (msg.type === "clear_text") {
      this.cancelAudio(); this.timeline.items = []; this.timeline.currentItemId = null; this.updateItems(true); return;
    }
    if (msg.type === "replay_translation") {
      const item = this.timeline.items.find(i => i.id === msg.item_id);
      if (!item) { this.send({ type: "error", code: "replay_unavailable", message: "Túto vetu už nemožno prehrať počas počúvania. Zastav počúvanie a prehraj ju znova." }); return; }
      if (!item.is_final || !item.translated_text.trim()) return;
      this.suppressed.delete(item.id); this.audioStates.delete(item.id);
      this.enqueue(item.translated_text, item.target_language, item.id); return;
    }
  }
  audio(data) {
    if (!this.acceptAudio || this.muted() || Date.now() < this.echoUntil || this.finishing || this.closed || (this.conversationMode === "ptt" && !this.pttActive)) return;
    if (!data.length || data.length % 2 || data.length > 16384) { this.end("Neplatný audio rámec."); return; }
    if (this.stt?.readyState !== WebSocket.OPEN) return;
    if (this.stt.bufferedAmount > 256 * 1024) { this.end("Spojenie nestíha prenášať zvuk. Obnov rozhovor.", "audio_overload"); return; }
    this.sessionAudio += data.length; this.audioUnreserved += data.length;
    if (this.sessionAudio > this.limits.sessionAudioBytes || (this.audioUnreserved >= AUDIO_RESERVE_BATCH && !this.reserveAudio())) { if (!this.closed) this.stop(); return; }
    this.stt.send(data, { binary: true });
  }
  startStt() {
    if (this.closed || this.finishing || !this.reserve({ sttSeconds: 10 })) return;
    const generation = ++this.generation;
    // Soniox refuses keys sent only in the start message from 15 Jan 2027.
    const socket = new WebSocket(this.urls.stt, { headers: { Authorization: "Bearer " + this.apiKey }, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
    this.stt = socket; this.sttFinished = false; this.acceptAudio = false; this.state();
    const current = () => !this.closed && this.stt === socket && this.generation === generation;
    const timer = this.later(() => { if (current()) this.end("Rozpoznávanie sa nepripojilo včas.", "stt_timeout"); }, 10000);
    socket.on("open", () => this.guard(() => {
      if (!current()) { socket.close(); return; } clearTimeout(timer);
      const listen = this.mode === "listen", auto = listen || this.languageB === "auto";
      // "Recognize language" still hints the own language, which keeps Slovak from being taken for Czech.
      const hints = listen ? (this.listenSource === "auto" ? [] : [this.listenSource]) : auto ? [this.languageA] : [this.languageA, this.languageB];
      socket.send(JSON.stringify({
        model: STT_MODEL, audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, client_reference_id: this.auth.username,
        ...(hints.length ? { language_hints: hints } : {}),
        enable_language_identification: true, enable_endpoint_detection: true,
        max_endpoint_delay_ms: this.endpoint.delay, endpoint_sensitivity: this.endpoint.sensitivity,
        endpoint_latency_adjustment_level: this.endpoint.level,
        translation: auto ? { type: "one_way", target_language: this.languageA } : { type: "two_way", language_a: this.languageA, language_b: this.languageB },
        context: contextFor(this.profileId),
      }));
      this.acceptAudio = true; this.send({ type: "server_ready" }); this.state();
      // Open the TTS connection early; streams are prewarmed per utterance because idle streams expire.
      if (this.ttsEnabled && (listen || !auto) && this.transport !== "rest") void this.synthesis.connect().catch(() => {});
    }));
    socket.on("message", raw => this.guard(() => {
      if (!current()) return;
      let result; try { result = JSON.parse(raw.toString()); } catch { this.end("Neplatná odpoveď rozpoznávania."); return; }
      if (!result || typeof result !== "object") return;
      if (result.error_code) { this.providerError(result); return; }
      this.tokens(result.tokens || []);
      if (result.finished) { this.sttFinished = true; this.acceptAudio = false; this.flushPending(); socket.close(); this.maybeFinish(); }
    }));
    // A refused handshake (bad key, no credit, overload) arrives as an HTTP status, not as a stream error.
    socket.on("unexpected-response", (request, response) => {
      response.resume(); request.destroy();
      if (current()) this.providerError({ error_code: response.statusCode, error_type: "handshake" });
    });
    socket.on("error", () => { if (current()) this.recoverStt("Spojenie s rozpoznávaním zlyhalo.", "stt_connection"); });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!current()) return;
      this.stt = null; this.acceptAudio = false;
      if (this.finishing || this.sttFinished) { this.sttFinished = true; this.flushPending(); this.maybeFinish(); }
      else this.recoverStt("Spojenie sa prerušilo. Posledná výpoveď nemusí byť úplná.", "stt_connection");
    });
  }
  // Listening mode keeps running, so the oldest items are dropped instead of ending the session.
  trimListenTimeline() {
    const t = this.timeline, size = i => i.source_text.length + i.translated_text.length;
    let total = t.items.reduce((n, i) => n + size(i), 0);
    while (t.items.length > 1 && (t.items.length > LISTEN_KEEP_ITEMS || total > LISTEN_KEEP_CHARS)) {
      const removed = t.items.shift(); total -= size(removed);
      if (removed.id === t.currentItemId) t.currentItemId = null;
      for (const map of [this.sentItems, this.audioStates, this.endpointTimes]) map.delete(removed.id);
      for (const set of [this.prewarmed, this.suppressed]) set.delete(removed.id);
    }
  }
  tokens(tokens) {
    if (!Array.isArray(tokens)) return;
    if (this.mode === "listen") this.trimListenTimeline();
    clearConversationNonFinalText(this.timeline);
    for (const token of tokens) {
      if (this.timeline.items.length >= 990) { this.send({ type: "error", code: "transcript_overload", message: "Rozhovor je plný. Ulož ho a začni nový; posledná časť sa nemusela zachovať." }); this.stop("error"); break; }
      if (!token || typeof token.text !== "string") continue;
      if (token.text === "<end>" || token.text === "<fin>") {
        const item = markConversationEndpoint(this.timeline);
        if (item) this.endpointTimes.set(item.id, Date.now());
        // The speaker stopped: a prepared voice may play, also when a language switch gave the endpoint to another item.
        this.utterance++; this.releaseHeld();
        this.flushPending();
        if (this.mode !== "listen" && this.languageB === "auto" && item?.source_language && item.source_language !== this.languageA && this.catalog.hasLanguage(item.source_language)) {
          this.candidate = item.source_language; this.acceptAudio = false;
          this.send({ type: "language_candidate", language: this.candidate }); this.state();
        }
        continue;
      }
      const result = appendConversationToken(this.timeline, token, { languageA: this.languageA, languageB: this.mode === "listen" ? "auto" : this.languageB });
      if (result.ignored) continue;
      if (token.translation_status === "translation" && !token.is_final) this.prewarmFor(result.item, token.language);
      if (token.is_final) this.lastActivity = Date.now();
      if (result.tts_text) {
        if (this.suppressed.has(result.item.id)) continue;
        if ((this.mode !== "listen" && this.languageB === "auto") || !this.ttsEnabled) { this.audioStates.set(result.item.id, "text_only"); continue; }
        const id = result.item.id;
        // A Soniox TTS stream belongs to one utterance and one translation direction.
        for (const [otherId] of this.pending) if (otherId !== id) this.flushOne(otherId);
        // A prepared voice still waits for the endpoint here: another item is no proof that the speaker stopped
        // (a foreign word mid-sentence opens one), and playing now would mute the microphone on the rest of the sentence.
        this.appendTtsPart(id, result.tts_language, result.tts_text);
      }
    }
    if (this.mode === "listen") this.trimListenTimeline();
    // In listening mode only a single oversized utterance without an endpoint can still exceed the cap.
    if (this.timeline.items.reduce((n, i) => n + i.source_text.length + i.translated_text.length, 0) > 40000 || this.timeline.items.length >= 990) {
      this.send({ type: "error", message: "Rozhovor je dlhý. Ulož ho a začni nový." }); this.stop("error");
    }
    this.updateItems(); this.state();
  }
  // Transient Soniox failures are retried by the client; account problems get a clear, final message.
  providerError(result) {
    const status = Number(result.error_code);
    this.lastProviderError = { status: Number.isFinite(status) ? status : null, type: String(result.error_type || "").slice(0, 80), request_id: String(result.request_id || "").slice(0, 120), at: new Date().toISOString() };
    if ([408, 429, 500, 502, 503].includes(status)) { this.recoverStt("Rozpoznávanie je dočasne nedostupné. Obnovujem…", "stt_retry"); return; }
    if (status === 402) { this.end("Kredit Soniox je vyčerpaný.", "provider_credit"); return; }
    this.end("Rozpoznávanie nie je dostupné.", "stt_provider_error");
  }
  // Reopens only the Soniox stream: the transcript, the voice queue and the voice playing now all continue.
  // Two recoveries per minute at most; after that the client's own reconnect takes over.
  recoverStt(message, code) {
    if (this.closed || this.finishing) return;
    const now = Date.now();
    this.sttRecoveries = (this.sttRecoveries || []).filter(at => now - at < 60000);
    if (this.sttRecoveries.length >= 2) { this.end(message, code); return; }
    this.sttRecoveries.push(now);
    const old = this.stt; this.generation++; this.stt = null; this.acceptAudio = false;
    try { old?.terminate(); } catch { /* already gone */ }
    // The interrupted sentence keeps what was final and is translated and spoken as it is.
    const item = markConversationEndpoint(this.timeline);
    if (item) this.endpointTimes.set(item.id, Date.now());
    this.utterance++; this.releaseHeld(); this.flushPending(); this.updateItems(); this.state();
    // Only if nothing else (a confirmed language) opened a new stream meanwhile: a second one would stay open unused.
    const generation = this.generation;
    this.later(() => { if (this.generation === generation && !this.stt) this.startStt(); }, 300);
  }
  // Speaker mode mutes the microphone while the voice plays. Anything the other person already said is finalized now,
  // so it is translated instead of being glued to what they say after the voice.
  finalizeBeforeMute() {
    if (this.fullDuplex() || this.stt?.readyState !== WebSocket.OPEN || Date.now() - this.lastFinalizeAt < 500) return;
    const current = this.timeline.items.find(i => i.id === this.timeline.currentItemId);
    if (!current || current.is_final || !(current.non_final_source_text || current.final_source_text || "").trim()) return;
    this.lastFinalizeAt = Date.now(); this.stt.send(JSON.stringify({ type: "finalize" }));
  }
  prewarmFor(item, language) {
    // Full-duplex playback starts before <end> and benefits from a prewarm.
    if (!item || !this.fullDuplex() || !this.ttsEnabled || (this.mode !== "listen" && this.languageB === "auto") || this.transport === "rest" || Date.now() < this.restUntil) return;
    if (this.prewarmed.has(item.id) || this.pending.has(item.id) || !this.catalog.canSpeak(language)) return;
    this.prewarmed.add(item.id);
    if (this.prewarmed.size > 200) this.prewarmed.delete(this.prewarmed.values().next().value);
    void this.synthesis.prewarm([{ language, voice: language === this.languageA ? this.voiceA : this.voiceB, speed: this.ttsSpeed }]).catch(() => {});
  }
  appendTtsPart(itemId, language, text) {
    if (!this.catalog.canSpeak(language, text)) {
      this.audioStates.set(itemId, "text_only"); this.suppressed.add(itemId);
      this.send({ type: "error", message: "Tento jazyk alebo zápis má iba textový výstup." }); return;
    }
    let job = this.pending.get(itemId);
    if (!job) {
      job = { text: "", parts: [], waiters: new Set(), ended: false, queued: false, utterance: this.utterance, language, itemId, voice: language === this.languageA ? this.voiceA : this.voiceB, speed: this.ttsSpeed };
      this.pending.set(itemId, job);
    }
    if (job.text.length + text.length > 5000) {
      this.suppressed.add(itemId); this.audioStates.set(itemId, "not_spoken");
      job.ended = true; this.notifyJob(job); this.pending.delete(itemId);
      this.send({ type: "error", code: "voice_overload", message: "Výpoveď je pre hlas príliš dlhá. Preklad zostáva v texte." }); return;
    }
    job.text += text; job.parts.push(text); this.notifyJob(job);
    // Speaker mode also starts synthesis right away; pump() holds the audio until the sentence ends,
    // so the voice can start immediately after the endpoint instead of after a fresh TTS request.
    this.queueJob(job);
  }
  queueJob(job) {
    if (job.queued || this.closed || !this.ttsEnabled) return;
    if (this.queue.length >= 5) {
      this.suppressed.add(job.itemId); this.audioStates.set(job.itemId, "not_spoken");
      job.ended = true; this.notifyJob(job); this.pending.delete(job.itemId);
      this.send({ type: "error", code: "voice_overload", message: "Hlas nestíha. Preklad zostal v texte." }); return;
    }
    job.queued = true; this.queue.push(job);
    this.audioStates.set(job.itemId, "queued"); this.pump();
  }
  flushOne(id) {
    const job = this.pending.get(id); if (!job) return;
    job.ended = true; this.notifyJob(job);
    if (job.text.trim()) this.queueJob(job); else this.pending.delete(id);
  }
  flushPending() { for (const [id] of this.pending) this.flushOne(id); }
  enqueue(text, language, itemId) {
    if (this.closed || !this.ttsEnabled) return;
    if (!this.catalog.canSpeak(language, text)) {
      this.audioStates.set(itemId, "text_only"); this.send({ type: "error", message: "Tento jazyk alebo zápis má iba textový výstup." }); this.updateItems(); return;
    }
    const chunks = chunkTextForTts(text, 900);
    if (this.queue.length + chunks.length > 5) {
      this.audioStates.set(itemId, "not_spoken");
      this.send({ type: "error", code: "voice_overload", message: "Hlas nestíha. Preklad zostal v texte." });
      this.updateItems(); return;
    }
    for (const chunk of chunks) {
      // replay: complete text of an earlier sentence, never held back.
      const job = { text: chunk, parts: [chunk], waiters: new Set(), ended: true, queued: false, replay: true, language, itemId, voice: language === this.languageA ? this.voiceA : this.voiceB, speed: this.ttsSpeed };
      this.queueJob(job);
    }
  }
  notifyJob(job) { for (const resolve of job.waiters) resolve(); job.waiters.clear(); }
  waitForChange(job, ms = 0) {
    return new Promise(resolve => {
      const done = changed => { clearTimeout(timer); job.waiters.delete(wake); resolve(changed); };
      const wake = () => done(true);
      const timer = ms ? setTimeout(() => done(false), ms) : null;
      job.waiters.add(wake);
    });
  }
  async *jobParts(job, op) {
    while (!op.abort.signal.aborted && !job.streamingFailed) {
      if (job.parts.length) {
        const part = job.parts.shift();
        if (!this.reserve({ ttsChars: [...part].length })) throw new Error("quota");
        yield part;
      } else if (job.ended) break;
      // A long pause mid-sentence would let Soniox and the idle-audio timer end the stream;
      // close it cleanly instead and let later text start a new stream for the same item.
      else if (!(await this.waitForChange(job, TTS_PAUSE_MS)) && !job.parts.length && !job.ended) { job.ended = true; break; }
    }
    if (!job.streamingFailed && this.pending.get(job.itemId) === job) this.pending.delete(job.itemId);
  }
  async waitForJob(job, signal) {
    while (!job.ended && !signal.aborted) await this.waitForChange(job);
  }
  cancelAudio(requestId) {
    this.audioGeneration++;
    if (this.preparingJob) { this.suppressed.add(this.preparingJob.itemId); this.audioStates.set(this.preparingJob.itemId, "not_spoken"); this.preparingJob.ended = true; this.notifyJob(this.preparingJob); }
    for (const [id, job] of this.pending) { this.suppressed.add(id); this.audioStates.set(id, "not_spoken"); job.ended = true; this.notifyJob(job); }
    for (const job of this.queue) this.suppressed.add(job.itemId);
    if (this.playback) this.suppressed.add(this.playback.job.itemId);
    this.pending.clear();
    for (const job of this.queue) this.audioStates.set(job.itemId, "not_spoken");
    this.queue = [];
    const op = this.playback; this.playback = null;
    if (op) { op.abort.abort(); op.job.ended = true; this.notifyJob(op.job); clearTimeout(op.timer); this.audioStates.set(op.job.itemId, "interrupted"); this.send({ type: "tts_stream_end", playback_id: op.id, cancelled: true }); }
    this.synthesis.cancelActive();
    this.localPlayback = null; clearTimeout(this.localTimer); this.clearOutbox();
    this.send({ type: "audio_cancelled", request_id: requestId }); this.updateItems(); this.state();
  }
  async pump() {
    if (this.closed || this.playback || this.localPlayback || this.preparingJob || !this.ttsEnabled) return;
    const job = this.queue.shift(); if (!job) { this.state(); this.maybeFinish(); return; }
    this.preparingJob = job;
    const audioGeneration = this.audioGeneration;
    await this.catalog.ensureVoices(job.voice);
    this.preparingJob = null;
    // Audio cancelled while the catalog refreshed: newer jobs may have queued behind this one.
    if (this.closed || audioGeneration !== this.audioGeneration || !this.ttsEnabled) { this.maybeFinish(); this.pump(); return; }
    // A local replay may have started while the catalog refreshed; this job waits for its end (local_playback_end pumps).
    if (this.localPlayback) { this.queue.unshift(job); this.state(); return; }
    if (!this.catalog.hasVoiceFor(this.auth.username, job.voice)) {
      this.audioStates.set(job.itemId, "not_spoken"); this.suppressed.add(job.itemId);
      job.ended = true; this.notifyJob(job); this.pending.delete(job.itemId);
      this.send({ type: "error", code: "voice_unavailable", message: "Vybraný hlas už nie je dostupný pre tento účet." });
      this.updateItems(); this.pump(); return;
    }
    // The cap counts spoken utterances, not streams: pauses and fallbacks split one utterance into several streams.
    if (!this.spokenItems.has(job.itemId) && this.spokenItems.size >= this.limits.sessionTtsRequests) {
      this.audioStates.set(job.itemId, "not_spoken"); this.suppressed.add(job.itemId);
      job.ended = true; this.notifyJob(job); this.pending.delete(job.itemId);
      // One message per session; later utterances stay in text without another error.
      if (!this.voiceLimitNotified) { this.voiceLimitNotified = true; this.send({ type: "error", code: "voice_limit", message: "Limit hlasu v tomto rozhovore bol vyčerpaný. Preklad pokračuje v texte; začni nový rozhovor." }); }
      this.updateItems(); this.pump(); return;
    }
    this.spokenItems.add(job.itemId);
    const op = { id: randomUUID(), job, abort: new AbortController(), started: Date.now(), audioStarted: false, bytes: 0, synthesisDone: false };
    // Speaker mode: the sentence is still being spoken, so its voice is prepared but held back.
    // An endpoint since its first words means the speaker has stopped, whichever item got that endpoint: a foreign word
    // splits a sentence into several items and only the last one is marked. Being the last item is not the test,
    // because a word briefly taken for the other language opens an empty item behind a sentence that still goes on.
    const item = this.timeline.items.find(i => i.id === job.itemId);
    op.held = !job.replay && !this.fullDuplex() && !this.finishing && job.utterance === this.utterance && !item?.is_final && !this.endpointTimes.has(job.itemId);
    op.heldAudio = [];
    op.released = op.held ? new Promise(resolve => { op.release = resolve; }) : null;
    this.playback = op; this.state();
    const current = () => !this.closed && this.playback === op && !op.abort.signal.aborted;
    const reserveAttempt = chars => {
      if (this.sessionTtsRequests >= this.limits.sessionTtsRequests * STREAMS_PER_ITEM_BUDGET) return false;
      if (!this.reserve({ ttsRequests: 1, ttsChars: chars })) return false;
      this.sessionTtsRequests++; return true;
    };
    const begin = transport => {
      op.transport = transport;
      const start = { type: "tts_stream_start", playback_id: op.id, utterance_id: job.itemId, format: "pcm_s16le", sample_rate: 24000, model: TTS_MODEL, voice: job.voice, speed: job.speed, language: job.language, transport, text: job.text };
      if (op.held) op.startMessage = start; else this.send(start);
    };
    const audio = buffer => {
      if (!current()) return;
      if (this.client.readyState !== WebSocket.OPEN) throw Object.assign(new Error("client closed"), { errorCode: "client_unavailable" });
      if (this.sessionTtsBytes + buffer.length > this.limits.sessionTtsBytes || !this.reserve({ ttsAudioBytes: buffer.length })) throw Object.assign(new Error("audio quota"), { errorCode: "quota_exceeded" });
      this.sessionTtsBytes += buffer.length; op.bytes += buffer.length;
      if (op.firstAudioMs === undefined) op.firstAudioMs = Date.now() - op.started;
      if (op.held) { op.heldAudio.push(buffer); return; }
      this.sendAudio(op, buffer);
      if (!op.audioStarted) {
        op.audioStarted = true;
        // The speaker microphone is muted from the first audible sample, not while waiting for it.
        this.finalizeBeforeMute(); this.state();
      }
    };
    try {
      let useRest = this.transport === "rest" || (this.transport === "auto" && Date.now() < this.restUntil);
      if (!useRest) {
        if (!reserveAttempt(0)) throw new Error("quota");
        try {
          await this.synthesis.synthesize({ ...job, parts: this.jobParts(job, op), signal: op.abort.signal, onStart: () => { if (current()) begin("websocket"); }, onAudio: audio });
          this.ttsFailures = 0;
        } catch (err) {
          if (!current()) return;
          job.streamingFailed = true; this.notifyJob(job);
          if (isTransportFailure(err)) { if (++this.ttsFailures >= 2) this.restUntil = Date.now() + 60000; }
          // Audio that is still held back never reached the phone, so the whole sentence can start again over REST.
          const heard = op.audioStarted || (err.audioStarted && !op.held);
          if (this.transport !== "auto" || heard || !isTransportFailure(err)) throw err;
          op.heldAudio = []; op.bytes = 0; op.firstAudioMs = undefined; op.startMessage = null;
          useRest = true;
          this.send({ type: "tts_fallback", playback_id: op.id });
        }
      }
      if (useRest) {
        await this.waitForJob(job, op.abort.signal);
        if (!current()) return;
        // This text is sent as it is; words recognized from now on start a new job instead of being lost.
        if (this.pending.get(job.itemId) === job) this.pending.delete(job.itemId);
        // REST receives the whole text again and may bill it again, so it is reserved in full.
        if (!reserveAttempt([...job.text].length)) throw new Error("quota");
        begin("rest");
        await synthesizeRest({ url: this.urls.ttsRest, apiKey: this.apiKey, clientReferenceId: this.auth.username, ...job, signal: op.abort.signal, onChunk: chunk => {
          for (let i = 0; i < chunk.length; i += 16384) audio(chunk.subarray(i, i + 16384));
        } });
      }
      // A voice prepared in advance waits for the end of its sentence (or a stop) before it is played.
      if (op.held) {
        await Promise.race([op.released, new Promise(resolve => op.abort.signal.addEventListener("abort", resolve, { once: true }))]);
        if (!current()) return;
      }
      // The end marker must follow the last audio chunk still waiting for a slow phone.
      await this.drainAudio();
      if (!current()) return;
      op.synthesisDone = true;
      this.send({ type: "tts_stream_end", playback_id: op.id, text: job.text });
      this.armPlaybackTimer(op);
    } catch {
      if (!current()) return;
      await this.drainAudio();
      if (!current()) return;
      job.ended = true; this.notifyJob(job);
      if (this.pending.get(job.itemId) === job) this.pending.delete(job.itemId);
      this.audioStates.set(job.itemId, "interrupted");
      op.synthesisDone = true;
      this.send({ type: "tts_stream_end", playback_id: op.id, interrupted: true });
      this.send({ type: "error", code: "voice_failed", message: "Hlas sa nepodarilo dokončiť. Preklad zostáva v texte." });
      if (!op.audioStarted) { this.playback = null; this.updateItems(); this.state(); this.pump(); }
      else this.armPlaybackTimer(op);
    }
  }
  playbackDone(msg) {
    const op = this.playback;
    if (!op || op.id !== msg.playback_id || !op.synthesisDone) return;
    clearTimeout(op.timer); this.playback = null; if (op.audioStarted) this.guardEcho();
    if (this.pending.get(op.job.itemId) === op.job) this.pending.delete(op.job.itemId);
    const previous = this.audioStates.get(op.job.itemId);
    const failed = msg.status !== "played" || ["interrupted", "not_spoken"].includes(previous);
    this.audioStates.set(op.job.itemId, failed ? (previous === "not_spoken" ? "not_spoken" : "interrupted") : this.queue.some(j => j.itemId === op.job.itemId) || this.pending.has(op.job.itemId) ? "queued" : "played");
    this.timings.push({ endpoint_to_playback_ack_ms: op.audibleAt && this.endpointTimes.has(op.job.itemId) ? op.audibleAt - this.endpointTimes.get(op.job.itemId) : null, transport: op.transport, first_audio_ms: op.firstAudioMs ?? null, endpoint_to_audio_ms: this.endpointTimes.has(op.job.itemId) ? op.started + (op.firstAudioMs || 0) - this.endpointTimes.get(op.job.itemId) : null });
    this.timings = this.timings.slice(-100); this.updateItems(); this.state(); this.pump();
  }
  stop(reason = "client_stop") {
    if (this.finishing || this.closed) return;
    this.finishReason = reason;
    this.finishing = true; this.acceptAudio = false; this.releaseHeld(); this.state();
    if (this.stt?.readyState === WebSocket.OPEN) this.stt.send("");
    else { this.sttFinished = true; this.flushPending(); this.maybeFinish(); }
    this.later(() => {
      if (this.sttFinished) return;
      this.sttFinished = true; this.stt?.terminate(); this.stt = null; this.flushPending();
      this.send({ type: "error", message: "Posledná výpoveď sa nemusela dokončiť." }); this.maybeFinish();
    }, 4000);
    this.later(() => this.end("Dokončenie trvalo príliš dlho.", "finish_timeout"), 120000);
  }
  maybeFinish() {
    if (!this.closed && (this.finishing || this.sttFinished) && this.sttFinished && !this.playback && !this.preparingJob && !this.queue.length) {
      this.endCode = "finished";
      this.send({ type: "session_finished", reason: this.finishReason || "error", summary: this.snapshot() }); this.close(); this.client.close(1000);
    }
  }
  end(message, code = "session_error") {
    if (this.closed) return;
    this.endCode = code;
    this.send({ type: "error", code, message, fatal: true });
    this.send({ type: "session_finished", reason: "error", summary: this.snapshot() });
    this.close(); this.client.close(4000, code);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.audioGeneration++; this.acceptAudio = false;
    // Audio already sent to Soniox is recorded even when the limit was reached meanwhile.
    if (this.audioUnreserved) { try { this.store.record?.(this.auth.username, { audioBytes: this.audioUnreserved }); } catch { /* Accounting must not block cleanup. */ } this.audioUnreserved = 0; }
    clearInterval(this.tick); clearInterval(this.heartbeat);
    for (const t of this.timerSet) clearTimeout(t);
    this.playback?.abort.abort(); clearTimeout(this.playback?.timer);
    this.synthesis.close();
    if (this.stt) { try { this.stt.terminate(); } catch {} this.stt = null; }
    this.queue = []; this.clearOutbox();
    for (const job of this.pending.values()) { job.ended = true; this.notifyJob(job); }
    this.pending.clear();
    this.onClose?.(this.snapshot());
  }
}
module.exports = { SpeechSession };


