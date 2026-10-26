"use strict";
const $ = id => document.getElementById(id);
let user = null, languages = [], voices = [], socket = null, conversationId = "", epoch = 0;
let running = false, stopping = false, ready = false, muted = false, dirty = false, serverState = "idle";
let media = null, captureContext = null, worklet = null, wakeLock = null, flushResolve = null;
let playbackContext = null, playback = null, localPlayback = null, previewAbort = null;
let entries = [], nodes = new Map(), audioCache = new Map(), audioCacheBytes = 0, ttsModel = "tts-rt-v2";
let chosenA = "sk", chosenB = "de", voiceA = "Adrian", voiceB = "Adrian";
let toastTimer, connectTimer, finishTimer, reconnectTimer, stableTimer, cancelRequest = "";
let pttPressed = false, pttSide = "", pttEnding = false, pttDraining = false, vadHits = 0;
let pending = [], pendingBytes = 0, lastFrameAt = 0, captureWatch = null;
let reconnectAttempts = 0, resumePending = false, faceMode = false;
let mode = "conversation", listenSource = "auto", listenSubtitles = true, listenVoice = true, userStopped = false;
let languageSide = "A", voiceSide = "A", voiceGender = "";
const prefs = { conversationMode: "auto", outputMode: "speaker", ttsSpeed: "1", profileId: "conversation" };
const MAX_CACHE = 12 * 1024 * 1024;
const RECONNECTABLE = new Set(["stt_connection", "stt_timeout", "stt_retry"]);
const STABLE_MS = 30000;
const START_BUFFER_BYTES = 3 * 16000 * 2;
const STATE_LABELS = { idle: "Pripravený", connecting: "Pripájam…", listening: "Počúvam", translating: "Prekladám", speaking: "Hovorím", finishing: "Dokončujem preklad…", confirm_language: "Potvrď jazyk", reconnecting: "Obnovujem spojenie…", paused: "Pozastavené" };
const AUDIO_LABELS = { pending: "Čaká", queued: "Vo fronte", played: "Prehrané", interrupted: "Prerušené", not_spoken: "Neprehrané", text_only: "Iba text" };
const store = {
  get(key, fallback) { try { return localStorage.getItem("translator." + key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem("translator." + key, value); } catch {} },
};

/* ---------- small helpers ---------- */
function toast(message) { const t = $("toast"); (Array.from(document.querySelectorAll("dialog[open]")).at(-1) || document.body).append(t); t.textContent = message; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3200); }
function error(message) { $("errorText").textContent = message || ""; $("errorBanner").hidden = !message; }
function haptic() { try { navigator.vibrate?.(12); } catch {} }
function name(code) { return code === "auto" ? "Rozpoznať jazyk" : languages.find(l => l.code === code)?.name || code; }
function shortCode(code) { return code === "auto" ? "?" : String(code).toUpperCase(); }
function ttsEnabled() { return mode === "listen" ? listenVoice : prefs.outputMode !== "text"; }
function microphoneMode() { return mode === "listen" ? "auto" : prefs.conversationMode; }
function outputMode() { return prefs.outputMode === "headphones" ? "headphones" : "speaker"; }
function capitalize(text) { return text ? text[0].toLocaleUpperCase("sk") + text.slice(1) : text; }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function icon(id) { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", "#" + id); svg.append(use); return svg; }
function openSheet(id) { const d = $(id); if (!d.open) d.showModal(); }
function closeSheets() { for (const d of document.querySelectorAll("dialog[open]")) d.close(); document.body.append($("toast")); }

function saveSettings() {
  store.set("langA", chosenA); store.set("langB", chosenB); store.set("voiceA", voiceA); store.set("voiceB", voiceB);
  store.set("conversationMode", prefs.conversationMode); store.set("outputMode", prefs.outputMode);
  store.set("ttsSpeed", prefs.ttsSpeed); store.set("profileId", prefs.profileId);
  store.set("ttsEnabled", String(prefs.outputMode !== "text"));
  store.set("mode", mode); store.set("listen_source", listenSource);
  store.set("listenSubtitles", String(listenSubtitles)); store.set("listenVoice", String(listenVoice));
  const recent = [chosenA, chosenB, ...store.get("recent", "").split(",")].filter(c => c && c !== "auto");
  store.set("recent", [...new Set(recent)].slice(0, 6).join(","));
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(8000), ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  if (!response.ok) {
    let message = "Operácia zlyhala.", code; try { const data = await response.json(); message = data.error || message; code = data.code; } catch {}
    if (response.status === 401 && user) await signOut(false);
    const failure = new Error(message); failure.code = code; throw failure;
  }
  return response.json();
}
function send(data) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }

/* ---------- UI state ---------- */
function controls() {
  const app = $("appShell"), listen = mode === "listen", ptt = microphoneMode() === "ptt";
  const state = stopping ? "finishing" : reconnectTimer ? "reconnecting" : running ? (serverState === "idle" ? "connecting" : serverState) : resumePending ? "paused" : "idle";
  app.dataset.state = state;
  app.dataset.mode = mode;
  for (const b of $("sessionMode").querySelectorAll("button")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === mode)); b.disabled = running || stopping || Boolean(reconnectTimer);
  }
  $("listenOptions").hidden = !listen;
  $("listenSubtitles").checked = listenSubtitles; $("listenVoice").checked = listenVoice;
  $("listenCalm").hidden = !listen || listenSubtitles;
  $("listenCalmTitle").textContent = running ? ["listening", "translating", "speaking"].includes(state) ? "Počúvam" : STATE_LABELS[state] || "Počúvam" : "Ťukni na mikrofón a počúvaj";
  $("stage").setAttribute("aria-label", listen ? "Titulky počúvania" : "Rozhovor");
  app.classList.toggle("is-running", running);
  $("status").textContent = STATE_LABELS[state] || STATE_LABELS.idle;
  $("modeLabel").textContent = listen ? listenVoice ? "Hlas · výstup telefónu" : "Iba titulky" : (ttsEnabled() ? outputMode() === "speaker" ? "Reproduktor" : "Slúchadlá" : "Iba text") + (ptt ? " · Podržať" : "");
  $("langACode").textContent = shortCode(chosenA); $("langAName").textContent = capitalize(name(chosenA));
  $("langBCode").textContent = shortCode(listen ? listenSource : chosenB); $("langBName").textContent = listen ? (listenSource === "auto" ? "Auto" : capitalize(name(listenSource))) + " ▾" : capitalize(name(chosenB));
  $("langBBtn").setAttribute("aria-label", listen ? "Jazyk, ktorý počúvam" : "Jazyk druhej osoby");
  $("swapBtn").hidden = listen; $("listenArrow").hidden = !listen;
  for (const id of ["langABtn", "langBBtn"]) $(id).disabled = running || stopping;
  $("swapBtn").disabled = running || stopping || chosenB === "auto";
  const mic = $("startBtn");
  mic.disabled = stopping || (!navigator.onLine && !running);
  mic.setAttribute("aria-label", listen ? running ? "Zastaviť počúvanie" : "Spustiť počúvanie" : running ? "Zastaviť rozhovor" : entries.length ? "Pokračovať v rozhovore" : "Počúvať");
  $("autoControls").hidden = running && ptt;
  $("pttControls").hidden = !(running && ptt);
  for (const id of ["pttA", "pttB"]) $(id).disabled = !ready || stopping || pttEnding;
  $("pttEndBtn").disabled = stopping;
  $("pttALabel").textContent = capitalize(name(chosenA)); $("pttBLabel").textContent = capitalize(name(chosenB));
  $("stopAudioBtn").disabled = !playback && !localPlayback && !previewAbort;
  $("resumeBar").hidden = running || !resumePending || !entries.length;
  $("faceBtn").setAttribute("aria-pressed", String(faceMode));
  $("faceBtn").hidden = listen;
  $("facePanel").hidden = listen || !faceMode;
  $("feed").hidden = listen ? !listenSubtitles : faceMode;
  for (const group of document.querySelectorAll(".segmented[data-setting]")) {
    const value = prefs[group.dataset.setting];
    for (const b of group.querySelectorAll("button")) {
      b.setAttribute("aria-checked", String(b.dataset.value === value));
      b.disabled = (["conversationMode", "outputMode"].includes(group.dataset.setting) && listen) || (group.dataset.setting === "conversationMode" && (running || stopping));
    }
  }
  $("profileId").value = prefs.profileId; $("profileId").disabled = running || stopping;
  $("settingsLockHint").hidden = !(running || stopping);
  $("voiceALabel").textContent = "Môj jazyk · " + capitalize(name(chosenA));
  $("voiceBLabel").textContent = "Druhá osoba · " + capitalize(name(chosenB === "auto" ? chosenA : chosenB));
  $("voiceAValue").textContent = voices.find(v => v.id === voiceA)?.name || voiceA;
  $("voiceBValue").textContent = voices.find(v => v.id === voiceB)?.name || voiceB;
  $("voiceBBtn").hidden = listen;
  $("emptyTitle").textContent = listen ? running ? "Počúvam okolie" : "Ťukni na mikrofón a počúvaj" : running && ptt ? "Podrž tlačidlo svojho jazyka" : "Ťukni na mikrofón a hovor";
  $("emptySub").textContent = ttsEnabled() ? "Preklad sa zobrazí tu a prečíta nahlas." : "Preklad sa zobrazí tu.";
}

