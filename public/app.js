const FALLBACK_LANGUAGES = [
  { code: 'af', name: 'Afrikaans' },
  { code: 'ar', name: 'Arabic' },
  { code: 'bn', name: 'Bengali' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'en', name: 'English' },
  { code: 'et', name: 'Estonian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'no', name: 'Norwegian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'vi', name: 'Vietnamese' }
];

const FALLBACK_VOICES = [
  { id: 'Adrian', name: 'Adrian', gender: 'male' },
  { id: 'Maya', name: 'Maya', gender: 'female' }
];

let availableLanguages = FALLBACK_LANGUAGES;

const loginShell = document.getElementById('loginShell');
const loginForm = document.getElementById('loginForm');
const accessCodeInput = document.getElementById('accessCode');
const loginStatus = document.getElementById('loginStatus');
const appShell = document.getElementById('appShell');
const currentUserEl = document.getElementById('currentUser');
const usageInfoEl = document.getElementById('usageInfo');
const logoutBtn = document.getElementById('logoutBtn');

const langASelect = document.getElementById('langA');
const langBSelect = document.getElementById('langB');
const swapBtn = document.getElementById('swapBtn');
const startBtn = document.getElementById('startBtn');
const startBtnText = document.getElementById('startBtnText');
const voiceSelect = document.getElementById('voiceSelect');
const endpointDelaySelect = document.getElementById('endpointDelay');
const voiceOutputToggle = document.getElementById('voiceOutputToggle');
const outputModeSelect = document.getElementById('outputMode');
const connectionChip = document.getElementById('connectionChip');
const micChip = document.getElementById('micChip');
const playbackChip = document.getElementById('playbackChip');
const modeChip = document.getElementById('modeChip');
const latencyInfoEl = document.getElementById('latencyInfo');
const originalTextEl = document.getElementById('originalText');
const translatedTextEl = document.getElementById('translatedText');
const originalLangBadge = document.getElementById('originalLangBadge');
const translatedLangBadge = document.getElementById('translatedLangBadge');
const conversationFeedEl = document.getElementById('conversationFeed');
const conversationModeBadge = document.getElementById('conversationModeBadge');
const levelBar = document.getElementById('levelBar');
const statusEl = document.getElementById('status');
const copyOriginalBtn = document.getElementById('copyOriginalBtn');
const copyTranslatedBtn = document.getElementById('copyTranslatedBtn');
const copyConversationBtn = document.getElementById('copyConversationBtn');
const copyAllBtn = document.getElementById('copyAllBtn');
const clearBtn = document.getElementById('clearBtn');
const repeatLastBtn = document.getElementById('repeatLastBtn');
const stopAudioBtn = document.getElementById('stopAudioBtn');
const textOnlyBtn = document.getElementById('textOnlyBtn');

let ws = null;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let audioWorkletNode = null;
let silenceGainNode = null;
let captureMode = 'idle';
let stopCloseTimer = null;
let currentAudioEl = null;
let currentAudioUrl = null;
let lastAudioBuffer = null;
let lastAudioMeta = null;
let lastTtsGenerationMs = null;

let isRunning = false;
let isStopping = false;
let isMuted = false;
let serverReady = false;
let audioQueue = [];
let isPlaying = false;
let wakeLock = null;
let currentUser = null;
let conversationItems = [];

const PRE_READY_MAX_CHUNKS = 8;
const MAX_WS_BUFFERED_AMOUNT = 512 * 1024;
const HEADSET_DEVICE_HINTS = [
  'airpod',
  'bluetooth',
  'buds',
  'earbud',
  'earpiece',
  'hands-free',
  'handsfree',
  'headphone',
  'headset',
  'jabra',
  'sony',
  'bose',
  'beats',
  'soundcore'
];
let preReadyAudioQueue = [];
let preReadyAudioBytes = 0;
let serverReadyAt = 0;
let audioChunksCaptured = 0;
let audioChunksDropped = 0;
let detectedOutputMode = 'speaker';

function setStatus(text, variant = 'idle') {
  statusEl.textContent = text;
  statusEl.dataset.variant = variant;
}

function setChip(el, text, variant = 'idle') {
  if (!el) return;
  el.textContent = text;
  el.dataset.variant = variant;
}

function getOutputMode() {
  return outputModeSelect?.value || detectedOutputMode || 'speaker';
}

function updateModeChip() {
  const mode = getOutputMode();
  setChip(modeChip, mode === 'headphones' ? 'Headphones' : 'Speaker', mode === 'headphones' ? 'info' : 'idle');
}

function selectedLanguageName(select) {
  if (!select) return '';
  if (select.value === 'auto') return 'Auto';
  const match = availableLanguages.find((lang) => lang.code === select.value);
  return match?.name || select.selectedOptions?.[0]?.textContent || '';
}

