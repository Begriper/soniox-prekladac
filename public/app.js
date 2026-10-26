"use strict";
const $ = id => document.getElementById(id);
let user = null, languages = [], voices = [], socket = null, conversationId = "", epoch = 0;
let running = false, stopping = false, ready = false, muted = false, dirty = false;
let media = null, captureContext = null, worklet = null, processor = null, wakeLock = null, flushResolve = null;
let playbackContext = null, playback = null, localPlayback = null, previewAbort = null;
let entries = [], nodes = new Map(), audioCache = new Map(), audioCacheBytes = 0, ttsModel = "tts-rt-v2";
let chosenA = "sk", chosenB = "de", currentVoiceA = "Adrian", currentVoiceB = "Adrian";
let toastTimer, connectTimer, finishTimer, cancelRequest = "";
let pttPressed = false, pttSide = "", pttEnding = false, vadHits = 0;
const MAX_CACHE = 12 * 1024 * 1024;
const settings = {
  get(key, fallback) { try { return localStorage.getItem("translator." + key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem("translator." + key, value); } catch {} },
};

function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").hidden = true, 3500); }

function error(message) { $("errorBanner").textContent = message; $("errorBanner").hidden = !message; }

function status(text, active = false) { $("status").textContent = text; $("statusDot").classList.toggle("active", active); }

function name(code) { return languages.find(l => l.code === code)?.name || (code === "auto" ? "Rozpoznať jazyk" : code); }

function textOnly() { return $("textOnly").checked; }

function saveSettings() {
  settings.set("langA", chosenA); settings.set("langB", chosenB);
  settings.set("voiceA", currentVoiceA); settings.set("voiceB", currentVoiceB);
  settings.set("ttsEnabled", String(!textOnly())); settings.set("outputMode", $("outputMode").value);
  settings.set("profileId", $("profileId").value); settings.set("conversationMode", $("conversationMode").value);
  const recent = [chosenA, chosenB, ...settings.get("recent", "").split(",")].filter(c => c && c !== "auto");
  settings.set("recent", [...new Set(recent)].slice(0, 6).join(","));
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(8000), ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  if (!response.ok) {
    let message = "Operácia zlyhala."; try { message = (await response.json()).error || message; } catch {}
    if (response.status === 401 && user) await signOut(false);
    throw new Error(message);
  }
  return response.json();
}

function send(data) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }

function controls() {
  const ptt = $("conversationMode").value === "ptt";
  $("appShell").classList.toggle("is-running", running);
  $("appShell").classList.toggle("is-ptt", ptt);
  const activePair = $("activeLanguagePair");
  if (activePair) activePair.textContent = name(chosenA) + "  ↔  " + name(chosenB);
  $("startBtn").textContent = stopping ? "Dokončujem…" : running ? "Zastaviť počúvanie" : entries.length ? "Obnoviť počúvanie" : ptt ? "Spustiť PTT" : "Počúvať";
  $("startBtn").disabled = stopping || !navigator.onLine;
  for (const id of ["langA", "langB", "searchA", "searchB", "swapBtn", "profileId", "conversationMode"]) $(id).disabled = running || stopping;
  $("pttButtons").hidden = !ptt || !running;
  for (const id of ["pttA", "pttB"]) $(id).disabled = !running || !ready || stopping || pttEnding;
  $("pttA").textContent = "Podrž · " + name(chosenA); $("pttB").textContent = "Podrž · " + name(chosenB);
  $("stopAudioBtn").disabled = !running && !playback && !localPlayback && !previewAbort;
  $("micHint").textContent = !running ? "Mikrofón je vypnutý." : muted ? "Mikrofón počas hlasu neposiela zvuk." : !ready ? "Počkaj, kým sa zobrazí Počúvam." : ptt ? pttPressed ? "Hovor. Po pustení tlačidla sa výpoveď dokončí." : "Podrž tlačidlo svojho jazyka a hovor." : "Mikrofón počúva. Hovorí vždy jedna osoba.";
  $("modeLabel").textContent = textOnly() ? "Iba text" : $("outputMode").value === "speaker" ? "Reproduktor" : "Slúchadlá";
}

function addOption(parent, code, label) { const o = document.createElement("option"); o.value = code; o.textContent = label; parent.append(o); }

function fillLanguages(select, selected, search = "", auto = false) {
  const term = search.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const matches = l => (l.name + " " + l.native_name + " " + l.code).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().includes(term);
  select.replaceChildren();
  if (auto) addOption(select, "auto", "Rozpoznať jazyk");
  const recent = settings.get("recent", "").split(",");
  if (!term && recent.length) {
    const group = document.createElement("optgroup"); group.label = "Naposledy použité";
    for (const code of recent) { const l = languages.find(v => v.code === code); if (l) addOption(group, code, l.name); }
    if (group.childElementCount) select.append(group);
  }
  const group = document.createElement("optgroup"); group.label = "Všetky jazyky";
  for (const l of languages) if (matches(l) || l.code === selected) addOption(group, l.code, l.name + (l.native_name && l.native_name !== l.name ? " · " + l.native_name : "") + (l.tts === false ? " · iba text" : ""));
  select.append(group); select.value = selected;
}