/* ---------- sheets: languages ---------- */
function normalize(text) { return String(text).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase(); }
function languageOption(code, title, sub, selected) {
  const b = el("button", "option"); b.type = "button"; b.setAttribute("role", "option"); b.setAttribute("aria-selected", String(selected));
  const main = el("span", "option-main"); main.append(el("span", "option-title", title)); if (sub) main.append(el("span", "option-sub", sub));
  const check = icon("i-check"); check.classList.add("check");
  b.append(main, check);
  b.addEventListener("click", () => selectLanguage(code));
  return b;
}
function fillLanguageList() {
  const list = $("languageList"), term = normalize($("languageSearch").value.trim());
  const selected = languageSide === "A" ? chosenA : mode === "listen" ? listenSource : chosenB;
  list.replaceChildren();
  const matches = l => !term || normalize(l.name + " " + l.native_name + " " + l.code).includes(term);
  if (languageSide === "B" && !term) list.append(languageOption("auto", mode === "listen" ? "Automaticky" : "Rozpoznať jazyk", mode === "listen" ? "Priebežne rozpoznáva cudziu reč" : "Prvú vetu druhej osoby potvrdíš", selected === "auto"));
  const recent = store.get("recent", "").split(",").map(c => languages.find(l => l.code === c)).filter(Boolean);
  if (!term && recent.length) {
    list.append(el("p", "list-label", "Naposledy použité"));
    for (const l of recent) list.append(languageOption(l.code, capitalize(l.name), l.native_name !== l.name ? l.native_name : "", l.code === selected));
    list.append(el("p", "list-label", "Všetky jazyky"));
  }
  let count = 0;
  for (const l of languages) if (matches(l)) {
    count++;
    list.append(languageOption(l.code, capitalize(l.name), [l.native_name !== l.name ? l.native_name : "", l.tts === false ? "iba text" : ""].filter(Boolean).join(" · "), l.code === selected));
  }
  if (!count) list.append(el("p", "empty-list", "Žiadny jazyk nezodpovedá hľadaniu."));
}
function openLanguages(side) {
  if (running || stopping) return;
  languageSide = side; $("languageTitle").textContent = side === "A" ? "Môj jazyk" : mode === "listen" ? "Jazyk, ktorý počúvam" : "Jazyk druhej osoby";
  $("languageSearch").value = ""; fillLanguageList(); openSheet("languageSheet");
}
function selectLanguage(code) {
  if (mode === "listen" && languageSide === "B") {
    if (code === chosenA) { toast("Vyber iný jazyk než svoj."); return; }
    listenSource = code;
  } else if (languageSide === "A") { if (code === chosenB) chosenB = chosenA; chosenA = code; }
  else { if (code === chosenA) chosenA = chosenB === "auto" ? chosenA : chosenB; chosenB = code; }
  if (chosenA === chosenB) chosenB = "auto";
  if (listenSource === chosenA) listenSource = "auto";
  saveSettings(); $("languageSheet").close(); renderAll(); controls();
  const note = languages.find(l => l.code === code)?.script_note;
  if (note) toast(note);
}

/* ---------- sheets: voices ---------- */
function voiceLanguage(side) { return side === "A" || chosenB === "auto" ? chosenA : chosenB; }
function fillVoiceList() {
  const list = $("voiceList"), selected = voiceSide === "A" ? voiceA : voiceB;
  const term = $("voiceSearch").value.toLocaleLowerCase("sk").trim();
  for (const chip of $("voiceGender").children) chip.setAttribute("aria-checked", String(chip.dataset.value === voiceGender));
  const matches = voices.filter(v => (!voiceGender || v.gender === voiceGender) && (!term || [v.name, v.description, v.accent, v.age, ...(v.style || []), ...(v.use_case || [])].join(" ").toLocaleLowerCase("sk").includes(term)));
  matches.sort((a, b) => (b.kind === "custom") - (a.kind === "custom") || (b.id === selected) - (a.id === selected));
  list.replaceChildren();
  for (const v of matches.slice(0, 120)) {
    const row = el("div", "option"); row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(v.id === selected)); row.tabIndex = 0;
    const main = el("span", "option-main");
    main.append(el("span", "option-title", v.name + (v.kind === "custom" ? " · môj hlas" : "")));
    const sub = [v.gender === "female" ? "ženský" : v.gender === "male" ? "mužský" : "", v.accent, ...(v.style || [])].filter(Boolean).map(s => String(s).replaceAll("_", " ")).join(" · ");
    if (sub) main.append(el("span", "option-sub", sub));
    const play = el("button", "icon-btn"); play.type = "button"; play.setAttribute("aria-label", "Vypočuť " + v.name); play.append(icon("i-play"));
    play.addEventListener("click", event => { event.stopPropagation(); fetchVoice("/api/preview-voice", { language: voiceLanguage(voiceSide), voice: v.id }).catch(e => error(e.message)); });
    const check = icon("i-check"); check.classList.add("check");
    row.append(main, check, play);
    const choose = () => selectVoice(v.id);
    row.addEventListener("click", choose);
    row.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } });
    list.append(row);
  }
  if (!matches.length) list.append(el("p", "empty-list", "Žiadny hlas nezodpovedá filtru."));
}
function openVoices(side) {
  voiceSide = side; $("voiceTitle").textContent = side === "A" ? "Hlas pre môj jazyk" : "Hlas pre druhú osobu";
  $("voiceSearch").value = ""; fillVoiceList(); openSheet("voiceSheet");
}
function selectVoice(id) {
  if (voiceSide === "A") voiceA = id; else voiceB = id;
  $("voiceSheet").close(); settingsChanged();
}
function voiceInfo(data) {
  $("customVoiceStatus").textContent = data.custom_voice?.message || "";
  $("customVoiceStatus").hidden = !data.custom_voice;
}
function ensureVoices() {
  if (!voices.some(v => v.id === voiceA)) voiceA = voices[0]?.id || "Adrian";
  if (!voices.some(v => v.id === voiceB)) voiceB = voices[0]?.id || "Adrian";
}