function languageNameForCode(code) {
  const cleanCode = String(code || '').trim().toLowerCase();
  if (!cleanCode) return '';
  if (cleanCode === 'auto') return 'Auto';
  const match = availableLanguages.find((lang) => lang.code === cleanCode);
  return match?.name || cleanCode.toUpperCase();
}

function updateLanguageBadges() {
  if (originalLangBadge) originalLangBadge.textContent = selectedLanguageName(langASelect) || 'Original';
  if (translatedLangBadge) translatedLangBadge.textContent = selectedLanguageName(langBSelect) || 'Translation';
  if (conversationModeBadge) {
    const langAName = selectedLanguageName(langASelect) || 'Language A';
    const langBName = selectedLanguageName(langBSelect) || 'Language B';
    conversationModeBadge.textContent = langBSelect.value === 'auto'
      ? `Auto -> ${langAName}`
      : `${langAName} <-> ${langBName}`;
    const autoOption = Array.from(langBSelect.options || []).find((option) => option.value === 'auto');
    if (autoOption) autoOption.textContent = `Auto -> ${langAName}`;
  }
}

function deviceLabelLooksLikeHeadset(label) {
  const clean = String(label || '').toLowerCase();
  return Boolean(clean) && HEADSET_DEVICE_HINTS.some((hint) => clean.includes(hint));
}

async function detectOutputModeFromDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return 'speaker';

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasHeadset = devices
      .filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput')
      .some((device) => deviceLabelLooksLikeHeadset(device.label));
    return hasHeadset ? 'headphones' : 'speaker';
  } catch (err) {
    console.warn('Audio device detection failed, using speaker mode:', err);
    return 'speaker';
  }
}

async function applyAutomaticOutputMode() {
  detectedOutputMode = await detectOutputModeFromDevices();
  if (outputModeSelect) outputModeSelect.value = detectedOutputMode;
  updateModeChip();
  return detectedOutputMode;
}

function updateLatencyInfo(extra = {}) {
  if (!latencyInfoEl) return;
  const parts = [];
  if (captureMode && captureMode !== 'idle') parts.push(captureMode === 'audioworklet' ? 'AudioWorklet' : 'fallback audio');
  if (serverReadyAt) parts.push(`ready ${Math.max(0, Date.now() - serverReadyAt)} ms`);
  if (audioChunksDropped > 0) parts.push(`drop ${audioChunksDropped}`);
  if (typeof extra.ttsMs === 'number') {
    lastTtsGenerationMs = extra.ttsMs;
    parts.push(`TTS ${extra.ttsMs} ms`);
  } else if (typeof lastTtsGenerationMs === 'number') {
    parts.push(`TTS ${lastTtsGenerationMs} ms`);
  }
  latencyInfoEl.textContent = parts.length ? `Odozva: ${parts.join(' · ')}` : 'Odozva: —';
}

function setLoginStatus(text, variant = 'idle') {
  loginStatus.textContent = text || '';
  loginStatus.dataset.variant = variant;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 1800);
}

function resetPreReadyBuffer() {
  preReadyAudioQueue = [];
  preReadyAudioBytes = 0;
}

function queuePreReadyAudio(buffer) {
  if (!buffer || isMuted || isStopping) return;
  const copy = buffer.slice(0);
  preReadyAudioQueue.push(copy);
  preReadyAudioBytes += copy.byteLength || 0;

  while (preReadyAudioQueue.length > PRE_READY_MAX_CHUNKS) {
    const removed = preReadyAudioQueue.shift();
    preReadyAudioBytes -= removed?.byteLength || 0;
  }
}

function sendAudioBuffer(buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > MAX_WS_BUFFERED_AMOUNT) {
    audioChunksDropped += 1;
    updateLatencyInfo();
    return false;
  }
  ws.send(buffer);
  return true;
}

function handleCapturedPcmBuffer(buffer) {
  if (!buffer || buffer.byteLength === 0) return;
  audioChunksCaptured += 1;
  if (!isRunning || isStopping || isMuted) return;

  if (!serverReady) {
    queuePreReadyAudio(buffer);
    return;
  }

  sendAudioBuffer(buffer);
}

function updateInputLevel(value) {
  const normalized = Number.isFinite(Number(value)) ? Number(value) : 0;
  levelBar.style.width = `${Math.max(0, Math.min(100, normalized))}%`;
}

function flushPreReadyAudio() {
  if (!preReadyAudioQueue.length) return;
  let sent = 0;
  for (const buffer of preReadyAudioQueue) {
    if (sendAudioBuffer(buffer)) sent += 1;
  }
  const flushedBytes = preReadyAudioBytes;
  resetPreReadyBuffer();
  if (sent > 0) {
    console.log(`Pre-ready audio buffer odoslaný: ${sent} chunkov, ${flushedBytes} bajtov`);
  }
}