function fillVoiceFilters() {
  for (const side of ["A", "B"]) for (const [field, key] of [["accent", "accent"], ["age", "age"], ["style", "style"]]) {
    const select = $(field + side), selected = select.value;
    select.replaceChildren(); addOption(select, "", "Všetky");
    const values = [...new Set(voices.flatMap(v => Array.isArray(v[key]) ? v[key] : v[key] ? [v[key]] : []))].sort();
    for (const value of values) addOption(select, value, value.replaceAll("_", " "));
    if (values.includes(selected)) select.value = selected;
  }
}
function fillVoices(side) {
  const selected = side === "A" ? currentVoiceA : currentVoiceB, select = $("voice" + side);
  const gender = $("gender" + side).value, accent = $("accent" + side).value, age = $("age" + side).value, style = $("style" + side).value;
  const query = $("voiceSearch" + side).value.toLocaleLowerCase("sk").trim();
  const matches = voices.filter(v => (!gender || v.gender === gender) && (!accent || v.accent === accent) && (!age || v.age === age) && (!style || v.style?.includes(style)) && (!query || [v.name,v.description,v.accent,...(v.style || []),...(v.use_case || [])].join(" ").toLocaleLowerCase("sk").includes(query)));
  select.replaceChildren();
  const active = voices.find(v => v.id === selected);
  if (active && !matches.includes(active)) addOption(select, active.id, active.name + " · aktuálny výber");
  for (const v of matches) addOption(select, v.id, v.name + (v.kind === "custom" ? " · môj hlas" : v.gender === "female" ? " · ženský" : v.gender === "male" ? " · mužský" : ""));
  $("voiceMatch" + side).textContent = matches.length + " " + (matches.length === 1 ? "hlas zodpovedá" : matches.length < 5 ? "hlasy zodpovedajú" : "hlasov zodpovedá") + " filtrom.";
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
  if (side === "A") currentVoiceA = select.value; else currentVoiceB = select.value;
}
function voiceInfo(data) {
  $("voiceCount").textContent = data.count + " " + (data.count === 1 ? "dostupný hlas" : data.count < 5 ? "dostupné hlasy" : "dostupných hlasov") + " pre " + data.model + ".";
  $("customVoiceStatus").textContent = data.custom_voice?.message || "";
  $("customVoiceStatus").hidden = !data.custom_voice;
  $("accessPanel").hidden = !data.custom_voice;
}
async function loadAccessUsers() {
  const owner = user, data = await api("/api/admin/users");
  if (owner !== user) return;
  const list = $("accessUsers"); list.replaceChildren();
  for (const row of data.users) {
    const div = document.createElement("div"); div.className = "access-row";
    const label = document.createElement("span"); label.textContent = row.username + (row.owner ? " · vlastník" : row.revoked ? " · zrušený" : " · aktívny");
    div.append(label);
    if (!row.owner && !row.revoked) {
      const button = document.createElement("button"); button.className = "danger"; button.textContent = "Zrušiť prístup";
      button.addEventListener("click", async () => {
        if (!confirm("Zrušiť prístup používateľa " + row.username + " vrátane aktívnych relácií?")) return;
        try { await api("/api/admin/users/" + encodeURIComponent(row.username) + "/revoke", { method: "POST", body: "{}" }); await loadAccessUsers(); toast("Prístup bol zrušený."); }
        catch (err) { error(err.message); }
      });
      div.append(button);
    }
    list.append(div);
  }
}

async function showApp(session) {
  user = session.username; $("loginShell").hidden = true; $("appShell").hidden = false; $("accessCode").value = "";
  const owner = user;
  const [languageData, voiceData] = await Promise.all([api("/api/languages"), api("/api/voices")]);
  if (user !== owner) return;
  languages = languageData.languages.sort((a,b) => a.name.localeCompare(b.name, "sk")); voices = voiceData.voices; ttsModel = voiceData.model;
  chosenA = settings.get("langA", "sk"); chosenB = settings.get("langB", "de");
  if (!languages.some(l => l.code === chosenA)) chosenA = "sk";
  if (chosenB !== "auto" && !languages.some(l => l.code === chosenB)) chosenB = "de";
  currentVoiceA = settings.get("voiceA", settings.get("voice", "Adrian")); currentVoiceB = settings.get("voiceB", settings.get("voice", "Adrian"));
  $("textOnly").checked = settings.get("ttsEnabled", "true") === "false";
  $("outputMode").value = "speaker";
  $("profileId").value = settings.get("profileId", "conversation");
  $("conversationMode").value = settings.get("conversationMode", "auto");
  fillLanguages($("langA"), chosenA); fillLanguages($("langB"), chosenB, "", true);
  fillVoiceFilters(); fillVoices("A"); fillVoices("B"); voiceInfo(voiceData);
  if (voiceData.custom_voice) void loadAccessUsers().catch(e => error(e.message));
  $("catalogNote").textContent = languageData.stale || voiceData.stale ? "Katalóg sa teraz nedá obnoviť. Používa sa posledný dostupný zoznam." : languages.length + " jazykov · hlas aj text";
  showUsage(session.usage); controls();
}