/* ---------- sheets: administration ---------- */
let adminRole = false, adminUsers = [], selectedUser = "", adminVersion = 0, userVersion = 0, adminBusy = false, newRole = "user", selfPasswordReset = false;
const LIMIT_FIELDS = [["limitMinutes", "sttSeconds", 60], ["limitChars", "ttsChars", 1], ["limitSessions", "sessions", 1], ["limitMonth", "sttSecondsMonth", 60]];
const AUDIT_LABELS = { create_user: "Vytvorenie účtu", reset_password: "Nové heslo", set_limits: "Zmena limitov", set_role: "Zmena roly", disable_user: "Zablokovanie", enable_user: "Odblokovanie", logout_user: "Odhlásenie zariadení", delete_user: "Zmazanie účtu", bootstrap_import: "Import účtu", break_glass: "Núdzové prihlásenie", register_passkey: "Pridanie prístupového kľúča", delete_passkey: "Odstránenie prístupového kľúča", delete_passkeys: "Odobratie prístupových kľúčov", passkey_login: "Prihlásenie odtlačkom / Face ID" };
function number(value, digits = 1) { return Number(value || 0).toLocaleString("sk", { maximumFractionDigits: digits }); }
function minutes(data) { return number((data?.sttSeconds || 0) / 60); }
function voiceMinutes(data) { return number((data?.ttsAudioBytes || 0) / 48000 / 60); }
function usd(value) { return Number(value || 0).toLocaleString("sk", { style: "currency", currency: "USD", maximumFractionDigits: 4 }); }
function relative(at) {
  const time = typeof at === "number" ? at : Date.parse(at);
  if (at == null || !Number.isFinite(time)) return "zatiaľ nikdy";
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return "práve teraz";
  if (seconds < 3600) return "pred " + Math.floor(seconds / 60) + " min";
  if (seconds < 86400) return "pred " + Math.floor(seconds / 3600) + " h";
  return new Intl.RelativeTimeFormat("sk", { numeric: "always" }).format(-Math.floor(seconds / 86400), "day");
}
function usageBar(label, value, limit) {
  const box = el("div", "usage-bar"), head = el("div", "usage-label"), bounded = Number.isFinite(limit);
  const ratio = bounded ? limit > 0 ? value / limit : value > 0 ? 1 : 0 : 0;
  head.append(el("span", "", label), el("span", "", number(value) + " / " + (bounded ? number(limit) : "bez limitu")));
  const track = el("div", "usage-track"), fill = el("div", "usage-fill" + (ratio > .8 ? " warning" : ""));
  track.setAttribute("role", "meter"); track.setAttribute("aria-label", label); track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(bounded ? Math.max(limit, 1) : Math.max(value, 1)));
  track.setAttribute("aria-valuenow", String(Math.min(value, bounded ? Math.max(limit, 1) : Math.max(value, 1)))); track.setAttribute("aria-valuetext", head.textContent);
  fill.style.width = Math.min(100, Math.max(0, ratio * 100)) + "%"; track.append(fill); box.append(head, track); return box;
}
function badges(row) {
  const box = el("div", "badges");
  if (row.active) { const dot = el("span", "dot active-dot"); dot.setAttribute("role", "img"); dot.setAttribute("aria-label", "Práve hovorí"); box.append(dot); }
  if (row.role === "admin") box.append(el("span", "badge", "Admin"));
  if (row.disabled) box.append(el("span", "badge blocked", "Zablokovaný"));
  return box;
}
function stats(data, withCost = false) {
  const box = el("div", "admin-stats");
  for (const [label, value] of [["Rozpoznávanie", minutes(data) + " min"], ["Hlas", voiceMinutes(data) + " min"], ["Rozhovory", number(data?.sessions, 0)], ...(withCost ? [["Odhad", usd(data?.estimated_usd)]] : [])]) {
    const cell = el("div"); cell.append(el("strong", "", value), el("span", "hint", label)); box.append(cell);
  }
  return box;
}
function detailRow(title, sub) { const row = el("div", "option"), main = el("div", "option-main"); main.append(el("span", "option-title", title), el("span", "option-sub", sub)); row.append(main); return row; }
function adminError(err) { error(err.message); toast(err.message); }
async function refreshAdmin() {
  const version = ++adminVersion, owner = user; $("adminStatus").textContent = "Načítavam…";
  try {
    const [users, usage, audit] = await Promise.all([api("/api/admin/users"), api("/api/admin/usage?days=30"), api("/api/admin/audit?limit=20")]);
    if (version !== adminVersion || owner !== user || !adminRole) return;
    adminUsers = users.users; $("adminUsers").replaceChildren();
    for (const row of adminUsers) {
      const card = el("button", "option user-card"); card.type = "button";
      const head = el("div", "user-card-head"); head.append(el("strong", "option-title", row.username), badges(row));
      card.append(head, usageBar("Dnes · min", (row.today.sttSeconds || 0) / 60, row.limits_effective.sttSeconds / 60), el("span", "hint", "Prihlásenie " + relative(row.last_login_at) + " · prístupové kľúče: " + (row.passkeys || 0)));
      card.addEventListener("click", () => { void openUser(row.username).catch(adminError); }); $("adminUsers").append(card);
    }
    $("adminUsage").replaceChildren(stats(usage.totals, true));
    const list = el("div", "list");
    for (const row of usage.by_user) list.append(detailRow(row.username, minutes(row) + " min · hlas " + voiceMinutes(row) + " min · " + number(row.sessions, 0) + " rozh. · " + usd(row.estimated_usd)));
    if (!usage.by_user.length) list.append(el("p", "hint", "Zatiaľ bez spotreby."));
    list.append(el("h4", "group-title", "Najčastejšie jazykové páry"));
    for (const row of [...usage.conversations.languages].sort((a, b) => b.count - a.count).slice(0, 5)) list.append(detailRow(row.pair, number(row.count, 0) + " rozhovorov"));
    if (!usage.conversations.languages.length) list.append(el("p", "hint", "Zatiaľ bez rozhovorov."));
    $("adminUsage").append(list); $("adminAudit").replaceChildren();
    for (const row of audit.audit.slice(0, 20)) $("adminAudit").append(detailRow(row.actor + " · " + (AUDIT_LABELS[row.action] || "Zmena účtu"), new Date(row.at).toLocaleString("sk") + (row.target ? " · " + row.target : "")));
    if (!audit.audit.length) $("adminAudit").append(el("p", "hint", "Zatiaľ bez zmien."));
    $("adminStatus").textContent = "Aktualizované " + new Date().toLocaleTimeString("sk", { hour: "2-digit", minute: "2-digit" }); $("sonioxUsage").replaceChildren();
    if (selectedUser && $("userSheet").open) {
      const row = adminUsers.find(u => u.username === selectedUser);
      if (row) { renderUser(row); await loadUserChart(row.username); } else $("userSheet").close();
    }
  } catch (err) {
    if (version === adminVersion && owner === user) $("adminStatus").textContent = "Údaje sa nepodarilo obnoviť.";
    throw err;
  }
}
async function openUser(username) {
  if (adminBusy) return;
  selectedUser = username; $("userInvitation").replaceChildren(); $("userInvitation").hidden = true;
  renderUser(adminUsers.find(u => u.username === username)); openSheet("userSheet"); await loadUserChart(username);
}
function renderUser(row) {
  $("userTitle").textContent = row.username; $("userBadges").replaceChildren(badges(row));
  $("userNote").textContent = row.note || "Bez poznámky."; $("userUsage").replaceChildren(stats(row.month));
  for (const [id, key, scale] of LIMIT_FIELDS) {
    $(id).value = row.limits_override?.[key] == null ? "" : row.limits_override[key] / scale;
    $(id).placeholder = row.limits_effective[key] == null ? "Bez limitu" : number(row.limits_effective[key] / scale);
  }
  const actions = $("userActions"); actions.replaceChildren();
  const action = (label, path, body, question, danger = false) => {
    const b = el("button", "btn " + (danger ? "btn-danger" : "btn-ghost"), label); b.type = "button"; b.disabled = adminBusy;
    b.addEventListener("click", () => { if (!question || confirm(question)) void mutateUser(row.username, path, body).catch(adminError); }); actions.append(b);
  };
  action("Nové heslo", "password", {}, "Vytvoriť nové heslo pre " + row.username + " a odhlásiť všetky zariadenia?");
  action("Odhlásiť všade", "logout", {}, "Odhlásiť všetky zariadenia používateľa " + row.username + "?");
  if (row.passkeys) action("Odobrať prístupové kľúče (" + row.passkeys + ")", "passkeys/delete", {}, "Odobrať všetky prístupové kľúče používateľa " + row.username + "?");
  if (row.username !== user) {
    action(row.disabled ? "Odblokovať" : "Zablokovať", row.disabled ? "enable" : "disable", {}, row.disabled ? "" : "Zablokovať používateľa " + row.username + " a ukončiť jeho rozhovor?", !row.disabled);
    action(row.role === "admin" ? "Používateľ" : "Admin", "role", { role: row.role === "admin" ? "user" : "admin" }, "Zmeniť rolu používateľa " + row.username + " na " + (row.role === "admin" ? "Používateľ" : "Admin") + "?");
    action("Zmazať účet", "delete", {}, "Natrvalo zmazať účet " + row.username + "?", true);
  }
  $("userDevices").replaceChildren();
  for (const session of row.sessions) $("userDevices").append(detailRow(String(session.device || "Neznáme zariadenie").slice(0, 80), "Aktivita " + relative(session.last_seen_at)));
  if (!row.sessions.length) $("userDevices").append(el("p", "hint", "Žiadne prihlásené zariadenia."));
}
async function loadUserChart(username) {
  const version = ++userVersion, owner = user; $("userChart").textContent = "Načítavam…";
  try {
    const usage = await api("/api/admin/usage?username=" + encodeURIComponent(username) + "&days=30");
    if (version !== userVersion || selectedUser !== username || user !== owner || !$("userSheet").open) return;
    const days = Array.from({ length: 30 }, (_, i) => { const day = new Date(Date.parse(usage.from + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10); return { day, value: usage.days.filter(d => d.day === day).reduce((n, d) => n + d.sttSeconds / 60, 0) }; });
    const max = Math.max(1, ...days.map(d => d.value)), chart = el("div", "usage-chart");
    chart.setAttribute("role", "img"); chart.setAttribute("aria-label", "Minúty rozpoznávania po dňoch (UTC): " + days.map(d => d.day + ": " + number(d.value)).join("; "));
    for (const day of days) { const bar = el("div", "chart-bar"); bar.style.height = day.value / max * 100 + "%"; bar.title = day.day + ": " + number(day.value) + " min"; chart.append(bar); }
    $("userChart").replaceChildren(chart, el("p", "hint", usage.from + " – " + usage.to + " · spolu " + minutes(usage.totals) + " min"));
  } catch (err) { if (version === userVersion && selectedUser === username) $("userChart").textContent = err.message; }
}
function setAdminBusy(value) {
  adminBusy = value;
  for (const node of document.querySelectorAll(".admin-sheet button:not(.close-sheet), .admin-sheet input, .admin-sheet textarea")) node.disabled = value;
}
function readLimits(fields, existing = null) {
  if (fields.every(([id]) => $(id).value.trim() === "")) return null;
  const limits = { ...existing };
  for (const [id, key, scale] of fields) {
    const value = $(id).value.trim(); delete limits[key];
    if (value !== "") { const n = Number(value) * scale; if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new Error("Limit musí byť číslo od 0 do 1 000 000 000 000."); limits[key] = n; }
  }
  return Object.keys(limits).length ? limits : null;
}
function invitation(id, data) {
  const box = $(id), text = "Prekladač: " + location.origin + "\nMeno: " + data.username + "\nHeslo: " + data.password;
  box.replaceChildren(el("h3", "group-title", "Pozvánka"), el("pre", "invitation-text", text), el("p", "hint", "Heslo sa zobrazí iba teraz.")); box.hidden = false;
  const buttons = el("div", "admin-actions"), copy = el("button", "btn btn-primary", "Kopírovať pozvánku"); copy.type = "button";
  copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); toast("Pozvánka skopírovaná."); } catch { toast("Kopírovanie nie je dostupné."); } }); buttons.append(copy);
  if (navigator.share) { const share = el("button", "btn btn-ghost", "Zdieľať"); share.type = "button"; share.addEventListener("click", () => { void navigator.share({ text }).catch(err => { if (err.name !== "AbortError") toast("Zdieľanie nie je dostupné."); }); }); buttons.append(share); }
  box.append(buttons); box.scrollIntoView({ block: "nearest" });
}
async function mutateUser(username, path, body) {
  if (adminBusy) return;
  const owner = user, version = userVersion; setAdminBusy(true);
  try {
    if (username === user && (path === "password" || path === "logout")) { resumePending = false; disconnect(); }
    const data = await api("/api/admin/users/" + encodeURIComponent(username) + "/" + path, { method: "POST", body: JSON.stringify(body) });
    if (owner !== user) return;
    if (["passkeys/delete", "password", "disable", "revoke", "delete"].includes(path)) { const ids = devicePasskeys(); delete ids[username]; saveDevicePasskeys(ids); }
    if (path === "password" && selectedUser === username && version === userVersion && $("userSheet").open) invitation("userInvitation", data);
    if (username === user && (path === "password" || path === "logout")) {
      // Our cookie is now invalid; retain a reset invitation only until this sheet closes.
      selfPasswordReset = path === "password" && $("userSheet").open;
      if (!selfPasswordReset) await signOut(false);
      return;
    }
    if (path === "delete" && selectedUser === username) $("userSheet").close();
    toast("Zmena uložená.");
    try { await refreshAdmin(); const session = await api("/api/session"); if (owner === user) showUsage(session.usage); } catch (err) { adminError(err); }
  } finally {
    setAdminBusy(false);
    if (selfPasswordReset) for (const node of document.querySelectorAll("#limitsForm input, #limitsForm button, #userActions button")) node.disabled = true;
  }
}
async function createUser(event) {
  event.preventDefault(); if (adminBusy) return;
  const owner = user, version = adminVersion;
  try {
    const body = { username: $("newUsername").value.trim(), role: newRole, limits: readLimits([["newMinutes", "sttSeconds", 60], ["newMonth", "sttSecondsMonth", 60]]) };
    if ($("newPassword").value) body.password = $("newPassword").value;
    if ($("newNote").value) body.note = $("newNote").value;
    setAdminBusy(true);
    const data = await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) }); $("newPassword").value = "";
    if (owner !== user) return;
    if ($("newUserSheet").open && version === adminVersion) { $("newUserForm").hidden = true; invitation("newInvitation", data); }
    await refreshAdmin();
  } catch (err) { adminError(err); } finally { setAdminBusy(false); }
}