function stopCurrentAudioPlayback(notifyServer = false) {
  const hadAudio = Boolean(currentAudioEl || audioQueue.length);
  if (currentAudioEl) {
    try {
      currentAudioEl.pause();
      currentAudioEl.src = '';
      currentAudioEl.load?.();
    } catch (err) {
      // ignore
    }
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
  }
  currentAudioEl = null;
  currentAudioUrl = null;
  audioQueue = [];
  isPlaying = false;
  setChip(playbackChip, 'Ticho', 'idle');
  if (notifyServer && hadAudio) notifyPlaybackDone();
}

function updateUsageDisplay(usage) {
  if (!usageInfoEl) return;
  if (!usage || !usage.limits) {
    usageInfoEl.textContent = 'Denné limity sa načítavajú…';
    return;
  }
  const audioUsed = Number(usage.audio_mb || 0).toFixed(1);
  const audioMax = usage.limits.max_audio_mb_per_day;
  const ttsUsed = usage.tts_requests || 0;
  const ttsMax = usage.limits.max_tts_requests_per_day;
  const sessionsUsed = usage.sessions || 0;
  const sessionsMax = usage.limits.max_sessions_per_day;
  usageInfoEl.textContent = `Dnes: audio ${audioUsed}/${audioMax} MB · TTS ${ttsUsed}/${ttsMax} · session ${sessionsUsed}/${sessionsMax}`;
}

async function refreshUsage() {
  if (!currentUser) return;
  try {
    const usage = await fetchJson('/api/usage');
    updateUsageDisplay(usage);
  } catch (err) {
    console.warn('Nepodarilo sa načítať usage:', err);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  let data = null;
  try { data = await response.json(); } catch (err) { data = null; }
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function readableLanguageName(code) {
  const cleanCode = String(code || '').trim().toLowerCase();
  if (!cleanCode) return '';
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    const displayName = displayNames.of(cleanCode);
    if (displayName && displayName !== cleanCode) return displayName;
  } catch (err) {
    // Browser fallback for older engines without Intl.DisplayNames.
  }
  return cleanCode.toUpperCase();
}

function normalizeLanguageOptions(languages) {
  const deduped = new Map();
  if (!Array.isArray(languages)) return [];

  languages.forEach((language) => {
    const rawCode = typeof language === 'string'
      ? language
      : language?.code || language?.language_code || language?.language || language?.id || '';
    const rawName = typeof language === 'object' && language
      ? language.name || language.display_name || language.label || language.language_name || ''
      : '';
    const code = String(rawCode || '').trim().toLowerCase();
    if (!code || deduped.has(code)) return;
    const name = String(rawName || readableLanguageName(code)).trim();
    deduped.set(code, { code, name: name || code.toUpperCase() });
  });

  return Array.from(deduped.values()).sort(
    (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.code.localeCompare(b.code, 'en')
  );
}

function hasAvailableLanguage(code) {
  const cleanCode = String(code || '').trim().toLowerCase();
  return availableLanguages.some((language) => language.code === cleanCode);
}

function pickAvailableLanguage(preferredCodes = []) {
  for (const code of preferredCodes) {
    const cleanCode = String(code || '').trim().toLowerCase();
    if (hasAvailableLanguage(cleanCode)) return cleanCode;
  }
  return availableLanguages[0]?.code || '';
}

function resolveStoredLanguage(storedLanguage, fallbackCodes = []) {
  const cleanCode = String(storedLanguage || '').trim().toLowerCase();
  if (hasAvailableLanguage(cleanCode)) return cleanCode;
  return pickAvailableLanguage(fallbackCodes);
}

function populateSelect(select, selected, options = {}) {
  const { includeAuto = false } = options;
  select.innerHTML = '';

  if (includeAuto) {
    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.textContent = 'Auto';
    autoOption.selected = selected === 'auto';
    select.appendChild(autoOption);
  }

  availableLanguages.forEach((lang) => {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.name;
    option.selected = lang.code === selected;
    select.appendChild(option);
  });
}

function voiceLabel(voice) {
  const genderMap = { male: 'Male', female: 'Female', neutral: 'Neutral' };
  const gender = genderMap[String(voice.gender || '').toLowerCase()] || voice.gender || '';
  return gender ? `${voice.name || voice.id} — ${gender}` : `${voice.name || voice.id}`;
}

function populateVoiceSelect(voices, selectedVoice) {
  voiceSelect.innerHTML = '';
  voices.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voiceLabel(voice);
    option.title = voice.description || '';
    option.selected = voice.id === selectedVoice;
    voiceSelect.appendChild(option);
  });

  if (!voiceSelect.value && voices.length) {
    voiceSelect.value = voices[0].id;
  }
}