function showUsage(usage) {
  if (!usage) return;
  $("usageInfo").textContent = "Prihlásený: " + user + " · Dnes rezervované: " + Math.ceil((usage.sttSeconds || 0) / 60) + " min rozpoznávania, " + (usage.ttsRequests || 0) + " hlasových požiadaviek. Denné limity sa obnovujú o polnoci UTC.";
}

async function signOut(callServer = true) {
  epoch++; stopLocal(); disconnect(); clearEntries();
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  if (callServer) { try { await api("/api/logout", { method: "POST", body: "{}" }); } catch { $("loginStatus").textContent = "Odhlásenie na serveri sa nepotvrdilo. Po obnovení internetu sa prihlás a odhlás znova."; } }
  $("historyList").replaceChildren(); $("usageInfo").textContent = ""; $("accessUsers").replaceChildren();
  user = null; $("loginShell").hidden = false; $("appShell").hidden = true; $("accessCode").value = "";
}

function ensurePlaybackContext() {
  if (!playbackContext || playbackContext.state === "closed") playbackContext = new AudioContext();
  return playbackContext;
}

async function unlockAudio() { await ensurePlaybackContext().resume(); }

function cacheKey(item, voice) { return [item.id, item.target_language, item.translated_text.trim(), voice, ttsModel].join("|"); }

function concat(chunks) { const out = new Uint8Array(chunks.reduce((n,b) => n + b.byteLength, 0)); let i = 0; for (const b of chunks) { out.set(new Uint8Array(b), i); i += b.byteLength; } return out.buffer; }

function rememberAudio(meta, chunks) {
  const item = entries.find(i => i.id === conversationId + "/" + meta.utterance_id);
  if (!item || !item.is_final || item.translated_text.trim() !== meta.text?.trim()) return;
  const buffer = concat(chunks), key = cacheKey(item, meta.voice);
  if (buffer.byteLength > MAX_CACHE) return;
  if (audioCache.has(key)) audioCacheBytes -= audioCache.get(key).byteLength;
  audioCache.set(key, buffer); audioCacheBytes += buffer.byteLength;
  while (audioCacheBytes > MAX_CACHE) { const key = audioCache.keys().next().value; audioCacheBytes -= audioCache.get(key).byteLength; audioCache.delete(key); }
}

function stopSources(op) {
  if (!op) return; op.cancelled = true;
  for (const source of op.sources) { source.onended = null; try { source.stop(); } catch {} }
  op.sources.clear(); clearTimeout(op.timer); op.resolve?.();
}

function stopLocal() {
  previewAbort?.abort(); previewAbort = null;
  const op = localPlayback; localPlayback = null; stopSources(op);
  if (op?.id) send({ type: "local_playback_end", playback_id: op.id });
}

function stopSound() {
  stopLocal(); stopSources(playback); playback = null;
  cancelRequest = socket?.readyState === WebSocket.OPEN ? crypto.randomUUID() : "";
  send({ type: "stop_audio", request_id: cancelRequest }); controls();
}

function startStream(meta) {
  if (cancelRequest) return;
  if (playback && playback.meta.playback_id !== meta.playback_id) stopSources(playback);
  if (playback?.meta.playback_id === meta.playback_id && playback.chunks.length) return;
  playback = { meta, chunks: [], sources: new Set(), nextTime: 0, ended: false, bytes: 0, createdAt: Date.now() };
  controls();
}

function schedule(buffer, op, complete) {
  if (!op || op.cancelled || !buffer.byteLength) return;
  op.bytes = (op.bytes || 0) + buffer.byteLength;
  if (op.bytes > 8 * 1024 * 1024 || buffer.byteLength % 2) { error("Hlas bol prerušený pre neplatné alebo príliš veľké audio."); stopSound(); return; }
  const context = ensurePlaybackContext();
  if (context.state !== "running") { error("Zvuk je pozastavený. Klikni na Zastaviť hlas a potom preklad zopakuj."); stopSound(); return; }
  const pcm = new Int16Array(buffer), audio = context.createBuffer(1, pcm.length, 24000);
  const channel = audio.getChannelData(0); for (let i=0; i<pcm.length; i++) channel[i] = pcm[i] / 32768;
  const source = context.createBufferSource(); source.buffer = audio; source.connect(context.destination);
  const at = Math.max(context.currentTime + .025, op.nextTime || 0); op.nextTime = at + audio.duration;
  op.sources.add(source);
  source.onended = () => { op.sources.delete(source); complete(); };
  source.start(at);
  if (op.meta && !op.started) { op.started = true; op.timer = setTimeout(() => { if (!op.cancelled) send({ type: "playback_started", playback_id: op.meta.playback_id }); }, Math.max(0, (at - context.currentTime) * 1000)); }
}