/* ---------- passkeys ---------- */
let passkeyAvailable = false, passkeyAbort = null, passkeyBusy = false, passwordBusy = false;
const fromBase64url = value => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
const toBase64url = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const passkeyError = err => err.name === "Error" ? err.message : "Operácia sa nepodarila. Skús znova alebo použi meno a heslo.";
function devicePasskeys() {
  try { const ids = JSON.parse(store.get("passkeyIds", "{}")); return Object.assign(Object.create(null), Object.fromEntries(Object.entries(ids).filter(([, list]) => Array.isArray(list) && list.every(id => typeof id === "string")))); } catch { return Object.create(null); }
}
function saveDevicePasskeys(ids) {
  store.set("passkeyIds", JSON.stringify(ids));
  store.set("passkey", Object.values(ids).some(list => Array.isArray(list) && list.length) ? "1" : "0");
  renderPasskeyState();
}
function renderPasskeyState() {
  $("passkeyBtn").hidden = !passkeyAvailable;
  $("passkeyState").textContent = (devicePasskeys()[user] || []).length ? "Zapnuté na tomto zariadení" : "Vypnuté";
  $("passkeyLoginBtn").hidden = !passkeyAvailable || store.get("passkey", "0") !== "1";
}
function abortPasskeyLogin() { passkeyAbort?.abort(); passkeyAbort = null; }
async function initPasskeys() {
  try { passkeyAvailable = Boolean(window.PublicKeyCredential) && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { passkeyAvailable = false; }
  renderPasskeyState();
  if (passkeyAvailable && !user) void conditionalPasskeyLogin();
}
async function conditionalPasskeyLogin() {
  try {
    if (user || passwordBusy || !passkeyAvailable || store.get("passkey", "0") !== "1" || !await PublicKeyCredential.isConditionalMediationAvailable?.()) return;
    if (!user && !passwordBusy && !passkeyAbort) void passkeyLogin(true);
  } catch { /* Password login stays available. */ }
}
async function passkeyLogin(conditional = false) {
  abortPasskeyLogin();
  const controller = new AbortController(); passkeyAbort = controller;
  $("passkeyLoginBtn").disabled = !conditional;
  if (!conditional) $("loginStatus").textContent = "";
  try {
    const options = await api("/api/passkeys/login/options", { method: "POST", body: "{}", signal: controller.signal });
    if (controller.signal.aborted || user) return;
    options.challenge = fromBase64url(options.challenge);
    const credential = await navigator.credentials.get({ publicKey: options, signal: controller.signal, ...(conditional ? { mediation: "conditional" } : {}) });
    if (!credential || controller.signal.aborted || user) return;
    const response = credential.response;
    const data = await api("/api/passkeys/login", { method: "POST", signal: controller.signal, body: JSON.stringify({ id: credential.id, rawId: toBase64url(credential.rawId), type: credential.type,
      response: { clientDataJSON: toBase64url(response.clientDataJSON), authenticatorData: toBase64url(response.authenticatorData), signature: toBase64url(response.signature), userHandle: response.userHandle ? toBase64url(response.userHandle) : null } }) });
    if (!controller.signal.aborted && !user) await showApp(data);
  } catch (err) {
    if (err.code === "unknown_credential") { saveDevicePasskeys({}); }
    if (!controller.signal.aborted && (!conditional || err.code)) $("loginStatus").textContent = "Prihlásenie sa nepodarilo. Skús znova alebo použi meno a heslo.";
  } finally {
    if (passkeyAbort === controller) { passkeyAbort = null; $("passkeyLoginBtn").disabled = false; }
  }
}
async function loadPasskeys() {
  const owner = user, data = await api("/api/passkeys");
  if (owner !== user || !$("passkeySheet").open) return;
  const ids = devicePasskeys();
  if (Array.isArray(ids[owner])) { ids[owner] = ids[owner].filter(id => data.passkeys.some(p => p.id === id)); saveDevicePasskeys(ids); }
  $("passkeyList").replaceChildren();
  for (const key of data.passkeys) {
    const row = detailRow(key.label || "Zariadenie", "Pridané " + new Date(key.created_at).toLocaleDateString("sk") + " · použité " + relative(key.last_used_at));
    const remove = el("button", "btn btn-ghost", "Odstrániť"); remove.type = "button"; remove.disabled = passkeyBusy;
    remove.addEventListener("click", async () => {
      if (passkeyBusy || owner !== user) return;
      remove.disabled = true;
      try {
        await api("/api/passkeys/" + encodeURIComponent(key.id) + "/delete", { method: "POST", body: "{}" });
        const current = devicePasskeys();
        if (Array.isArray(current[owner])) current[owner] = current[owner].filter(id => id !== key.id);
        saveDevicePasskeys(current); if (user === owner) await loadPasskeys();
      } catch (err) { if (owner === user) $("passkeyStatus").textContent = passkeyError(err); }
      finally { remove.disabled = false; }
    });
    row.append(remove); $("passkeyList").append(row);
  }
  if (!data.passkeys.length) $("passkeyList").append(el("p", "hint", "Žiadne prístupové kľúče."));
}
async function createPasskey() {
  if (passkeyBusy) return;
  const owner = user; passkeyBusy = true; $("passkeyCreateBtn").disabled = true; $("passkeyStatus").textContent = "";
  try {
    const options = await api("/api/passkeys/register/options", { method: "POST", body: "{}" });
    if (owner !== user) return;
    options.challenge = fromBase64url(options.challenge); options.user.id = fromBase64url(options.user.id);
    options.excludeCredentials = options.excludeCredentials.map(c => ({ ...c, id: fromBase64url(c.id) }));
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential || owner !== user) return;
    const response = credential.response;
    if (!response.getPublicKey || !response.getPublicKeyAlgorithm || !response.getAuthenticatorData || !response.getPublicKey()) throw new Error("Prehliadač neposkytuje verejný kľúč. Aktualizuj ho alebo použi meno a heslo.");
    const label = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone / iPad" : /Android/.test(navigator.userAgent) ? "Android" : "Toto zariadenie";
    await api("/api/passkeys/register", { method: "POST", body: JSON.stringify({ id: credential.id, rawId: toBase64url(credential.rawId), type: credential.type, label,
      response: { clientDataJSON: toBase64url(response.clientDataJSON), attestationObject: toBase64url(response.attestationObject), publicKey: toBase64url(response.getPublicKey()), publicKeyAlgorithm: response.getPublicKeyAlgorithm(), authenticatorData: toBase64url(response.getAuthenticatorData()), transports: response.getTransports?.() || [] } }) });
    const ids = devicePasskeys(); ids[owner] = [...new Set([...(ids[owner] || []), credential.id])]; saveDevicePasskeys(ids);
    if (owner === user) { $("passkeyStatus").textContent = "Zapnuté na tomto zariadení."; await loadPasskeys(); }
  } catch (err) {
    if (owner === user) $("passkeyStatus").textContent = err.name === "NotAllowedError" || err.name === "AbortError" ? "Pridanie sa nedokončilo. Skús znova." : passkeyError(err);
  } finally { passkeyBusy = false; $("passkeyCreateBtn").disabled = false; }
}