function saveSettings() {
  localStorage.setItem('translator.langA', langASelect.value);
  localStorage.setItem('translator.langB', langBSelect.value);
  localStorage.setItem('translator.voice', voiceSelect.value || 'Adrian');
  if (voiceOutputToggle) voiceOutputToggle.checked = true;
  localStorage.setItem('translator.ttsEnabled', 'true');
  localStorage.setItem('translator.endpointDelay', endpointDelaySelect.value);
  localStorage.setItem('translator.outputMode', getOutputMode());
}


function restoreSettings() {
  const storedLangA = localStorage.getItem('translator.langA');
  const storedLangB = localStorage.getItem('translator.langB');
  const langA = resolveStoredLanguage(storedLangA, ['sk']);
  const langB = String(storedLangB || '').trim().toLowerCase() === 'auto'
    ? 'auto'
    : resolveStoredLanguage(storedLangB, ['de', 'en']);
  populateSelect(langASelect, langA);
  populateSelect(langBSelect, langB, { includeAuto: true });
  if (voiceOutputToggle) voiceOutputToggle.checked = true;
  localStorage.setItem('translator.ttsEnabled', 'true');
  const storedEndpointDelay = localStorage.getItem('translator.endpointDelay');
  const migrationDone = localStorage.getItem('translator.endpointDelay.v51Default500') === 'true';
  if (!migrationDone && (!storedEndpointDelay || storedEndpointDelay === '900')) {
    endpointDelaySelect.value = '500';
    localStorage.setItem('translator.endpointDelay', '500');
    localStorage.setItem('translator.endpointDelay.v51Default500', 'true');
  } else {
    endpointDelaySelect.value = storedEndpointDelay || '500';
  }
  detectedOutputMode = 'speaker';
  if (outputModeSelect) outputModeSelect.value = detectedOutputMode;
  updateLanguageBadges();
  updateModeChip();
}


async function loadLanguages() {
  try {
    const data = await fetchJson('/api/languages');
    const languages = normalizeLanguageOptions(data?.languages);
    availableLanguages = languages.length ? languages : FALLBACK_LANGUAGES;
  } catch (err) {
    console.error('Nepodarilo sa načítať jazyky:', err);
    availableLanguages = FALLBACK_LANGUAGES;
    if (currentUser) showToast('Language list unavailable, using fallback');
  }
}

async function loadVoices() {
  const selected = localStorage.getItem('translator.voice') || 'Adrian';
  try {
    const response = await fetch('/api/voices', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const voices = Array.isArray(data.voices) && data.voices.length ? data.voices : FALLBACK_VOICES;
    populateVoiceSelect(voices, selected);
  } catch (err) {
    console.error('Nepodarilo sa načítať hlasy:', err);
    populateVoiceSelect(FALLBACK_VOICES, selected);
    if (currentUser) showToast('Voice list unavailable, using fallback');
  }
}

function showLogin() {
  currentUser = null;
  loginShell.hidden = false;
  appShell.hidden = true;
  accessCodeInput.value = '';
  if (window.matchMedia?.('(hover: hover)').matches) accessCodeInput.focus();
}

async function showApp(session) {
  currentUser = session.username;
  currentUserEl.textContent = currentUser;
  updateUsageDisplay(session.usage);
  loginShell.hidden = true;
  appShell.hidden = false;
  setLoginStatus('');
  await loadLanguages();
  restoreSettings();
  await loadVoices();
  await refreshUsage();
  setStatus('Pripravený', 'idle');
  setChip(connectionChip, 'Pripravené', 'idle');
  setChip(micChip, 'Mikrofón vypnutý', 'idle');
  setChip(playbackChip, 'Ticho', 'idle');
  updateModeChip();
  updateLatencyInfo();
}


async function checkSession() {
  try {
    const session = await fetchJson('/api/session');
    if (session.authenticated) await showApp(session);
    else showLogin();
  } catch (err) {
    showLogin();
  }
}

async function startMicrophone() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  setChip(micChip, 'Mikrofón povolený', 'info');

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextClass({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);

  try {
    if (!audioContext.audioWorklet || !window.AudioWorkletNode) {
      throw new Error('AudioWorklet nie je podporovaný v tomto prehliadači.');
    }

    await audioContext.audioWorklet.addModule('/audio-capture-worklet.js?v=2.7.0');
    audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { chunkSize: 2048, targetSampleRate: 16000 }
    });

    audioWorkletNode.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'level') {
        updateInputLevel(msg.value);
        return;
      }
      if (msg.type === 'capture_info') {
        console.log(`Audio capture: ${msg.sourceSampleRate} Hz → ${msg.targetSampleRate} Hz, chunk ${msg.chunkSize}`);
        updateLatencyInfo();
        return;
      }
      if (msg.type === 'audio' && msg.buffer) {
        handleCapturedPcmBuffer(msg.buffer);
      }
    };

    silenceGainNode = audioContext.createGain();
    silenceGainNode.gain.value = 0;
    source.connect(audioWorkletNode);
    audioWorkletNode.connect(silenceGainNode);
    silenceGainNode.connect(audioContext.destination);

    captureMode = 'audioworklet';
    setChip(micChip, 'Mikrofón AudioWorklet', 'running');
    updateLatencyInfo();
    return;
  } catch (err) {
    console.warn('AudioWorklet nie je dostupný, používam fallback ScriptProcessor:', err);
    captureMode = 'scriptprocessor';
    updateLatencyInfo();
  }

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);

  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  source.connect(scriptProcessor);

  scriptProcessor.onaudioprocess = (event) => {
    const output = event.outputBuffer.getChannelData(0);
    output.fill(0);

    analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    updateInputLevel(Math.min(100, average * 2));

    const inputBuffer = event.inputBuffer.getChannelData(0);
    const pcmBuffer = new Int16Array(inputBuffer.length);

    for (let i = 0; i < inputBuffer.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, inputBuffer[i]));
      pcmBuffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    handleCapturedPcmBuffer(pcmBuffer.buffer);
  };

  scriptProcessor.connect(audioContext.destination);
}

