"use strict";
const { STT_MODEL, TTS_MODEL } = require("./runtime-models");
// Public documented baseline; live metadata for the exact model takes precedence.
const CODES = "af sq ar az eu be bn bs bg ca zh hr cs da nl en et fi fr gl de el gu he hi hu id it ja kn kk ko lv lt mk ms ml mr no fa pl pt pa ro ru sr sk sl es sw sv tl ta te th tr uk ur vi cy".split(" ");
const names = new Intl.DisplayNames(["sk"], { type: "language" });
const language = code => ({ code, name: names.of(code) || code, native_name: new Intl.DisplayNames([code], { type: "language" }).of(code) || code });
function normalizeModel(data, id) {
  const model = data?.models?.find(m => m.id === id);
  if (!model || !Array.isArray(model.languages) || !model.languages.length) throw new Error("catalog unavailable");
  const languages = [...new Set(model.languages.map(l => typeof l === "string" ? l : l.code).filter(c => /^[a-z]{2,3}$/.test(c)))].map(language);
  if (!languages.length) throw new Error("catalog unavailable");
  const voices = (model.voices || []).filter(v => typeof v.id === "string" && /^[\w. -]{1,80}$/.test(v.id)).map(v => ({ id: v.id, name: v.name || v.id, gender: String(v.gender || "neutral").toLowerCase(), description: String(v.description || "").slice(0, 500) }));
  if (id === TTS_MODEL && !voices.length) throw new Error("voice catalog unavailable");
  return { model: id, languages, voices, updated_at: new Date().toISOString(), source: "provider" };
}
class Catalog {
  constructor({ store, urls, apiKey, fetchImpl = fetch, ownerUsername = "", ownerVoiceName = "my voice" }) {
    Object.assign(this, { store, urls, apiKey, fetchImpl }); this.pending = new Map(); this.retryAt = new Map();
    this.ownerUsername = ownerUsername; this.ownerVoiceName = ownerVoiceName.trim().toLowerCase();
    this.shared = null; this.custom = null; this.voiceUpdatedAt = 0; this.voiceRetryAt = 0; this.voicePending = null;
    this.data = new Map();
    for (const kind of ["stt", "tts"]) {
      const model = kind === "stt" ? STT_MODEL : TTS_MODEL;
      const saved = store.getCatalog(kind);
      this.data.set(kind, saved?.model === model ? saved : { model, languages: CODES.map(language), voices: [{ id: "Adrian", name: "Adrian", gender: "male" }, { id: "Maya", name: "Maya", gender: "female" }], updated_at: null, source: "baseline" });
    }
  }
  current(kind) { const data = this.data.get(kind); return { ...data, stale: !data.updated_at || Date.now() - Date.parse(data.updated_at) > 600000, fallback: data.source !== "provider" }; }
  async get(kind) {
    if (!this.current(kind).stale || Date.now() < (this.retryAt.get(kind) || 0)) return this.current(kind);
    if (this.pending.has(kind)) return this.pending.get(kind);
    const task = (async () => {
      try {
        const res = await this.fetchImpl(this.urls[kind], { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error("catalog unavailable");
        const data = normalizeModel(await res.json(), kind === "stt" ? STT_MODEL : TTS_MODEL);
        this.store.saveCatalog(kind, data); this.data.set(kind, data);
      } catch { this.retryAt.set(kind, Date.now() + 60000); }
      finally { this.pending.delete(kind); }
      return this.current(kind);
    })();
    this.pending.set(kind, task); return task;
  }
  hasLanguage(code) { return this.current("stt").languages.some(l => l.code === code); }
  async pages(kind, limit) {
    const base = this.urls[kind]; if (!base) throw new Error("voice endpoint unavailable");
    const voices = [], cursors = new Set(); let cursor = null;
    for (let page = 0; page < 30; page++) {
      const url = new URL(base); url.searchParams.set("limit", String(limit));
      if (kind === "shared") url.searchParams.set("model", TTS_MODEL);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("voice endpoint unavailable");
      const data = await response.json(); if (!Array.isArray(data.voices)) throw new Error("invalid voice catalog");
      voices.push(...data.voices); cursor = data.next_page_cursor || null;
      if (!cursor) return voices;
      if (cursors.has(cursor)) throw new Error("voice cursor repeated");
      cursors.add(cursor);
    }
    throw new Error("voice catalog exceeded page limit");
  }
  async refreshVoices() {
    if (Date.now() < this.voiceUpdatedAt + 600000 || Date.now() < this.voiceRetryAt) return;
    if (this.voicePending) return this.voicePending;
    this.voicePending = (async () => {
      try {
        const [sharedResult, customResult] = await Promise.allSettled([this.pages("shared", 200), this.ownerUsername ? this.pages("custom", 1000) : Promise.resolve([])]);
        let sharedReady = false;
        if (sharedResult.status === "fulfilled") {
          const validShared = sharedResult.value.filter(v => typeof v.id === "string" && /^[\w. -]{1,80}$/.test(v.id)).map(v => ({ id: v.id, name: v.id, gender: String(v.gender || "neutral"), age: String(v.age || ""), accent: String(v.accent || ""), use_case: Array.isArray(v.use_case) ? v.use_case : [], style: Array.isArray(v.style) ? v.style : [], description: String(v.description || "").slice(0, 500), kind: "shared" }));
          if (validShared.length) { this.shared = validShared; sharedReady = true; }
        }
        this.custom = customResult.status === "fulfilled" ? customResult.value : null;
        if (sharedReady && customResult.status === "fulfilled") {
          this.voiceUpdatedAt = Date.now(); this.voiceRetryAt = 0;
        } else this.voiceRetryAt = Date.now() + 60000;
      } catch { this.custom = null; this.voiceRetryAt = Date.now() + 60000; }
      finally { this.voicePending = null; }
    })();
    return this.voicePending;
  }
  ownerVoice() {
    if (!this.ownerUsername) return { status: "not_configured", message: "Vlastník hlasu nie je nastavený na serveri." };
    if (!this.custom || Date.now() >= this.voiceUpdatedAt + 600000) return { status: "unavailable", message: "Zoznam vlastných hlasov Soniox nie je momentálne dostupný." };
    const voice = this.custom.find(v => String(v.name || "").trim().toLowerCase() === this.ownerVoiceName);
    if (!voice) return { status: "missing", message: "Hlas my voice sa v Soniox projekte tohto API kľúča nenašiel." };
    const model = voice.models?.find(m => m.model === TTS_MODEL);
    if (!model) return { status: "wrong_model", message: "Hlas my voice nie je pripravený pre tts-rt-v2." };
    if (model.status !== "ready") return { status: model.status || "not_ready", message: "Hlas my voice ešte nie je pripravený pre tts-rt-v2 (" + (model.status || "neznámy stav") + ")." };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voice.id)) return { status: "invalid_id", message: "Hlas my voice nemá platné UUID." };
    return { status: "ready", voice: { id: voice.id, name: voice.name, gender: "neutral", kind: "custom", description: "Tvoj klonovaný hlas" } };
  }
  async voicesFor(username) {
    await Promise.all([this.get("tts"), this.refreshVoices()]);
    const model = this.current("tts");
    const shared = this.shared || model.voices.map(v => ({ ...v, kind: "shared" }));
    const own = username === this.ownerUsername ? this.ownerVoice() : null;
    return { ...model, voices: own?.status === "ready" ? [...shared, own.voice] : shared, count: shared.length + (own?.status === "ready" ? 1 : 0), custom_voice: own ? { status: own.status, message: own.message || "Hlas my voice je pripravený." } : null, stale: !this.shared || Date.now() >= this.voiceUpdatedAt + 600000 };
  }
  hasVoiceFor(username, id) {
    const shared = this.shared || this.current("tts").voices;
    const own = username === this.ownerUsername ? this.ownerVoice() : null;
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(id))) return own?.status === "ready" && own.voice.id === id;
    return shared.some(v => v.id === id);
  }
  hasVoice(id) { return this.hasVoiceFor("", id); }
  canSpeak(code, text = "") {
    if (!this.current("tts").languages.some(l => l.code === code)) return false;
    if (["sr", "bs"].includes(code) && /\p{Script=Cyrillic}/u.test(text)) return false;
    if (code === "kk" && /\p{Script=Latin}/u.test(text)) return false;
    // Traditional Chinese cannot be reliably inferred character by character.
    return true;
  }
}
module.exports = { Catalog, CODES, normalizeModel };