/* ---------- session ---------- */
async function showApp(session) {
  abortPasskeyLogin(); $("passkeyLoginBtn").disabled = false;
  user = session.username; $("loginShell").hidden = true; $("appShell").hidden = false; $("accessCode").value = "";
  adminRole = session.role === "admin"; $("adminBtn").hidden = !adminRole;
  renderPasskeyState();
  const owner = user;
  const [languageData, voiceData] = await Promise.all([api("/api/languages"), api("/api/voices")]);
  if (user !== owner) return;
  languages = languageData.languages.sort((a, b) => a.name.localeCompare(b.name, "sk")); voices = voiceData.voices; ttsModel = voiceData.model;
  chosenA = store.get("langA", "sk"); chosenB = store.get("langB", "de");
  if (!languages.some(l => l.code === chosenA)) chosenA = "sk";
  if (chosenB !== "auto" && !languages.some(l => l.code === chosenB)) chosenB = "de";
  voiceA = store.get("voiceA", "Adrian"); voiceB = store.get("voiceB", "Adrian"); ensureVoices();
  prefs.conversationMode = store.get("conversationMode", "auto") === "ptt" ? "ptt" : "auto";
  mode = store.get("mode", "conversation") === "listen" ? "listen" : "conversation";
  listenSource = store.get("listen_source", "auto");
  if (listenSource === chosenA || listenSource !== "auto" && !languages.some(l => l.code === listenSource)) listenSource = "auto";
  listenSubtitles = store.get("listenSubtitles", "true") !== "false"; listenVoice = store.get("listenVoice", "true") !== "false";
  if (!listenSubtitles && !listenVoice) listenSubtitles = true;
  // Headphones keep the microphone open during playback, so the safe speaker mode is restored on every start.
  prefs.outputMode = store.get("outputMode", store.get("ttsEnabled", "true") === "false" ? "text" : "speaker") === "text" ? "text" : "speaker";
  prefs.ttsSpeed = ["0.9", "1", "1.15"].includes(store.get("ttsSpeed", "1")) ? store.get("ttsSpeed", "1") : "1";
  prefs.profileId = store.get("profileId", "conversation");
  if (![...$("profileId").options].some(o => o.value === prefs.profileId)) prefs.profileId = "conversation";
  voiceInfo(voiceData);
  $("catalogNote").textContent = languageData.stale || voiceData.stale ? "Katalóg sa teraz nedá obnoviť, používa sa posledný dostupný." : languages.length + " jazykov · " + voices.length + " hlasov · " + ttsModel;
  showUsage(session.usage); renderAll(); controls();
}
function showUsage(usage) {
  if (!usage) return;
  const limits = usage.limits || {};
  $("usageInfo").replaceChildren(el("p", "hint account-name", "Prihlásený ako " + user), usageBar("Rozpoznávanie · min", (usage.sttSeconds || 0) / 60, limits.sttSeconds == null ? undefined : limits.sttSeconds / 60), usageBar("Hlasové znaky", usage.ttsChars || 0, limits.ttsChars), usageBar("Rozhovory", usage.sessions || 0, limits.sessions), el("p", "hint", "Denný reset: polnoc UTC."));
}
async function signOut(callServer = true) {
  epoch++; resumePending = false; stopLocal(); disconnect(); clearEntries(); closeSheets();
  if (callServer) { try { await api("/api/logout", { method: "POST", body: "{}" }); } catch { $("loginStatus").textContent = "Odhlásenie na serveri sa nepotvrdilo. Po obnovení internetu sa prihlás a odhlás znova."; } }
  $("historyList").replaceChildren(); $("usageInfo").replaceChildren();
  adminVersion++; userVersion++; adminRole = false; adminUsers = []; selectedUser = ""; $("adminBtn").hidden = true;
  for (const id of ["adminUsers", "adminUsage", "adminAudit", "sonioxUsage", "userDevices", "userChart", "userUsage", "userActions", "userBadges", "userNote", "userTitle"]) $(id).replaceChildren();
  user = null; $("loginShell").hidden = false; $("appShell").hidden = true; $("accessCode").value = "";
  $("passkeyList").replaceChildren(); $("passkeyStatus").textContent = ""; renderPasskeyState(); void conditionalPasskeyLogin();
}