function stopMicrophone() {
  if (audioWorkletNode) {
    try {
      audioWorkletNode.port.onmessage = null;
      audioWorkletNode.disconnect();
    } catch (err) {
      // ignore
    }
    audioWorkletNode = null;
  }
  if (silenceGainNode) {
    try {
      silenceGainNode.disconnect();
    } catch (err) {
      // ignore
    }
    silenceGainNode = null;
  }
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  captureMode = 'idle';
  audioChunksCaptured = 0;
  audioChunksDropped = 0;
  levelBar.style.width = '0%';
  updateLatencyInfo();
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  try {
    if (wakeLock) await wakeLock.release();
  } catch (err) {
    // ignore
  } finally {
    wakeLock = null;
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'config',
      language_a: langASelect.value,
      language_b: langBSelect.value,
      tts_voice: voiceSelect.value || 'Adrian',
      tts_enabled: true,
      output_mode: getOutputMode(),
      endpoint_delay_ms: Number(endpointDelaySelect.value || 500)
    }));
    setStatus('Pripájam Soniox…', 'running');
    setChip(connectionChip, 'Server spojený', 'info');
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        handleJsonMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('Neplatná JSON správa zo servera:', event.data);
        setStatus('Chyba serverovej správy', 'error');
      }
      return;
    }
    handleAudioData(event.data);
  };

  ws.onerror = (err) => {
    console.error('WebSocket chyba:', err);
    setStatus('Chyba spojenia', 'error');
    setChip(connectionChip, 'Chyba spojenia', 'error');
  };

  ws.onclose = () => {
    ws = null;
    setChip(connectionChip, 'Odpojené', 'idle');
    if (stopCloseTimer) {
      clearTimeout(stopCloseTimer);
      stopCloseTimer = null;
    }
    if (isRunning || isStopping) finishStoppedState(true);
  };
}

function isConversationFeedPinned() {
  if (!conversationFeedEl) return false;
  const distanceFromBottom = conversationFeedEl.scrollHeight - conversationFeedEl.scrollTop - conversationFeedEl.clientHeight;
  return distanceFromBottom < 80;
}

function conversationDirectionLabel(item) {
  const source = languageNameForCode(item.source_language) || 'Source';
  const target = languageNameForCode(item.target_language) || 'Translation';
  return `${source} -> ${target}`;
}

function normalizedConversationItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && ((item.source_text || '').trim() || (item.translated_text || '').trim()))
    .map((item, index) => ({
      id: String(item.id || `turn-${index + 1}`),
      source_language: String(item.source_language || ''),
      target_language: String(item.target_language || ''),
      source_text: String(item.source_text || ''),
      translated_text: String(item.translated_text || ''),
      is_final: Boolean(item.is_final)
    }));
}

function legacyConversationItemsFromTokenMessage(msg) {
  const sourceText = String(msg.original_text || '');
  const translatedText = String(msg.translated_text || '');
  if (!sourceText.trim() && !translatedText.trim()) return [];
  return [{
    id: 'legacy-live',
    source_language: msg.language_a || langASelect.value,
    target_language: msg.language_b === 'auto' ? langASelect.value : (msg.language_b || langBSelect.value),
    source_text: sourceText,
    translated_text: translatedText,
    is_final: false
  }];
}