function completeStream() {
  const op = playback;
  if (!op || !op.ended || op.sources.size) return;
  playback = null;
  if (!op.interrupted && op.chunks.length) rememberAudio(op.meta, op.chunks);
  send({ type: "playback_done", playback_id: op.meta.playback_id, status: op.interrupted ? "interrupted" : "played" });
  controls();
}

function streamAudio(buffer) {
  if (!playback) return;
  const op = playback; op.chunks.push(buffer.slice(0));
  schedule(buffer, op, completeStream);
}

function localAudio(buffer, id = crypto.randomUUID(), resolve) {
  const op = { id, sources: new Set(), nextTime: 0, bytes: 0, resolve }; localPlayback = op; muted = $("outputMode").value === "speaker" && running; controls();
  schedule(buffer, op, () => {
    if (op.sources.size || localPlayback !== op) return;
    localPlayback = null; send({ type: "local_playback_end", playback_id: id }); muted = false; controls(); resolve?.();
  });
}

async function replay(item) {
  if (playback || localPlayback || previewAbort) { toast("Najprv zastav aktuálny hlas."); return; }
  await unlockAudio();
  const voice = item.target_language === chosenA ? currentVoiceA : currentVoiceB;
  const cached = audioCache.get(cacheKey(item, voice));
  if (cached) {
    if (running) {
      const id = crypto.randomUUID();
      localPlayback = { id, buffer: cached, waiting: true, sources: new Set() };
      send({ type: "local_playback_start", playback_id: id });
      localPlayback.timer = setTimeout(() => { if (localPlayback?.id === id && localPlayback.waiting) { stopLocal(); error("Prehratie sa nepodarilo spustiť."); } }, 5000);
    } else localAudio(cached);
    return;
  }
  if (running && item.conversation === conversationId) send({ type: "replay_translation", item_id: item.server_id });
  else {
    if (running) { toast("Pre uložený rozhovor najprv zastav počúvanie."); return; }
    await fetchVoice("/api/replay", { text: item.translated_text, language: item.target_language, voice });
  }
}

function replayChunks(text) {
  let remaining = String(text || "").trim(); const chunks = [];
  while (remaining.length > 900) {
    let end = remaining.lastIndexOf(" ", 900);
    if (end < 400) end = 900;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    chunks.push(remaining.slice(0, end)); remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function fetchVoice(url, payload) {
  if (running || previewAbort || localPlayback) { toast("Najprv zastav počúvanie alebo hlas."); return; }
  const abort = new AbortController(); previewAbort = abort; controls();
  try {
    await unlockAudio();
    const chunks = url === "/api/replay" ? replayChunks(payload.text) : [null];
    for (const text of chunks) {
      if (abort.signal.aborted) break;
      const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]), body: JSON.stringify(text === null ? payload : { ...payload, text }) });
      if (!response.ok) { let e = {}; try { e = await response.json(); } catch {} if (response.status === 401) void signOut(false); throw new Error(e.error || "Hlas nie je dostupný."); }
      const buffer = await response.arrayBuffer();
      if (abort.signal.aborted) break;
      await new Promise(resolve => localAudio(buffer, crypto.randomUUID(), resolve));
    }
  } catch (err) { if (!abort.signal.aborted) error(err.message); }
  finally { if (previewAbort === abort) previewAbort = null; controls(); }
}

function createTurn(item) {
  const el = document.createElement("article"); el.className = "turn";
  const head = document.createElement("div"); head.className = "turn-header";
  const direction = document.createElement("span"), state = document.createElement("span"); head.append(direction, state);
  const source = document.createElement("p"); source.className = "source-text"; source.dir = "auto";
  const translation = document.createElement("p"); translation.className = "translated-text"; translation.dir = "auto";
  const footer = document.createElement("div"); footer.className = "turn-footer";
  const audio = document.createElement("span"); audio.className = "audio-state";
  const button = document.createElement("button"); button.className = "text-button"; button.textContent = "Zopakovať hlas";
  button.addEventListener("click", () => { const latest = entries.find(i => i.id === item.id); if (latest) replay(latest).catch(e => error(e.message)); });
  footer.append(audio, button); el.append(head, source, translation, footer);
  return { el, direction, state, source, translation, audio, button, hash: "" };
}