/* ---------- audio playback ---------- */
function ensurePlaybackContext() {
  if (!playbackContext || playbackContext.state === "closed") playbackContext = new AudioContext();
  return playbackContext;
}
async function unlockAudio(timeout = 0) {
  const resume = ensurePlaybackContext().resume();
  // Without a user gesture some browsers never settle resume(); reconnects must not hang on it.
  if (timeout) await Promise.race([resume, new Promise(r => setTimeout(r, timeout))]); else await resume;
}
function cacheKey(item, voice) { return [item.id, item.target_language, item.translated_text.trim(), voice, ttsModel].join("|"); }
function concat(chunks) { const out = new Uint8Array(chunks.reduce((n, b) => n + b.byteLength, 0)); let i = 0; for (const b of chunks) { out.set(new Uint8Array(b), i); i += b.byteLength; } return out.buffer; }
function rememberAudio(meta, chunks) {
  const item = entries.find(i => i.id === conversationId + "/" + meta.utterance_id);
  if (!item || !item.is_final || item.translated_text.trim() !== meta.text?.trim()) return;
  const buffer = concat(chunks), key = cacheKey(item, meta.voice);
  if (buffer.byteLength > MAX_CACHE) return;
  if (audioCache.has(key)) audioCacheBytes -= audioCache.get(key).byteLength;
  audioCache.set(key, buffer); audioCacheBytes += buffer.byteLength;
  while (audioCacheBytes > MAX_CACHE) { const oldest = audioCache.keys().next().value; audioCacheBytes -= audioCache.get(oldest).byteLength; audioCache.delete(oldest); }
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
  if (context.state !== "running") { error("Zvuk je pozastavený. Ťukni na mikrofón a pokračuj."); stopSound(); return; }
  const pcm = new Int16Array(buffer), audio = context.createBuffer(1, pcm.length, 24000);
  const channel = audio.getChannelData(0); for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
  const source = context.createBufferSource(); source.buffer = audio; source.connect(context.destination);
  const at = Math.max(context.currentTime + 0.025, op.nextTime || 0); op.nextTime = at + audio.duration;
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
  const op = { id, sources: new Set(), nextTime: 0, bytes: 0, resolve }; localPlayback = op; muted = mode !== "listen" && outputMode() === "speaker" && running; controls();
  schedule(buffer, op, () => {
    if (op.sources.size || localPlayback !== op) return;
    localPlayback = null; send({ type: "local_playback_end", playback_id: id }); muted = false; controls(); resolve?.();
  });
}
async function replay(item) {
  if (playback || localPlayback || previewAbort) { toast("Najprv zastav aktuálny hlas."); return; }
  await unlockAudio();
  const voice = item.target_language === chosenA ? voiceA : voiceB;
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
    if (running) { toast("Uložený rozhovor prehráš po zastavení počúvania."); return; }
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
  if (running || previewAbort || localPlayback) { toast(running ? "Ukážku si vypočuješ po zastavení rozhovoru." : "Najprv zastav aktuálny hlas."); return; }
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

/* ---------- conversation rendering ---------- */
function isMine(item) { return item.source_language === chosenA; }
function createTurn(item) {
  const article = el("article", "turn");
  const src = el("p", "turn-src"); src.dir = "auto";
  const tr = el("p", "turn-tr"); tr.dir = "auto";
  const meta = el("div", "turn-meta");
  const dir = el("span", "dir"), audio = el("span", "audio");
  const button = el("button", "icon-btn"); button.type = "button"; button.setAttribute("aria-label", "Prehrať preklad znova"); button.append(icon("i-play"));
  button.addEventListener("click", () => { const latest = entries.find(i => i.id === item.id); if (latest) replay(latest).catch(e => error(e.message)); });
  meta.append(dir, audio, button); article.append(src, tr, meta);
  return { article, src, tr, dir, audio, button };
}
function renderItem(item) {
  let node = nodes.get(item.id);
  if (!node) { node = createTurn(item); nodes.set(item.id, node); $("feed").append(node.article); }
  node.article.classList.toggle("me", isMine(item)); node.article.classList.toggle("other", !isMine(item));
  node.article.classList.toggle("live", !item.is_final);
  node.src.textContent = item.source_text; node.src.lang = item.source_language || "und";
  node.tr.textContent = item.translated_text; node.tr.lang = item.target_language || "und";
  node.dir.textContent = shortCode(item.source_language || "?") + " → " + shortCode(item.target_language || "?");
  node.audio.textContent = mode === "listen" && !item.is_final ? "Priebežný preklad" : item.is_final ? AUDIO_LABELS[item.audio_status] || "" : "";
  node.button.hidden = !item.is_final || !item.translated_text.trim() || !ttsEnabled();
  node.button.disabled = !navigator.onLine;
}
function renderFace() {
  const last = entries.at(-1);
  $("faceMyLabel").textContent = capitalize(name(chosenA)); $("faceOtherLabel").textContent = capitalize(name(chosenB));
  $("faceMy").textContent = last ? (isMine(last) ? last.source_text : last.translated_text) : "";
  $("faceOther").textContent = last ? (isMine(last) ? last.translated_text : last.source_text) : "";
  $("faceMy").lang = chosenA; $("faceOther").lang = chosenB === "auto" ? "und" : chosenB;
}
function render(changed) {
  const feed = $("feed"), pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  $("emptyState").hidden = entries.length > 0;
  for (const item of changed) renderItem(item);
  const latest = entries.findLast(i => i.translated_text?.trim()) || entries.at(-1);
  for (const [id, node] of nodes) node.article.classList.toggle("latest", id === latest?.id);
  renderFace();
  if (pinned) feed.scrollTop = feed.scrollHeight;
}
function renderAll() {
  for (const node of nodes.values()) node.article.remove();
  nodes.clear(); render(entries);
}

/* ---------- server messages ---------- */
function receive(msg) {
  if (msg.type === "session_open") { cancelRequest = ""; conversationId = msg.conversation_id; return; }
  if (msg.conversation_id !== conversationId) return;
  if (msg.type === "server_ready") {
    ready = true; clearTimeout(connectTimer); clearTimeout(stableTimer);
    // A connection that drops again right after opening must not refill the retry budget.
    stableTimer = setTimeout(() => { reconnectAttempts = 0; }, STABLE_MS);
    const frames = pending; pending = []; pendingBytes = 0;
    for (const frame of frames) sendPcm(frame);
    controls();
  }
  if (msg.type === "state") {
    ready = Boolean(msg.accept_audio); muted = Boolean(msg.microphone_muted);
    stopping = msg.state === "finishing"; serverState = msg.state;
    if (stopping) void stopCapture(false);
    controls();
  }
  if (msg.type === "token") {
    if (msg.reset) { entries = entries.filter(e => e.conversation !== conversationId); renderAll(); }
    const changed = [];
    for (const item of msg.conversation_items || []) {
      const id = conversationId + "/" + item.id, existing = entries.find(e => e.id === id);
      const value = { ...item, id, server_id: item.id, conversation: conversationId };
      if (existing) { Object.assign(existing, value); changed.push(existing); } else { entries.push(value); changed.push(value); }
    }
    if (changed.length) { dirty = true; render(changed); controls(); }
  }
  if (msg.type === "language_candidate") {
    ready = false;
    const select = $("detectedLanguage"); select.replaceChildren();
    for (const l of languages) { const o = el("option", "", capitalize(l.name)); o.value = l.code; select.append(o); }
    select.value = msg.language; $("confirmLanguage").hidden = false; haptic(); controls();
  }
  if (msg.type === "language_confirmed") {
    chosenB = msg.language; $("confirmLanguage").hidden = true;
    saveSettings(); renderAll(); controls();
  }
  if (msg.type === "tts_stream_start") startStream(msg);
  if (msg.type === "tts_stream_end" && playback?.meta.playback_id === msg.playback_id) {
    if (msg.cancelled) { stopSources(playback); playback = null; }
    else { playback.meta.text = msg.text || playback.meta.text; playback.ended = true; playback.interrupted = msg.interrupted; completeStream(); }
    controls();
  }
  if (msg.type === "local_playback_ready" && localPlayback?.id === msg.playback_id && localPlayback.waiting) {
    const op = localPlayback; clearTimeout(op.timer); localPlayback = null; localAudio(op.buffer, op.id);
  }
  if (msg.type === "audio_cancelled") { if (cancelRequest && msg.request_id !== cancelRequest) return; cancelRequest = ""; stopSources(playback); playback = null; stopLocal(); muted = false; controls(); }
  if (msg.type === "error") {
    if (msg.fatal && RECONNECTABLE.has(msg.code)) { connectionLost(); return; }
    error(msg.message);
    if (msg.fatal) { disconnect(); if (msg.code === "auth_expired") void signOut(false); }
  }
  if (msg.type === "session_finished") {
    const renew = mode === "listen" && msg.reason === "limit" && running && !userStopped && navigator.onLine && document.visibilityState === "visible";
    disconnect();
    if (renew) void start(true);
    void api("/api/usage").then(showUsage).catch(() => {});
  }
}

/* ---------- microphone ---------- */
function sendPcm(buffer, flush = false) {
  if (!running || muted || (stopping && !flush)) return;
  if (microphoneMode() === "ptt" && !pttPressed && !pttDraining) return;
  // People start talking right after the tap; speech captured while the connection opens is sent once it is ready.
  if (!ready || socket?.readyState !== WebSocket.OPEN) {
    if (!stopping && pendingBytes + buffer.byteLength <= START_BUFFER_BYTES) { pending.push(buffer); pendingBytes += buffer.byteLength; }
    return;
  }
  // With headphones, loud new speech interrupts the translation that is playing.
  if (mode !== "listen" && prefs.conversationMode === "auto" && outputMode() === "headphones" && playback?.started && Date.now() - playback.createdAt > 300) {
    const pcm = new Int16Array(buffer); let energy = 0;
    for (let i = 0; i < pcm.length; i += 4) energy += pcm[i] * pcm[i];
    const rms = Math.sqrt(energy / Math.max(1, Math.ceil(pcm.length / 4)));
    vadHits = rms > 1200 ? vadHits + 1 : 0;
    if (vadHits >= 4) { vadHits = 0; stopSound(); }
  } else vadHits = 0;
  if (socket.bufferedAmount + buffer.byteLength > 128 * 1024) { connectionLost(); return; }
  socket.send(buffer);
}
async function startCapture(currentEpoch) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (epoch !== currentEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
  media = stream;
  // The device rate is kept; the worklet resamples to 16 kHz, so no browser has to convert between contexts.
  captureContext = new AudioContext();
  await captureContext.resume();
  if (epoch !== currentEpoch) return;
  if (!captureContext.audioWorklet) throw Object.assign(new Error("AudioWorklet unavailable"), { name: "NotSupportedError" });
  const source = captureContext.createMediaStreamSource(stream);
  const gain = captureContext.createGain(); gain.gain.value = 0; gain.connect(captureContext.destination);
  await captureContext.audioWorklet.addModule("/audio-capture-worklet.js?v=3.5.0");
  if (epoch !== currentEpoch) return;
  worklet = new AudioWorkletNode(captureContext, "pcm-capture-processor", { processorOptions: { targetSampleRate: 16000, chunkSize: 1024 } });
  worklet.port.onmessage = event => {
    if (event.data.type === "audio") { lastFrameAt = Date.now(); sendPcm(event.data.buffer, event.data.flush); }
    if (event.data.type === "flushed") flushResolve?.();
  };
  // A phone call, a disconnected Bluetooth headset or another app taking the microphone would
  // otherwise leave the UI saying "listening" while no audio arrives.
  worklet.onprocessorerror = () => captureLost(currentEpoch);
  let muteTimer;
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => captureLost(currentEpoch));
    track.addEventListener("mute", () => { clearTimeout(muteTimer); muteTimer = setTimeout(() => captureLost(currentEpoch), 3000); });
    track.addEventListener("unmute", () => clearTimeout(muteTimer));
  }
  const context = captureContext;
  context.addEventListener("statechange", () => { if (captureContext === context && context.state !== "running" && context.state !== "closed") void context.resume().catch(() => {}); });
  lastFrameAt = Date.now();
  source.connect(worklet); worklet.connect(gain);
}
function captureLost(token) {
  if (epoch !== token || !running || stopping) return;
  send({ type: "client_stop" }); disconnect(); resumePending = true;
  error("Mikrofón sa prerušil (hovor, slúchadlá alebo iná appka). Ťukni na Pokračovať.");
  controls();
}
function flushWorklet() {
  if (!worklet) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { if (flushResolve === done) flushResolve = null; resolve(); };
    flushResolve = done; worklet.port.postMessage({ type: "flush" });
    setTimeout(done, 300);
  });
}
async function stopCapture(flush) {
  if (flush) await flushWorklet();
  if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); worklet = null; }
  media?.getTracks().forEach(t => t.stop()); media = null;
  const context = captureContext; captureContext = null; if (context && context.state !== "closed") await context.close();
}
async function lockScreen() {
  if (!navigator.wakeLock || document.visibilityState !== "visible") return;
  try { const lock = await navigator.wakeLock.request("screen"); wakeLock = lock; lock.addEventListener("release", () => { if (wakeLock === lock) wakeLock = null; }); } catch {}
}