function renderConversationItems(items) {
  if (!conversationFeedEl) return;
  const shouldPinToBottom = isConversationFeedPinned();
  conversationItems = normalizedConversationItems(items);
  conversationFeedEl.replaceChildren();

  if (!conversationItems.length) {
    const empty = document.createElement('p');
    empty.className = 'conversation-empty';
    empty.textContent = 'Start speaking to build the conversation history.';
    conversationFeedEl.appendChild(empty);
    return;
  }

  for (const item of conversationItems) {
    const turn = document.createElement('article');
    turn.className = `conversation-turn${item.is_final ? ' is-final' : ' is-live'}`;

    const header = document.createElement('div');
    header.className = 'conversation-turn-header';

    const direction = document.createElement('span');
    direction.className = 'conversation-direction';
    direction.textContent = conversationDirectionLabel(item);
    header.appendChild(direction);
    turn.appendChild(header);

    if (item.source_text.trim()) {
      const source = document.createElement('p');
      source.className = 'conversation-source-text';
      source.textContent = item.source_text;
      turn.appendChild(source);
    }

    if (item.source_text.trim() && item.translated_text.trim()) {
      const divider = document.createElement('div');
      divider.className = 'conversation-turn-divider';
      turn.appendChild(divider);
    }

    if (item.translated_text.trim()) {
      const translation = document.createElement('p');
      translation.className = 'conversation-translated-text';
      translation.textContent = item.translated_text;
      turn.appendChild(translation);
    }

    conversationFeedEl.appendChild(turn);
  }

  if (shouldPinToBottom) {
    conversationFeedEl.scrollTop = conversationFeedEl.scrollHeight;
  }
}

function conversationItemsToText(items = conversationItems) {
  return normalizedConversationItems(items)
    .map((item) => {
      const parts = [conversationDirectionLabel(item)];
      if (item.source_text.trim()) parts.push(item.source_text.trim());
      if (item.translated_text.trim()) parts.push(item.translated_text.trim());
      return parts.join('\n');
    })
    .join('\n\n');
}

function handleJsonMessage(msg) {
  switch (msg.type) {
    case 'stt_connecting':
      serverReady = false;
      setStatus('Pripájam Soniox… krátky začiatok držím v bufferi', 'running');
      setChip(connectionChip, 'Soniox pripájam', 'info');
      break;
    case 'server_ready':
      serverReady = true;
      serverReadyAt = Date.now();
      isStopping = false;
      flushPreReadyAudio();
      setStatus(`Počúvam… môžeš hovoriť (${captureMode === 'audioworklet' ? 'AudioWorklet' : 'fallback audio'})`, 'running');
      setChip(connectionChip, 'Soniox pripravený', 'running');
      setChip(micChip, 'Počúvam', 'running');
      updateLatencyInfo();
      break;
    case 'token':
      if (originalTextEl) originalTextEl.textContent = msg.original_text || '';
      if (translatedTextEl) translatedTextEl.textContent = msg.translated_text || '';
      renderConversationItems(Array.isArray(msg.conversation_items)
        ? msg.conversation_items
        : legacyConversationItemsFromTokenMessage(msg));
      if ((msg.final_translated_text || msg.translated_text || '').trim()) repeatLastBtn.disabled = !lastAudioBuffer;
      break;
    case 'mute':
      isMuted = true;
      setStatus('Prehrávam preklad cez reproduktor… mikrofón je dočasne stlmený', 'speaking');
      setChip(playbackChip, 'Prehrávam', 'speaking');
      setChip(micChip, 'Stlmený počas TTS', 'idle');
      levelBar.style.width = '0%';
      break;
    case 'unmute':
      isMuted = false;
      if (isRunning && serverReady && !isStopping) setStatus(`Počúvam… môžeš hovoriť (${captureMode === 'audioworklet' ? 'AudioWorklet' : 'fallback audio'})`, 'running');
      if (isRunning && serverReady && !isStopping) setChip(micChip, 'Počúvam', 'running');
      setChip(playbackChip, 'Ticho', 'idle');
      break;
    case 'play_audio':
      lastAudioMeta = msg;
      if (typeof msg.generation_ms === 'number') updateLatencyInfo({ ttsMs: msg.generation_ms });
      setChip(playbackChip, 'Audio pripravené', 'info');
      break;
    case 'playback_mode':
      if (msg.output_mode === 'headphones') {
        setStatus('Prehrávam preklad cez slúchadlá… mikrofón zostáva aktívny', 'speaking');
        setChip(micChip, 'Počúvam ďalej', 'running');
        setChip(playbackChip, 'Prehrávam', 'speaking');
      }
      break;
    case 'stream_finishing':
      serverReady = false;
      resetPreReadyBuffer();
      setStatus('Dokončujem posledné slová…', 'idle');
      setChip(connectionChip, 'Dokončujem', 'info');
      setChip(micChip, 'Mikrofón vypnutý', 'idle');
      break;
    case 'session_finished':
      serverReady = false;
      resetPreReadyBuffer();
      refreshUsage();
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      break;
    case 'settings_updated':
      showToast('Nastavenia hlasu uložené');
      break;
    case 'auth_required':
      setStatus('Prístup odmietnutý', 'error');
      showToast('Access denied');
      showLogin();
      break;
    case 'error':
      console.error('Server chyba:', msg.message);
      setStatus(`Chyba: ${msg.message}`, 'error');
      showToast(msg.message || 'Chyba servera');
      break;
    default:
      console.log('Neznáma správa:', msg);
  }
}