function render() {
  const feed = $("conversationFeed"), pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  if (!entries.length) { feed.replaceChildren(); nodes.clear(); const p = document.createElement("p"); p.className = "empty"; p.textContent = "Stačí stlačiť Počúvať. Tu sa objaví pôvodná reč aj preklad."; feed.append(p); }
  else {
    feed.querySelector(".empty")?.remove();
    for (const item of entries) {
      let node = nodes.get(item.id); if (!node) { node = createTurn(item); nodes.set(item.id, node); feed.append(node.el); }
      const hash = JSON.stringify(item) + navigator.onLine;
      if (hash === node.hash) continue; node.hash = hash;
      node.el.classList.toggle("is-live", !item.is_final); node.el.classList.toggle("from-other", item.source_language !== chosenA);
      node.direction.textContent = name(item.source_language) + " → " + name(item.target_language);
      node.state.textContent = item.is_final ? "Dokončené" : "Neúplné / priebežné";
      node.source.textContent = item.source_text; node.source.lang = item.source_language || "und";
      node.translation.textContent = item.translated_text; node.translation.lang = item.target_language || "und";
      node.audio.textContent = ({ pending: "Čaká na dokončenie", queued: "Hlas vo fronte", played: "Prehrané", interrupted: "Hlas prerušený", not_spoken: "Neprehrané", text_only: "Iba text" })[item.audio_status] || "";
      node.button.disabled = !item.is_final || !item.translated_text.trim() || !navigator.onLine;
    }
  }
  if (pinned) feed.scrollTop = feed.scrollHeight;
  const last = entries.at(-1);
  $("faceMyLabel").textContent = name(chosenA); $("faceOtherLabel").textContent = name(chosenB);
  $("faceMy").textContent = last ? (last.source_language === chosenA ? last.source_text : last.translated_text) : "";
  $("faceOther").textContent = last ? (last.source_language === chosenA ? last.translated_text : last.source_text) : "";
  $("faceMy").lang = chosenA; $("faceOther").lang = chosenB === "auto" ? "und" : chosenB;
}

function receive(msg) {
  if (msg.type === "session_open") { cancelRequest = ""; conversationId = msg.conversation_id; return; }
  if (msg.conversation_id !== conversationId) return;
  if (msg.type === "server_ready") { ready = true; clearTimeout(connectTimer); controls(); }
  if (msg.type === "state") {
    ready = Boolean(msg.accept_audio); muted = Boolean(msg.microphone_muted);
    stopping = msg.state === "finishing";
    const labels = { listening: "Počúvam", connecting: "Pripájam", translating: "Prekladám", speaking: "Hovorím", finishing: "Dokončujem posledný preklad", confirm_language: "Potvrď rozpoznaný jazyk" };
    status(labels[msg.state] || "Pripravený", msg.state === "listening");
    if (stopping) void stopCapture(false);
    controls();
  }
  if (msg.type === "token") {
    for (const item of msg.conversation_items || []) {
      const id = conversationId + "/" + item.id, existing = entries.find(e => e.id === id);
      const value = { ...item, id, server_id: item.id, conversation: conversationId };
      if (existing) Object.assign(existing, value); else entries.push(value);
    }
    dirty = true; render();
  }
  if (msg.type === "language_candidate") {
    ready = false; fillLanguages($("detectedLanguage"), msg.language);
    $("confirmLanguage").hidden = false; controls();
  }
  if (msg.type === "language_confirmed") {
    chosenB = msg.language; $("confirmLanguage").hidden = true;
    fillLanguages($("langB"), chosenB, "", true); saveSettings(); render();
  }
  if (msg.type === "tts_stream_start") startStream(msg);
  if (msg.type === "tts_stream_end" && playback?.meta.playback_id === msg.playback_id) {
    if (msg.cancelled) { stopSources(playback); playback = null; }
    else { playback.meta.text = msg.text || playback.meta.text; playback.ended = true; playback.interrupted = msg.interrupted; completeStream(); }
  }
  if (msg.type === "local_playback_ready" && localPlayback?.id === msg.playback_id && localPlayback.waiting) {
    const op = localPlayback; clearTimeout(op.timer); localPlayback = null; localAudio(op.buffer, op.id);
  }
  if (msg.type === "audio_cancelled") { if (cancelRequest && msg.request_id !== cancelRequest) return; cancelRequest = ""; stopSources(playback); playback = null; stopLocal(); muted = false; controls(); }
  if (msg.type === "error") { error(msg.message); if (msg.fatal) { disconnect(); if (msg.code === "auth_expired") void signOut(false); } }
  if (msg.type === "session_finished") { disconnect(); status("Rozhovor pozastavený"); void api("/api/usage").then(showUsage).catch(() => {}); }
}

function sendPcm(buffer, flush = false) {
  if (!running || (!ready && !flush) || muted || (stopping && !flush) || socket?.readyState !== WebSocket.OPEN) return;
  if ($("conversationMode").value === "ptt" && !pttPressed) return;
  if ($("conversationMode").value === "auto" && $("outputMode").value === "headphones" && playback?.started && Date.now() - playback.createdAt > 300) {
    const pcm = new Int16Array(buffer); let energy = 0;
    for (let i = 0; i < pcm.length; i += 4) energy += pcm[i] * pcm[i];
    const rms = Math.sqrt(energy / Math.max(1, Math.ceil(pcm.length / 4)));
    vadHits = rms > 1200 ? vadHits + 1 : 0;
    if (vadHits >= 4) { vadHits = 0; stopSound(); }
  } else vadHits = 0;
  if (socket.bufferedAmount + buffer.byteLength > 128 * 1024) { error("Slabé spojenie. Časť reči sa nemusela preniesť. Obnov počúvanie."); disconnect(); return; }
  socket.send(buffer);
}