/* ---------- conversation lifecycle ---------- */
async function start(automatic = false) {
  if (running || !user || !navigator.onLine) return;
  if (mode === "listen" ? chosenA === listenSource : chosenA === chosenB) { error("Vyber dva rôzne jazyky."); return; }
  if (mode !== "listen" && entries.length >= 1000) { error("Ulož rozhovor a začni nový."); return; }
  if (!automatic) { error(""); haptic(); reconnectAttempts = 0; }
  saveSettings(); stopLocal();
  clearTimeout(reconnectTimer); reconnectTimer = null; resumePending = false;
  running = true; stopping = false; ready = false; muted = false; serverState = "idle";
  userStopped = false;
  const token = ++epoch; controls();
  try {
    await unlockAudio(automatic ? 400 : 0); if (epoch !== token) return;
    await startCapture(token); if (epoch !== token || !running) return;
    captureWatch = setInterval(() => { if (Date.now() - lastFrameAt > 4000) captureLost(token); }, 2000);
    await lockScreen(); if (epoch !== token) return;
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host); socket = ws; ws.binaryType = "arraybuffer";
    connectTimer = setTimeout(() => { if (socket === ws && !ready) connectionLost(); }, 12000);
    ws.onopen = () => {
      if (socket !== ws) { ws.close(); return; }
      send({ type: "config", mode, ...(mode === "listen" ? { listen_source: listenSource } : {}), language_a: chosenA, language_b: chosenB, voice_a: voiceA, voice_b: voiceB, output_mode: outputMode(), tts_enabled: ttsEnabled(), tts_speed: prefs.ttsSpeed, profile_id: prefs.profileId, conversation_mode: microphoneMode() });
    };
    ws.onmessage = event => {
      if (socket !== ws) return;
      try { typeof event.data === "string" ? receive(JSON.parse(event.data)) : streamAudio(event.data); }
      catch { error("Neplatná odpoveď servera."); disconnect(); }
    };
    ws.onclose = event => { if (socket === ws) { if (event.code === 1000) disconnect(); else connectionLost(); } };
  } catch (err) {
    if (epoch !== token) return;
    disconnect();
    error(err.name === "NotAllowedError" ? "Povoľ mikrofón v nastaveniach prehliadača pre túto stránku." : err.name === "NotSupportedError" ? "Tento prehliadač nepodporuje nahrávanie zvuku. Použi aktuálny Chrome alebo Safari." : "Mikrofón alebo zvuk nie je dostupný.");
  }
}
// Unexpected drop: keep the transcript and retry a few times while the page is visible and online.
function connectionLost() {
  const wasRunning = running && !stopping;
  disconnect();
  if (!wasRunning || !user) return;
  if (!navigator.onLine || document.visibilityState !== "visible" || reconnectAttempts >= 3) {
    resumePending = true; error(navigator.onLine ? "Spojenie sa prerušilo. Prepis zostal zachovaný." : ""); controls(); return;
  }
  const delay = 1500 * 2 ** reconnectAttempts++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void start(true).catch(e => error(e.message)); }, delay);
  controls();
}
async function pause() {
  userStopped = true;
  if (stopping) return;
  haptic();
  if (!socket || socket.readyState !== WebSocket.OPEN) { disconnect(); return; }
  stopping = true; controls(); await stopCapture(true);
  send({ type: "client_stop" });
  finishTimer = setTimeout(() => { error("Dokončenie trvalo príliš dlho."); disconnect(); }, 125000);
}
// Synchronous on purpose: a hidden page may be frozen before any await resumes, so the stop
// request and the short deadline are issued first. The server still finalizes the last sentence.
function backgroundStop() {
  userStopped = true;
  resumePending = true;
  if (!socket || socket.readyState !== WebSocket.OPEN) { disconnect(); controls(); return; }
  if (!stopping) { stopping = true; send({ type: "client_stop" }); void stopCapture(false); }
  clearTimeout(finishTimer);
  finishTimer = setTimeout(() => { disconnect(); controls(); }, 1500);
  controls();
}
function disconnect() {
  epoch++; cancelRequest = ""; clearTimeout(connectTimer); clearTimeout(finishTimer); clearTimeout(reconnectTimer); clearTimeout(stableTimer); clearInterval(captureWatch); reconnectTimer = null; pending = []; pendingBytes = 0; pttDraining = false;
  const ws = socket; socket = null;
  if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close(); } catch {} }
  const changed = [];
  for (const item of entries) if (["queued", "pending"].includes(item.audio_status)) { item.audio_status = "not_spoken"; changed.push(item); }
  running = false; stopping = false; ready = false; muted = false; serverState = "idle"; pttPressed = false; pttSide = ""; pttEnding = false; vadHits = 0;
  for (const side of ["A", "B"]) $("ptt" + side).classList.remove("pressed");
  render(changed); void stopCapture(false); stopSources(playback); playback = null; stopLocal();
  if (wakeLock) { void wakeLock.release(); wakeLock = null; }
  $("confirmLanguage").hidden = true; controls();
}
function clearEntries() {
  entries = []; audioCache.clear(); audioCacheBytes = 0; dirty = false; resumePending = false;
  renderAll(); controls();
}
function asText(items = entries) { return items.map(i => name(i.source_language) + " → " + name(i.target_language) + (i.is_final ? "" : " [neúplné]") + "\n" + i.source_text + "\n" + i.translated_text).join("\n\n"); }

/* ---------- history ---------- */
async function showHistory() {
  const owner = user; if (!owner) return;
  const rows = await LocalHistory.list(owner);
  if (owner !== user) return;
  const list = $("historyList"); list.replaceChildren();
  if (!rows.length) list.append(el("p", "empty-list", "Zatiaľ nemáš uložený rozhovor."));
  for (const row of rows) {
    const item = el("div", "history-row");
    const main = el("span", "option-main"); main.tabIndex = 0; main.setAttribute("role", "button");
    main.append(el("span", "option-title", capitalize(name(row.languages.a)) + " ↔ " + capitalize(name(row.languages.b))));
    main.append(el("span", "option-sub", new Date(row.created_at).toLocaleString("sk", { dateStyle: "medium", timeStyle: "short" }) + " · " + row.items.length + " viet"));
    const open = () => {
      if (dirty && !confirm("Zahodiť neuložený aktuálny rozhovor?")) return;
      disconnect(); entries = row.items; chosenA = row.languages.a; chosenB = row.languages.b; dirty = false; resumePending = false;
      closeSheets(); renderAll(); controls();
    };
    main.addEventListener("click", open);
    main.addEventListener("keydown", event => { if (event.key === "Enter") open(); });
    const exportBtn = el("button", "icon-btn"); exportBtn.type = "button"; exportBtn.setAttribute("aria-label", "Exportovať ako text"); exportBtn.append(icon("i-download"));
    exportBtn.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([asText(row.items)], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = "rozhovor-" + row.created_at.slice(0, 10) + ".txt"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const deleteBtn = el("button", "icon-btn"); deleteBtn.type = "button"; deleteBtn.setAttribute("aria-label", "Vymazať rozhovor"); deleteBtn.append(icon("i-trash"));
    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Vymazať tento uložený rozhovor?")) return;
      try { await LocalHistory.remove(owner, row.id); await showHistory(); } catch (e) { error(e.message); }
    });
    item.append(main, exportBtn, deleteBtn); list.append(item);
  }
  $("moreSheet").close(); openSheet("historySheet");
}

/* ---------- settings ---------- */
$("sessionMode").addEventListener("click", event => {
  const button = event.target.closest("button[data-mode]");
  if (!button || button.disabled || running || stopping || reconnectTimer || mode === button.dataset.mode) return;
  mode = button.dataset.mode;
  if (listenSource === chosenA) listenSource = "auto";
  saveSettings(); renderAll(); controls();
});
for (const id of ["listenSubtitles", "listenVoice"]) $(id).addEventListener("change", () => {
  const subtitlesWereHidden = !listenSubtitles;
  listenSubtitles = $("listenSubtitles").checked; listenVoice = $("listenVoice").checked;
  if (!listenSubtitles && !listenVoice) {
    if (id === "listenSubtitles") listenVoice = true; else listenSubtitles = true;
    toast(id === "listenSubtitles" ? "Hlas zostáva zapnutý." : "Titulky zostávajú zapnuté.");
  }
  saveSettings(); controls(); render(entries);
  // A feed that was hidden starts at the top; jump to the latest translation when subtitles come back.
  if (subtitlesWereHidden && listenSubtitles) $("feed").scrollTop = $("feed").scrollHeight;
  send({ type: "update_settings", tts_enabled: listenVoice });
  if (!listenVoice) stopSound();
});
function settingsChanged() {
  saveSettings(); controls(); renderAll();
  send({ type: "update_settings", voice_a: voiceA, voice_b: voiceB, output_mode: outputMode(), tts_enabled: ttsEnabled(), tts_speed: prefs.ttsSpeed });
  if (!ttsEnabled()) stopSound();
}
for (const group of document.querySelectorAll(".segmented[data-setting]")) {
  group.addEventListener("click", event => {
    const button = event.target.closest("button[data-value]"); if (!button || button.disabled) return;
    const key = group.dataset.setting;
    if (prefs[key] === button.dataset.value) return;
    prefs[key] = button.dataset.value;
    if (key === "outputMode" && prefs.outputMode === "headphones") toast("Slúchadlá vyber iba vtedy, keď cez ne naozaj počúvaš.");
    settingsChanged();
  });
}