function handleAudioData(arrayBuffer) {
  lastAudioBuffer = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
  repeatLastBtn.disabled = false;
  audioQueue.push(arrayBuffer);
  if (!isPlaying) playNextAudio();
}

async function playNextAudio() {
  if (!audioQueue.length) {
    isPlaying = false;
    return;
  }

  isPlaying = true;
  setChip(playbackChip, 'Prehrávam', 'speaking');
  const audioData = audioQueue.shift();
  const blob = new Blob([audioData], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudioEl = audio;
  currentAudioUrl = url;

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    if (currentAudioEl === audio) currentAudioEl = null;
    if (currentAudioUrl === url) currentAudioUrl = null;
    URL.revokeObjectURL(url);
    notifyPlaybackDone();
    setChip(playbackChip, audioQueue.length ? 'Ďalší preklad' : 'Ticho', audioQueue.length ? 'info' : 'idle');
    playNextAudio();
  };

  audio.onended = done;
  audio.onerror = (err) => {
    console.error('Chyba pri prehrávaní audia:', err);
    done();
  };

  try {
    await audio.play();
  } catch (err) {
    console.error('Prehliadač zablokoval audio:', err);
    done();
  }
}

async function replayLastAudio() {
  if (!lastAudioBuffer) {
    showToast('Zatiaľ nemám uložený hovorený preklad');
    return;
  }
  if (isRunning && isPlaying) {
    showToast('Počkaj na koniec aktuálneho prehrávania alebo stlač Stop audio');
    return;
  }
  stopCurrentAudioPlayback(false);
  const blob = new Blob([lastAudioBuffer], { type: lastAudioMeta?.mime || 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudioEl = audio;
  currentAudioUrl = url;
  setChip(playbackChip, 'Opakujem', 'speaking');
  setStatus('Opakujem posledný hovorený preklad…', 'speaking');
  audio.onended = () => {
    if (currentAudioEl === audio) currentAudioEl = null;
    if (currentAudioUrl === url) currentAudioUrl = null;
    URL.revokeObjectURL(url);
    setChip(playbackChip, 'Ticho', 'idle');
    if (isRunning && serverReady && !isMuted) setStatus(`Počúvam… môžeš hovoriť (${captureMode === 'audioworklet' ? 'AudioWorklet' : 'fallback audio'})`, 'running');
    else if (!isRunning) setStatus('Pripravený', 'idle');
  };
  audio.onerror = () => {
    URL.revokeObjectURL(url);
    setChip(playbackChip, 'Chyba audia', 'error');
  };
  try {
    await audio.play();
  } catch (err) {
    showToast('Prehliadač zablokoval opakovanie audia');
    audio.onended?.();
  }
}

function notifyPlaybackDone() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'playback_done' }));
  }
}

function sendSettingsUpdate() {
  saveSettings();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'update_settings',
      tts_voice: voiceSelect.value || 'Adrian',
      tts_enabled: true,
      output_mode: getOutputMode()
    }));
  }
}

function setControlsRunningState(running) {
  startBtn.classList.toggle('stop', running);
  startBtnText.textContent = running ? 'Stop Conversation' : 'Start Conversation';
  langASelect.disabled = running;
  langBSelect.disabled = running;
  endpointDelaySelect.disabled = running;
  if (outputModeSelect) outputModeSelect.disabled = false;
  updateModeChip();
}


async function startTranslation() {
  try {
    if (!currentUser) {
      showLogin();
      return;
    }

    saveSettings();
    isRunning = true;
    isStopping = false;
    isMuted = false;
    serverReady = false;
    serverReadyAt = 0;
    audioChunksCaptured = 0;
    audioChunksDropped = 0;
    audioQueue = [];
    isPlaying = false;
    renderConversationItems([]);
    resetPreReadyBuffer();
    stopCurrentAudioPlayback();
    setControlsRunningState(true);
    setStatus('Žiadam mikrofón…', 'running');
    setChip(connectionChip, 'Štartujem', 'info');
    setChip(micChip, 'Žiadam povolenie', 'info');
    setChip(playbackChip, 'Ticho', 'idle');
    updateModeChip();

    await startMicrophone();
    await applyAutomaticOutputMode();
    await requestWakeLock();
    setStatus('Pripájam server…', 'running');
    setChip(connectionChip, 'Pripájam server', 'info');
    connectWebSocket();
  } catch (err) {
    console.error(err);
    isRunning = false;
    isStopping = false;
    isMuted = false;
    serverReady = false;
    stopMicrophone();
    await releaseWakeLock();
    setControlsRunningState(false);
    setStatus('Mikrofón nepovolený', 'error');
    setChip(micChip, 'Mikrofón odmietnutý', 'error');
    setChip(connectionChip, 'Pripravené', 'idle');
    showToast('Allow microphone access in Chrome');
  }
}