async function startCapture(currentEpoch) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (epoch !== currentEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
  media = stream;
  try { captureContext = new AudioContext({ sampleRate: 16000 }); } catch { captureContext = new AudioContext(); }
  await captureContext.resume();
  if (epoch !== currentEpoch) return;
  const source = captureContext.createMediaStreamSource(stream);
  const gain = captureContext.createGain(); gain.gain.value = 0; gain.connect(captureContext.destination);
  try {
    await captureContext.audioWorklet.addModule("/audio-capture-worklet.js");
    if (epoch !== currentEpoch) return;
    worklet = new AudioWorkletNode(captureContext, "pcm-capture-processor", { processorOptions: { targetSampleRate: 16000, chunkSize: 1024 } });
    worklet.port.onmessage = event => {
      if (event.data.type === "audio") sendPcm(event.data.buffer, event.data.flush);
      if (event.data.type === "flushed") { flushResolve?.(); flushResolve = null; }
    };
    source.connect(worklet); worklet.connect(gain);
  } catch {
    if (epoch !== currentEpoch) return;
    processor = captureContext.createScriptProcessor(4096, 1, 1);
    let sum = 0, weight = 0; const ratio = captureContext.sampleRate / 16000;
    processor.onaudioprocess = event => {
      event.outputBuffer.getChannelData(0).fill(0); const input = event.inputBuffer.getChannelData(0), samples = [];
      for (const sample of input) {
        let remaining = 1;
        while (remaining > 1e-8) {
          const take = Math.min(remaining, ratio - weight); sum += sample * take; weight += take; remaining -= take;
          if (weight >= ratio - 1e-8) { const v = Math.max(-1, Math.min(1, sum / ratio)); samples.push(v < 0 ? v * 32768 : v * 32767); sum = 0; weight = 0; }
        }
      }
      sendPcm(new Int16Array(samples).buffer);
    };
    source.connect(processor); processor.connect(gain);
  }
}

async function stopCapture(flush) {
  if (flush && worklet) {
    await new Promise(resolve => {
      flushResolve = resolve; worklet.port.postMessage({ type: "flush" });
      setTimeout(() => { if (flushResolve === resolve) { flushResolve = null; resolve(); } }, 300);
    });
  }
  if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); worklet = null; }
  if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null; }
  media?.getTracks().forEach(t => t.stop()); media = null;
  const context = captureContext; captureContext = null; if (context && context.state !== "closed") await context.close();
}

async function lockScreen() {
  if (!navigator.wakeLock || document.visibilityState !== "visible") return;
  try { const lock = await navigator.wakeLock.request("screen"); wakeLock = lock; lock.addEventListener("release", () => { if (wakeLock === lock) wakeLock = null; }); } catch {}
}

async function start() {
  if (running || !user || !navigator.onLine) return;
  if (chosenA === chosenB) { error("Vyber dva rôzne jazyky."); return; }
  if (entries.length >= 1000) { error("Ulož rozhovor a začni nový."); return; }
  error(""); saveSettings(); stopLocal();
  running = true; stopping = false; ready = false; muted = false;
  const token = ++epoch; status("Povoľ mikrofón"); controls();
  try {
    await unlockAudio(); if (epoch !== token) return;
    await startCapture(token); if (epoch !== token || !running) return;
    await lockScreen(); if (epoch !== token) return;
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host); socket = ws; ws.binaryType = "arraybuffer";
    status("Pripájam"); connectTimer = setTimeout(() => { if (socket === ws && !ready) { error("Pripojenie sa nepodarilo. Obnov počúvanie."); disconnect(); } }, 12000);
    ws.onopen = () => {
      if (socket !== ws) { ws.close(); return; }
      send({ type: "config", language_a: chosenA, language_b: chosenB, voice_a: currentVoiceA, voice_b: currentVoiceB, output_mode: $("outputMode").value, tts_enabled: !textOnly(), profile_id: $("profileId").value, conversation_mode: $("conversationMode").value });
    };
    ws.onmessage = event => {
      if (socket !== ws) return;
      try { typeof event.data === "string" ? receive(JSON.parse(event.data)) : streamAudio(event.data); }
      catch { error("Neplatná odpoveď servera."); disconnect(); }
    };
    ws.onerror = () => { if (socket === ws) error("Spojenie zlyhalo. Skontroluj internet alebo prihlásenie."); };
    ws.onclose = event => { if (socket === ws) { disconnect(); if (event.code !== 1000) error("Spojenie sa prerušilo. Prepis zostal zachovaný; obnov počúvanie."); } };
  } catch (err) { if (epoch === token) { disconnect(); error(err.name === "NotAllowedError" ? "Povoľ mikrofón v nastavení tejto stránky." : "Mikrofón alebo zvuk nie je dostupný."); } }
}

async function pause() {
  if (stopping) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) { disconnect(); return; }
  stopping = true; controls(); await stopCapture(true);
  send({ type: "client_stop" }); status("Dokončujem posledný preklad");
  finishTimer = setTimeout(() => { error("Dokončenie trvalo príliš dlho."); disconnect(); }, 125000);
}