/* ---------- push to talk ---------- */
function beginPtt(side) {
  if (!running || !ready || stopping || pttPressed || pttEnding || microphoneMode() !== "ptt") return;
  if (playback || localPlayback) stopSound();
  pttPressed = true; pttSide = side; haptic();
  $("ptt" + side).classList.add("pressed");
  send({ type: "ptt_start" }); controls();
}
async function finishPtt(side) {
  if (!pttPressed || pttSide !== side) return;
  pttPressed = false; pttSide = ""; pttEnding = true; pttDraining = true;
  $("ptt" + side).classList.remove("pressed"); controls();
  const ws = socket;
  // The worklet still holds up to 64 ms of the last word; it must go out before the silence.
  await flushWorklet();
  pttDraining = false;
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
  button.addEventListener("contextmenu", event => event.preventDefault());
  button.addEventListener("keydown", event => { if (!event.repeat && [" ", "Enter"].includes(event.key)) { event.preventDefault(); beginPtt(side); } });
  button.addEventListener("keyup", event => { if ([" ", "Enter"].includes(event.key)) { event.preventDefault(); void finishPtt(side); } });
}

/* ---------- wiring ---------- */
$("loginForm").addEventListener("submit", async event => {
  event.preventDefault(); $("loginStatus").textContent = "";
  abortPasskeyLogin(); passwordBusy = true; $("passkeyLoginBtn").disabled = true;
  const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
  const username = $("username").value.trim(), password = $("accessCode").value;
  try { await showApp(await api("/api/login", { method: "POST", body: JSON.stringify(username ? { username, password } : { code: password.trim() }) })); }
  catch (err) { $("loginStatus").textContent = err.message; }
  finally { button.disabled = false; passwordBusy = false; $("passkeyLoginBtn").disabled = false; }
});
$("passkeyLoginBtn").addEventListener("click", () => { if (!passwordBusy) void passkeyLogin(); });
$("passkeyBtn").addEventListener("click", () => {
  $("settingsSheet").close(); $("passkeyStatus").textContent = ""; openSheet("passkeySheet");
  void loadPasskeys().catch(err => { $("passkeyStatus").textContent = passkeyError(err); });
});
$("passkeyCreateBtn").addEventListener("click", () => void createPasskey());
$("startBtn").addEventListener("click", () => (running ? pause() : start()).catch(e => error(e.message)));
$("resumeBtn").addEventListener("click", () => start().catch(e => error(e.message)));
$("pttEndBtn").addEventListener("click", () => pause().catch(e => error(e.message)));
$("stopAudioBtn").addEventListener("click", stopSound);
$("faceBtn").addEventListener("click", () => { faceMode = !faceMode; renderFace(); controls(); });
$("errorClose").addEventListener("click", () => error(""));
$("langABtn").addEventListener("click", () => openLanguages("A"));
$("langBBtn").addEventListener("click", () => openLanguages("B"));
$("languageSearch").addEventListener("input", fillLanguageList);
$("swapBtn").addEventListener("click", () => { if (running || chosenB === "auto") return; [chosenA, chosenB] = [chosenB, chosenA]; [voiceA, voiceB] = [voiceB, voiceA]; saveSettings(); renderAll(); controls(); });
$("settingsBtn").addEventListener("click", () => { controls(); $("moreSheet").close(); openSheet("settingsSheet"); });
$("moreBtn").addEventListener("click", () => openSheet("moreSheet"));
$("voiceABtn").addEventListener("click", () => openVoices("A"));
$("voiceBBtn").addEventListener("click", () => openVoices("B"));
$("voiceSearch").addEventListener("input", fillVoiceList);
$("voiceGender").addEventListener("click", event => { const chip = event.target.closest("[data-value]"); if (!chip) return; voiceGender = chip.dataset.value; fillVoiceList(); });
$("profileId").addEventListener("change", event => { prefs.profileId = event.target.value; saveSettings(); });
$("logoutBtn").addEventListener("click", () => void signOut());
$("confirmLanguageBtn").addEventListener("click", () => send({ type: "confirm_language", language: $("detectedLanguage").value }));
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", event => { if (event.target === d) d.close(); });
  d.querySelector(".close-sheet")?.addEventListener("click", () => d.close());
  // A toast shown inside a sheet that closes right after (copy, save) must stay visible.
  d.addEventListener("close", () => { const t = $("toast"); if (d.contains(t)) (Array.from(document.querySelectorAll("dialog[open]")).at(-1) || document.body).append(t); });
}
$("adminBtn").addEventListener("click", () => {
  if (!adminRole) return;
  $("settingsSheet").close(); $("auditDetails").open = false; openSheet("adminSheet"); void refreshAdmin().catch(adminError);
});
$("newUserBtn").addEventListener("click", () => {
  if (adminBusy) return;
  $("newUserForm").reset(); $("newUserForm").hidden = false; newRole = "user";
  for (const b of $("newUserRole").children) b.setAttribute("aria-checked", String(b.dataset.value === newRole));
  openSheet("newUserSheet");
});
$("newUserRole").addEventListener("click", event => {
  const b = event.target.closest("[data-value]"); if (!b || adminBusy) return; newRole = b.dataset.value;
  for (const button of $("newUserRole").children) button.setAttribute("aria-checked", String(button === b));
});
$("newUserForm").addEventListener("submit", createUser);
$("limitsForm").addEventListener("submit", event => {
  event.preventDefault(); const row = adminUsers.find(u => u.username === selectedUser); if (!row) return;
  try { void mutateUser(row.username, "limits", { limits: readLimits(LIMIT_FIELDS, row.limits_override) }).catch(adminError); } catch (err) { adminError(err); }
});
for (const [sheet, card] of [["userSheet", "userInvitation"], ["newUserSheet", "newInvitation"]]) $(sheet).addEventListener("close", () => {
  $(card).replaceChildren(); $(card).hidden = true;
  if (sheet === "userSheet") { selectedUser = ""; userVersion++; if (selfPasswordReset) { selfPasswordReset = false; void signOut(false); } }
  else $("newUserForm").reset();
});
$("sonioxUsageBtn").addEventListener("click", async () => {
  const version = adminVersion, owner = user, button = $("sonioxUsageBtn"); button.disabled = true; $("sonioxUsage").textContent = "Načítavam…";
  try {
    const data = await api("/api/admin/soniox-usage", { signal: AbortSignal.timeout(60000) });
    if (owner !== user || version !== adminVersion || !$("adminSheet").open) return;
    $("sonioxUsage").replaceChildren(el("p", "hint", "Mesiac " + data.month + " · načítané " + new Date(data.fetched_at).toLocaleString("sk")), detailRow("Spolu", usd(data.total_usd)));
    for (const row of data.by_reference) $("sonioxUsage").append(detailRow(row.client_reference_id || "Bez priradenia", usd(row.cost_usd)));
  } catch (err) { if (owner === user && version === adminVersion) $("sonioxUsage").textContent = err.message; }
  finally { button.disabled = adminBusy; }
});
$("newBtn").addEventListener("click", () => { if (dirty && !confirm("Zahodiť neuložený rozhovor?")) return; disconnect(); clearEntries(); error(""); closeSheets(); });
$("copyBtn").addEventListener("click", () => {
  if (!entries.length) { toast("Rozhovor je prázdny."); return; }
  navigator.clipboard.writeText(asText()).then(() => { toast("Rozhovor skopírovaný."); closeSheets(); }).catch(() => error("Kopírovanie nie je dostupné."));
});
$("saveBtn").addEventListener("click", async () => {
  if (!entries.length) { toast("Rozhovor je prázdny."); return; }
  const snapshot = JSON.stringify(entries), owner = user;
  try { await LocalHistory.save(owner, entries, { a: chosenA, b: chosenB }); if (user === owner && snapshot === JSON.stringify(entries)) dirty = false; toast("Uložené v tomto zariadení."); closeSheets(); }
  catch (err) { error(err.message); }
});
$("historyBtn").addEventListener("click", () => showHistory().catch(e => error(e.message)));

function connectivity() {
  $("offlineBanner").hidden = navigator.onLine;
  if (!navigator.onLine && running) connectionLost();
  else if (navigator.onLine && resumePending && !running && document.visibilityState === "visible" && reconnectAttempts < 3) { reconnectAttempts++; void start(true).catch(() => {}); }
  controls();
}
window.addEventListener("online", connectivity); window.addEventListener("offline", connectivity);
document.addEventListener("visibilitychange", () => {
  // Mobile browsers suspend the microphone in the background: finish cleanly and offer one-tap resume.
  if (document.visibilityState === "hidden" && running) backgroundStop();
  else if (document.visibilityState === "visible" && running && !wakeLock) void lockScreen();
});
window.addEventListener("pagehide", () => { send({ type: "client_stop" }); disconnect(); });
window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
connectivity();
setInterval(async () => {
  const owner = user; if (!owner || !navigator.onLine || adminBusy || selfPasswordReset) return;
  try {
    const [languageData, voiceData] = await Promise.all([api("/api/languages"), api("/api/voices")]);
    if (owner !== user) return;
    languages = languageData.languages.sort((a, b) => a.name.localeCompare(b.name, "sk"));
    voices = voiceData.voices; ttsModel = voiceData.model; voiceInfo(voiceData);
    if (!running) ensureVoices();
    controls();
  } catch {}
}, 600000);
api("/api/session").then(showApp).catch(() => { $("loginShell").hidden = false; $("appShell").hidden = true; }).finally(() => { void initPasskeys(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