async function finishStoppedState(fromSocket = false) {
  isRunning = false;
  isStopping = false;
  isMuted = false;
  serverReady = false;
  serverReadyAt = 0;
  resetPreReadyBuffer();
  stopCurrentAudioPlayback();
  stopMicrophone();
  await releaseWakeLock();
  setControlsRunningState(false);
  if (currentUser) {
    setStatus(fromSocket ? 'Spojenie ukončené' : 'Pripravený', 'idle');
    setChip(micChip, 'Mikrofón vypnutý', 'idle');
    setChip(playbackChip, 'Ticho', 'idle');
    refreshUsage();
  }
}

async function stopTranslation(options = {}) {
  const { fromSocket = false } = options;
  if (!isRunning && !isStopping) return;
  isStopping = true;
  serverReady = false;
  stopMicrophone();
  await releaseWakeLock();
  setControlsRunningState(false);
  setStatus('Ukončujem stream…', 'idle');
  setChip(connectionChip, 'Ukončujem', 'info');
  setChip(micChip, 'Mikrofón vypnutý', 'idle');

  if (!fromSocket && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'client_stop' }));
      stopCloseTimer = window.setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      }, 5200);
      return;
    } catch (err) {
      console.error('Nepodarilo sa odoslať client_stop:', err);
    }
  }

  if (!fromSocket && ws && ws.readyState === WebSocket.OPEN) ws.close();
  await finishStoppedState(fromSocket);
}

async function copyText(text, label) {
  if (!text.trim()) {
    showToast('Nothing to copy');
    return;
  }
  await navigator.clipboard.writeText(text);
  showToast(`${label} copied`);
}

function clearText() {
  if (originalTextEl) originalTextEl.textContent = '';
  if (translatedTextEl) translatedTextEl.textContent = '';
  renderConversationItems([]);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clear_text' }));
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = accessCodeInput.value.trim();
  if (!code) {
    setLoginStatus('Enter your access code.', 'error');
    return;
  }

  setLoginStatus('Checking access...', 'idle');
  try {
    const session = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    await showApp(session);
    showToast('Access granted');
  } catch (err) {
    setLoginStatus(err.message || 'Incorrect access code.', 'error');
  }
});

logoutBtn.addEventListener('click', async () => {
  if (isRunning || isStopping) await stopTranslation();
  try {
    await fetchJson('/api/logout', { method: 'POST', body: '{}' });
  } catch (err) {
    // ignore logout errors
  }
  showLogin();
});

swapBtn.addEventListener('click', () => {
  if (langBSelect.value === 'auto') {
    showToast('Auto mode cannot be swapped');
    return;
  }

  const tmp = langASelect.value;
  langASelect.value = langBSelect.value;
  langBSelect.value = tmp;
  updateLanguageBadges();
  saveSettings();
});

startBtn.addEventListener('click', () => {
  if (isRunning || isStopping) stopTranslation();
  else startTranslation();
});

voiceSelect.addEventListener('change', sendSettingsUpdate);
voiceOutputToggle.addEventListener('change', sendSettingsUpdate);
if (outputModeSelect) outputModeSelect.addEventListener('change', () => { saveSettings(); updateModeChip(); sendSettingsUpdate(); });
endpointDelaySelect.addEventListener('change', saveSettings);
langASelect.addEventListener('change', () => { updateLanguageBadges(); saveSettings(); });
langBSelect.addEventListener('change', () => { updateLanguageBadges(); saveSettings(); });

if (copyOriginalBtn && originalTextEl) {
  copyOriginalBtn.addEventListener('click', () => copyText(originalTextEl.textContent, 'Original'));
}
if (copyTranslatedBtn && translatedTextEl) {
  copyTranslatedBtn.addEventListener('click', () => copyText(translatedTextEl.textContent, 'Translation'));
}
if (copyConversationBtn) {
  copyConversationBtn.addEventListener('click', () => copyText(conversationItemsToText(), 'Conversation'));
}
copyAllBtn.addEventListener('click', () => copyText(conversationItemsToText(), 'Conversation'));
clearBtn.addEventListener('click', clearText);
repeatLastBtn.addEventListener('click', replayLastAudio);
stopAudioBtn.addEventListener('click', () => stopCurrentAudioPlayback(true));
textOnlyBtn.addEventListener('click', () => {
  voiceOutputToggle.checked = false;
  sendSettingsUpdate();
  showToast('Text mode enabled');
});

window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'client_stop' })); } catch (err) { /* ignore */ }
    ws.close();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isRunning && !wakeLock) {
    requestWakeLock();
  }
});

if (repeatLastBtn) repeatLastBtn.disabled = true;
checkSession();