function disconnect() {
  epoch++; cancelRequest = ""; clearTimeout(connectTimer); clearTimeout(finishTimer);
  const ws = socket; socket = null;
  if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close(); } catch {} }
  for (const item of entries) if (["queued", "pending"].includes(item.audio_status)) item.audio_status = "not_spoken";
  running = false; stopping = false; ready = false; muted = false; pttPressed = false; pttSide = ""; pttEnding = false; vadHits = 0;
  render(); void stopCapture(false); stopSources(playback); playback = null; stopLocal();
  if (wakeLock) { void wakeLock.release(); wakeLock = null; }
  $("confirmLanguage").hidden = true; status("Pripravený"); controls();
}

function clearEntries() {
  entries = []; nodes.clear(); audioCache.clear(); audioCacheBytes = 0; dirty = false;
  render(); $("conversationLabel").textContent = "Aktuálny rozhovor";
}

function asText(items = entries) { return items.map(i => name(i.source_language) + " → " + name(i.target_language) + (i.is_final ? "" : " [neúplné]") + "\n" + i.source_text + "\n" + i.translated_text).join("\n\n"); }

async function showHistory() {
  const owner = user; if (!owner) return;
  const rows = await LocalHistory.list(owner);
  if (owner !== user) return;
  const list = $("historyList"); list.replaceChildren();
  if (!rows.length) { const p = document.createElement("p"); p.textContent = "Zatiaľ nemáš uložený rozhovor."; list.append(p); }
  for (const row of rows) {
    const el = document.createElement("article"); el.className = "history-row";
    const title = document.createElement("h3"); title.textContent = new Date(row.created_at).toLocaleString("sk") + " · " + name(row.languages.a) + " ↔ " + name(row.languages.b);
    const actions = document.createElement("div"); actions.className = "history-actions";
    for (const [label, fn] of [
      ["Otvoriť", () => {
        if (dirty && !confirm("Zahodiť neuložený aktuálny rozhovor?")) return;
        disconnect(); clearEntries(); entries = row.items; chosenA = row.languages.a; chosenB = row.languages.b;
        fillLanguages($("langA"), chosenA); fillLanguages($("langB"), chosenB, "", true);
        $("conversationLabel").textContent = "Uložený rozhovor"; render(); controls(); $("historyDialog").close();
      }],
      ["Exportovať", () => {
        const url = URL.createObjectURL(new Blob([asText(row.items)], { type: "text/plain;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = "rozhovor-" + row.created_at.slice(0,10) + ".txt"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }],
      ["Vymazať", async () => { if (confirm("Vymazať tento uložený rozhovor?")) { await LocalHistory.remove(user, row.id); await showHistory(); } }],
    ]) { const b = document.createElement("button"); b.textContent = label; b.className = "secondary"; b.addEventListener("click", () => { if (owner === user) Promise.resolve(fn()).catch(e => error(e.message)); }); actions.append(b); }
    el.append(title, actions); list.append(el);
  }
  if (!$("historyDialog").open) $("historyDialog").showModal();
}

function settingsChanged() {
  saveSettings(); controls();
  send({ type: "update_settings", voice_a: currentVoiceA, voice_b: currentVoiceB, output_mode: $("outputMode").value, tts_enabled: !textOnly() });
  if (textOnly()) stopSound();
}
$("loginForm").addEventListener("submit", async event => {
  event.preventDefault(); $("loginStatus").textContent = "Prihlasujem…";
  const button = event.currentTarget.querySelector("button"); button.disabled = true;
  try { await showApp(await api("/api/login", { method: "POST", body: JSON.stringify({ code: $("accessCode").value.trim() }) })); $("loginStatus").textContent = ""; }
  catch (err) { $("loginStatus").textContent = err.message; }
  finally { button.disabled = false; }
});
$("startBtn").addEventListener("click", () => (running ? pause() : start()).catch(e => error(e.message)));
$("stopAudioBtn").addEventListener("click", stopSound);
$("settingsBtn").addEventListener("click", () => $("settingsDialog").showModal());
for (const b of document.querySelectorAll(".close-dialog")) b.addEventListener("click", () => b.closest("dialog").close());
$("logoutBtn").addEventListener("click", () => void signOut());
$("confirmLanguageBtn").addEventListener("click", () => send({ type: "confirm_language", language: $("detectedLanguage").value }));
$("textOnly").addEventListener("change", settingsChanged);
$("outputMode").addEventListener("change", settingsChanged);
$("faceMode").addEventListener("change", () => { $("facePanel").hidden = !$("faceMode").checked; render(); });
for (const side of ["A", "B"]) {
  $("search" + side).addEventListener("input", event => fillLanguages($("lang" + side), side === "A" ? chosenA : chosenB, event.target.value, side === "B"));
  $("lang" + side).addEventListener("change", event => {
    if (side === "A") chosenA = event.target.value; else chosenB = event.target.value;
    saveSettings(); render();
    const note = languages.find(l => l.code === event.target.value)?.script_note;
    if (note) toast(note);
  });
  for (const field of ["gender", "accent", "age", "style", "voiceSearch"]) $(field + side).addEventListener(field === "voiceSearch" ? "input" : "change", () => fillVoices(side));
  $("voice" + side).addEventListener("change", event => { if (side === "A") currentVoiceA = event.target.value; else currentVoiceB = event.target.value; settingsChanged(); });
  $("preview" + side).addEventListener("click", () => fetchVoice("/api/preview-voice", { language: side === "A" || chosenB === "auto" ? chosenA : chosenB, voice: side === "A" ? currentVoiceA : currentVoiceB }).catch(e => error(e.message)));
}
function beginPtt(side) {
  if (!running || !ready || stopping || pttPressed || pttEnding || $("conversationMode").value !== "ptt") return;
  if (playback || localPlayback) stopSound();
  pttPressed = true; pttSide = side;
  $("ptt" + side).classList.add("pressed");
  send({ type: "ptt_start" }); controls();
}
async function finishPtt(side) {
  if (!pttPressed || pttSide !== side) return;
  pttPressed = false; pttSide = ""; pttEnding = true;
  $("ptt" + side).classList.remove("pressed"); controls();
  const ws = socket;
  // Ten 20 ms zero frames give Soniox the silence required before finalize.
  for (let i = 0; i < 10 && socket === ws && ws?.readyState === WebSocket.OPEN; i++) {
    ws.send(new Int16Array(320).buffer);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (socket === ws) send({ type: "ptt_end" });
  pttEnding = false; controls();
}
for (const side of ["A", "B"]) {
  const button = $("ptt" + side);
  button.addEventListener("pointerdown", event => { event.preventDefault(); button.setPointerCapture(event.pointerId); beginPtt(side); });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, () => { void finishPtt(side); });
  button.addEventListener("keydown", event => {
    if (!event.repeat && [" ", "Enter"].includes(event.key)) { event.preventDefault(); beginPtt(side); }
  });
  button.addEventListener("keyup", event => {
    if ([" ", "Enter"].includes(event.key)) { event.preventDefault(); void finishPtt(side); }
  });
}
$("profileId").addEventListener("change", saveSettings);
$("conversationMode").addEventListener("change", () => { saveSettings(); controls(); });
$("swapBtn").addEventListener("click", () => { if (running || chosenB === "auto") return; [chosenA, chosenB] = [chosenB, chosenA]; fillLanguages($("langA"), chosenA); fillLanguages($("langB"), chosenB, "", true); saveSettings(); render(); });
$("newBtn").addEventListener("click", () => { if (dirty && !confirm("Zahodiť neuložený rozhovor?")) return; disconnect(); clearEntries(); error(""); controls(); });
$("copyBtn").addEventListener("click", () => { if (entries.length) navigator.clipboard.writeText(asText()).then(() => toast("Rozhovor skopírovaný.")).catch(() => error("Kopírovanie nie je dostupné.")); });
$("saveBtn").addEventListener("click", async () => {
  if (!entries.length) { toast("Rozhovor je prázdny."); return; }
  const snapshot = JSON.stringify(entries), owner = user;
  try { await LocalHistory.save(owner, entries, { a: chosenA, b: chosenB }); if (user === owner && snapshot === JSON.stringify(entries)) dirty = false; toast("Text uložený v tomto zariadení."); }
  catch (err) { error(err.message); }
});
$("historyBtn").addEventListener("click", () => showHistory().catch(e => error(e.message)));

function connectivity() {
  $("offlineBanner").hidden = navigator.onLine;
  if (!navigator.onLine && running) { error("Internet sa prerušil. Obnov počúvanie po pripojení."); disconnect(); }
  controls(); render();
}
window.addEventListener("online", connectivity); window.addEventListener("offline", connectivity);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && running) {
    send({ type: "client_stop" }); disconnect(); error("Po návrate do aplikácie obnov počúvanie. Prehliadač môže na pozadí pozastaviť mikrofón.");
  } else if (running && !wakeLock) void lockScreen();
});
window.addEventListener("pagehide", () => { send({ type: "client_stop" }); disconnect(); });
window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
connectivity();
setInterval(async () => {
  const owner = user; if (!owner || !navigator.onLine) return;
  try {
    const [languageData, voiceData] = await Promise.all([api("/api/languages"), api("/api/voices")]);
    if (owner !== user) return;
    languages = languageData.languages.sort((a,b) => a.name.localeCompare(b.name,"sk"));
    voices = voiceData.voices; ttsModel = voiceData.model; voiceInfo(voiceData); fillVoiceFilters();
    $("catalogNote").textContent = languageData.stale || voiceData.stale ? "Používa sa posledný dostupný katalóg." : languages.length + " dostupných jazykov";
    if (!running) { fillLanguages($("langA"), chosenA); fillLanguages($("langB"), chosenB, "", true); fillVoices("A"); fillVoices("B"); }
  } catch {}
}, 600000);
api("/api/session").then(showApp).catch(() => { $("loginShell").hidden = false; $("appShell").hidden = true; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
