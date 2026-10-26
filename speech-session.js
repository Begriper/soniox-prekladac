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
const { createConversationTimelineState, appendConversationToken, clearConversationNonFinalText, markConversationEndpoint, serializeConversationItems, chunkTextForTts } = require("./server-utils");

class SpeechSession {
  constructor(client, options) {
    Object.assign(this, options);
    this.client = client; this.id = randomUUID(); this.closed = false; this.configured = false;
    this.timeline = createConversationTimelineState({ maxItems: 1000 });
    this.suppressed = new Set(); this.pending = new Map(); this.queue = []; this.playback = null; this.localPlayback = null;
    this.preparingJob = null; this.audioGeneration = 0; this.prewarmed = new Set(); this.sentItems = new Map();
    this.languageA = "sk"; this.languageB = "de"; this.outputMode = "speaker"; this.ttsEnabled = true;
    this.voiceA = "Adrian"; this.voiceB = "Adrian"; this.ttsSpeed = 1; this.stt = null; this.generation = 0;
    this.profileId = "conversation"; this.conversationMode = "auto"; this.pttActive = false; this.lastFinalizeAt = 0;
    this.acceptAudio = false; this.finishing = false; this.sttFinished = false;
    this.lastActivity = Date.now(); this.startedAt = Date.now(); this.candidate = null;
    this.sessionAudio = 0; this.sessionTtsBytes = 0; this.sessionTtsRequests = 0;
    this.ttsFailures = 0; this.restUntil = 0; this.audioStates = new Map(); this.endpointTimes = new Map();
    this.timings = []; this.timerSet = new Set(); this.isAlive = true; this.frameCount = 0;
    this.outbox = []; this.outboxBytes = 0; this.outboxTimer = null; this.drainWaiters = []; this.echoUntil = 0;
    this.synthesis = new SonioxTtsWebSocket({ url: this.urls.ttsWs, apiKey: this.apiKey, clientReferenceId: this.auth.username });
    this.configTimer = this.later(() => this.end("Konfigurácia neprišla včas."), 12000);
    this.expiryTimer = this.later(() => this.end("Prihlásenie vypršalo.", "auth_expired"), Math.max(1, this.auth.expiresAt - Date.now()));
    this.limitTimer = this.later(() => this.stop(), this.limits.sessionMs);
    this.heartbeat = setInterval(() => {
      if (!this.isAlive) { this.close(); client.terminate(); return; }
      this.isAlive = false; client.ping();
    }, 10000);
    this.tick = setInterval(() => this.guard(() => {
      this.frameCount = 0;
      if (this.closed) return;
      if (!this.finishing && Date.now() - this.lastActivity > this.limits.idleMs && !this.playback) { this.stop(); return; }
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
    try { if (this.store.reserve(this.auth.username, patch)) return true; }
    catch { this.end("Účtovanie spotreby nie je dostupné.", "usage_unavailable"); return false; }
    this.end("Denný limit bol vyčerpaný.", "quota_exceeded"); return false;
  }
  muted() { return this.outputMode === "speaker" && Boolean(this.playback?.audioStarted || this.localPlayback); }
  guardEcho() { if (this.outputMode === "speaker") this.echoUntil = Date.now() + ECHO_GUARD_MS; }
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
    this.send({ type: "state", state: this.finishing ? "finishing" : this.candidate ? "confirm_language" : this.playback || this.localPlayback ? "speaking" : this.acceptAudio && this.pending.size ? "translating" : this.acceptAudio ? "listening" : "connecting", microphone_muted: this.muted(), accept_audio: this.acceptAudio });
  }
  snapshot() {
    const latency = {};
    for (const transport of ["websocket", "rest"]) {
      const values = this.timings.filter(t => t.transport === transport && Number.isFinite(t.endpoint_to_playback_ack_ms)).map(t => t.endpoint_to_playback_ack_ms).sort((a,b) => a-b);
      latency[transport] = { samples: values.length, median_ms: values.length ? values[Math.floor(values.length / 2)] : null, p95_ms: values.length ? values[Math.ceil(values.length * .95) - 1] : null };
    }
    return { latency, duration_ms: Date.now() - this.startedAt, audio_bytes: this.sessionAudio, tts_requests: this.sessionTtsRequests, tts_audio_bytes: this.sessionTtsBytes, timings: this.timings.slice(-100), rest_until: this.restUntil, provider_error: this.lastProviderError || null };
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
    if (msg.profile_id !== undefined && !contextFor(msg.profile_id)) return false;
    return [msg.voice_a, msg.voice_b, msg.tts_voice].filter(Boolean).every(v => this.catalog.hasVoiceFor(this.auth.username, v));
  }
  message(raw) {
    const msg = parseMessage(raw);
    if (!msg) { this.end("Neplatná správa.", "invalid_message"); return; }
    if (msg.type === "config") {
      if (this.configured || !this.validSettings(msg)) { this.end("Neplatná konfigurácia."); return; }
      this.configured = true; clearTimeout(this.configTimer);
      this.languageA = msg.language_a || "sk"; this.languageB = msg.language_b || "de";
      if (this.languageA === this.languageB) { this.end("Vyber dva rôzne jazyky."); return; }
      this.voiceA = msg.voice_a || msg.tts_voice || "Adrian"; this.voiceB = msg.voice_b || msg.tts_voice || "Adrian";
      this.ttsSpeed = msg.tts_speed !== undefined ? Number(msg.tts_speed) : 1;
      this.ttsEnabled = msg.tts_enabled !== false; this.outputMode = msg.output_mode || "speaker";
      this.profileId = msg.profile_id || "conversation"; this.conversationMode = msg.conversation_mode || "auto";
      this.startStt(); return;
    }
    if (!this.configured) { this.end("Najprv odošli konfiguráciu."); return; }
    if (msg.type === "playback_started") { if (this.playback?.id === msg.playback_id && !this.playback.audibleAt) this.playback.audibleAt = Date.now(); return; }
    if (msg.type === "playback_done") { this.playbackDone(msg); return; }
    if (msg.type === "stop_audio") { this.cancelAudio(msg.request_id); this.maybeFinish(); return; }
    if (msg.type === "client_stop") { this.stop(); return; }
    if (msg.type === "ptt_start" && this.conversationMode === "ptt" && !this.finishing) {
      this.pttActive = true; this.state(); return;
    }
    if (msg.type === "ptt_end" && this.conversationMode === "ptt" && this.pttActive && !this.finishing) {
      this.pttActive = false; this.state();
      if (this.stt?.readyState === WebSocket.OPEN && Date.now() - this.lastFinalizeAt > 500) {
        // The client has already sent roughly 200 ms of silence before releasing.
        this.lastFinalizeAt = Date.now(); this.stt.send(JSON.stringify({ type: "finalize" }));
      }
      return;
    }
    if (msg.type === "local_playback_end") {
      if (this.localPlayback === msg.playback_id) { this.localPlayback = null; clearTimeout(this.localTimer); this.guardEcho(); this.state(); this.pump(); } return;
    }
    if (this.finishing) return;
    if (msg.type === "local_playback_start") {
      if (this.playback || this.localPlayback || !msg.playback_id) { this.send({ type: "error", code: "busy", message: "Počkaj na koniec hlasu." }); return; }
      this.localPlayback = msg.playback_id; this.state();
      this.send({ type: "local_playback_ready", playback_id: msg.playback_id });
      this.localTimer = this.later(() => { this.localPlayback = null; this.state(); this.pump(); }, 120000); return;
    }
    if (msg.type === "confirm_language") {
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
      if (!item?.is_final || !item.translated_text.trim()) return;
      this.suppressed.delete(item.id); this.audioStates.delete(item.id);
      this.enqueue(item.translated_text, item.target_language, item.id); return;
    }
  }
  audio(data) {
    if (!this.acceptAudio || this.muted() || Date.now() < this.echoUntil || this.finishing || this.closed || (this.conversationMode === "ptt" && !this.pttActive)) return;
    if (!data.length || data.length % 2 || data.length > 16384) { this.end("Neplatný audio rámec."); return; }
    if (this.stt?.readyState !== WebSocket.OPEN) return;
    if (this.stt.bufferedAmount > 256 * 1024) { this.end("Spojenie nestíha prenášať zvuk. Obnov rozhovor.", "audio_overload"); return; }
    this.sessionAudio += data.length;
    if (this.sessionAudio > this.limits.sessionAudioBytes || !this.reserve({ audioBytes: data.length })) { if (!this.closed) this.stop(); return; }
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
      const auto = this.languageB === "auto";
      socket.send(JSON.stringify({
        model: STT_MODEL, audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, client_reference_id: this.auth.username,
        ...(!auto ? { language_hints: [this.languageA, this.languageB] } : {}),
        enable_language_identification: true, enable_endpoint_detection: true,
        max_endpoint_delay_ms: this.endpoint.delay, endpoint_sensitivity: this.endpoint.sensitivity,
        endpoint_latency_adjustment_level: this.endpoint.level,
        translation: auto ? { type: "one_way", target_language: this.languageA } : { type: "two_way", language_a: this.languageA, language_b: this.languageB },
        context: contextFor(this.profileId),
      }));
      this.acceptAudio = true; this.send({ type: "server_ready" }); this.state();
      // Open the TTS connection early; streams are prewarmed per utterance because idle streams expire.
      if (this.ttsEnabled && !auto && this.transport !== "rest") void this.synthesis.connect().catch(() => {});
    }));
    socket.on("message", raw => this.guard(() => {
      if (!current()) return;
      let result; try { result = JSON.parse(raw.toString()); } catch { this.end("Neplatná odpoveď rozpoznávania."); return; }
      if (!result || typeof result !== "object") return;
      if (result.error_code) { this.providerError(result); return; }
      this.tokens(result.tokens || []);
      if (result.finished) { this.sttFinished = true; this.acceptAudio = false; this.flushPending(); socket.close(); this.maybeFinish(); }
    }));
    socket.on("error", () => { if (current()) this.end("Spojenie s rozpoznávaním zlyhalo.", "stt_connection"); });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!current()) return;
      this.stt = null; this.acceptAudio = false;
      if (this.finishing || this.sttFinished) { this.sttFinished = true; this.flushPending(); this.maybeFinish(); }
      else this.end("Spojenie sa prerušilo. Posledná výpoveď nemusí byť úplná.", "stt_connection");
    });
  }
  tokens(tokens) {
    if (!Array.isArray(tokens)) return;
    clearConversationNonFinalText(this.timeline);
    for (const token of tokens) {
      if (this.timeline.items.length >= 990) { this.send({ type: "error", code: "transcript_overload", message: "Rozhovor je plný. Ulož ho a začni nový; posledná časť sa nemusela zachovať." }); this.stop(); break; }
      if (!token || typeof token.text !== "string") continue;
      if (token.text === "<end>" || token.text === "<fin>") {
        const item = markConversationEndpoint(this.timeline);
        if (item) this.endpointTimes.set(item.id, Date.now());
        this.flushPending();
        if (this.languageB === "auto" && item?.source_language && item.source_language !== this.languageA && this.catalog.hasLanguage(item.source_language)) {
          this.candidate = item.source_language; this.acceptAudio = false;
          this.send({ type: "language_candidate", language: this.candidate }); this.state();
        }
        continue;
      }
      const result = appendConversationToken(this.timeline, token, { languageA: this.languageA, languageB: this.languageB });
      if (result.ignored) continue;
      if (token.translation_status === "translation" && !token.is_final) this.prewarmFor(result.item, token.language);
      if (token.is_final) this.lastActivity = Date.now();
      if (result.tts_text) {
        if (this.suppressed.has(result.item.id)) continue;
        if (this.languageB === "auto" || !this.ttsEnabled) { this.audioStates.set(result.item.id, "text_only"); continue; }
        const id = result.item.id;
        // A Soniox TTS stream belongs to one utterance and one translation direction.
        for (const [otherId] of this.pending) if (otherId !== id) this.flushOne(otherId);
        this.appendTtsPart(id, result.tts_language, result.tts_text);
      }
    }
    if (this.timeline.items.reduce((n, i) => n + i.source_text.length + i.translated_text.length, 0) > 40000 || this.timeline.items.length >= 990) {
      this.send({ type: "error", message: "Rozhovor je dlhý. Ulož ho a začni nový." }); this.stop();
    }
    this.updateItems(); this.state();
  }
  // Transient Soniox failures are retried by the client; account problems get a clear, final message.
  providerError(result) {
    const status = Number(result.error_code);
    this.lastProviderError = { status: Number.isFinite(status) ? status : null, type: String(result.error_type || "").slice(0, 80), request_id: String(result.request_id || "").slice(0, 120), at: new Date().toISOString() };
    if ([408, 429, 500, 502, 503].includes(status)) { this.end("Rozpoznávanie je dočasne nedostupné. Obnovujem…", "stt_retry"); return; }
    if (status === 402) { this.end("Kredit Soniox je vyčerpaný.", "provider_credit"); return; }
    this.end("Rozpoznávanie nie je dostupné.", "stt_provider_error");
  }
  prewarmFor(item, language) {
    // Only streamed headphone playback starts before <end>; speaker playback gains nothing from a prewarm.
    if (!item || this.outputMode !== "headphones" || !this.ttsEnabled || this.languageB === "auto" || this.transport === "rest" || Date.now() < this.restUntil) return;
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
      job = { text: "", parts: [], waiters: new Set(), ended: false, queued: false, language, itemId, voice: language === this.languageA ? this.voiceA : this.voiceB, speed: this.ttsSpeed };
      this.pending.set(itemId, job);
    }
    if (job.text.length + text.length > 5000) {
      this.suppressed.add(itemId); this.audioStates.set(itemId, "not_spoken");
      job.ended = true; this.notifyJob(job); this.pending.delete(itemId);
      this.send({ type: "error", code: "voice_overload", message: "Výpoveď je pre hlas príliš dlhá. Preklad zostáva v texte." }); return;
    }
    job.text += text; job.parts.push(text); this.notifyJob(job);
    if (this.outputMode === "headphones") this.queueJob(job);
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
      const job = { text: chunk, parts: [chunk], waiters: new Set(), ended: true, queued: false, language, itemId, voice: language === this.languageA ? this.voiceA : this.voiceB, speed: this.ttsSpeed };
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
    await this.catalog.ensureVoices();
    this.preparingJob = null;
    // Audio cancelled while the catalog refreshed: newer jobs may have queued behind this one.
    if (this.closed || audioGeneration !== this.audioGeneration || !this.ttsEnabled) { this.maybeFinish(); this.pump(); return; }
    if (!this.catalog.hasVoiceFor(this.auth.username, job.voice)) {
      this.audioStates.set(job.itemId, "not_spoken"); this.suppressed.add(job.itemId);
      job.ended = true; this.notifyJob(job); this.pending.delete(job.itemId);
      this.send({ type: "error", code: "voice_unavailable", message: "Vybraný hlas už nie je dostupný pre tento účet." });
      this.updateItems(); this.pump(); return;
    }
    if (this.sessionTtsRequests >= this.limits.sessionTtsRequests) { this.audioStates.set(job.itemId, "not_spoken"); this.send({ type: "error", message: "Limit hlasu konverzácie bol vyčerpaný." }); this.cancelAudio(); this.maybeFinish(); return; }
    const op = { id: randomUUID(), job, abort: new AbortController(), started: Date.now(), audioStarted: false, bytes: 0, synthesisDone: false };
    this.playback = op; this.state();
    const current = () => !this.closed && this.playback === op && !op.abort.signal.aborted;
    const reserveAttempt = chars => {
      if (this.sessionTtsRequests >= this.limits.sessionTtsRequests) return false;
      if (!this.reserve({ ttsRequests: 1, ttsChars: chars })) return false;
      this.sessionTtsRequests++; return true;
    };
    const begin = transport => {
      op.transport = transport;
      this.send({ type: "tts_stream_start", playback_id: op.id, utterance_id: job.itemId, format: "pcm_s16le", sample_rate: 24000, model: TTS_MODEL, voice: job.voice, language: job.language, transport, text: job.text });
    };
    const audio = buffer => {
      if (!current()) return;
      if (this.client.readyState !== WebSocket.OPEN) throw Object.assign(new Error("client closed"), { errorCode: "client_unavailable" });
      if (this.sessionTtsBytes + buffer.length > this.limits.sessionTtsBytes || !this.reserve({ ttsAudioBytes: buffer.length })) throw Object.assign(new Error("audio quota"), { errorCode: "quota_exceeded" });
      this.sessionTtsBytes += buffer.length; op.bytes += buffer.length;
      this.sendAudio(op, buffer);
      if (!op.audioStarted) {
        op.audioStarted = true;
        op.firstAudioMs = Date.now() - op.started;
        // The speaker microphone is muted from the first audible sample, not while waiting for it.
        this.state();
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
          if (this.transport !== "auto" || op.audioStarted || err.audioStarted || !isTransportFailure(err)) throw err;
          useRest = true;
          this.send({ type: "tts_fallback", playback_id: op.id });
        }
      }
      if (useRest) {
        await this.waitForJob(job, op.abort.signal);
        if (!current()) return;
        if (!reserveAttempt([...job.text].length)) throw new Error("quota");
        begin("rest");
        await synthesizeRest({ url: this.urls.ttsRest, apiKey: this.apiKey, ...job, signal: op.abort.signal, onChunk: chunk => {
          for (let i = 0; i < chunk.length; i += 16384) audio(chunk.subarray(i, i + 16384));
        } });
      }
      // The end marker must follow the last audio chunk still waiting for a slow phone.
      await this.drainAudio();
      if (!current()) return;
      op.synthesisDone = true;
      this.send({ type: "tts_stream_end", playback_id: op.id, text: job.text });
      op.timer = this.later(() => this.playbackDone({ playback_id: op.id, status: "interrupted" }), Math.ceil(op.bytes / 48000 * 1000) + 15000);
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
      else op.timer = this.later(() => this.playbackDone({ playback_id: op.id, status: "interrupted" }), Math.ceil(op.bytes / 48000 * 1000) + 15000);
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
  stop() {
    if (this.finishing || this.closed) return;
    this.finishing = true; this.acceptAudio = false; this.state();
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
      this.send({ type: "session_finished", summary: this.snapshot() }); this.close(); this.client.close(1000);
    }
  }
  end(message, code = "session_error") {
    if (this.closed) return;
    this.send({ type: "error", code, message, fatal: true });
    this.close(); this.client.close(4000, code);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.audioGeneration++; this.acceptAudio = false;
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


