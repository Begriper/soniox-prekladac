require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { performance } = require("perf_hooks");
const crypto = require("crypto");
const {
  bytesLength,
  chunkTextForTts,
  formatKb,
  formatMb,
  normalizeBoolean,
  normalizeEndpointDelay,
  normalizeLanguageCode,
  normalizeOutputMode,
  normalizeVoiceId,
} = require("./server-utils");

const APP_VERSION = "2.7.0-v6-production-hardening";
const TTS_TRANSPORT = "rest";

const SONIOX_REGION = String(process.env.SONIOX_REGION || "eu")
  .trim()
  .toLowerCase();

const SONIOX_REGION_ENDPOINTS = {
  us: {
    stt: "wss://stt-rt.soniox.com/transcribe-websocket",
    tts: "https://tts-rt.soniox.com/tts",
    models: "https://api.soniox.com/v1/tts-models",
  },
  eu: {
    stt: "wss://stt-rt.eu.soniox.com/transcribe-websocket",
    tts: "https://tts-rt.eu.soniox.com/tts",
    models: "https://api.eu.soniox.com/v1/tts-models",
  },
};

const SELECTED_SONIOX_ENDPOINTS =
  SONIOX_REGION_ENDPOINTS[SONIOX_REGION] || SONIOX_REGION_ENDPOINTS.eu;

if (!SONIOX_REGION_ENDPOINTS[SONIOX_REGION]) {
  console.warn(
    `[config] Neznámy SONIOX_REGION="${SONIOX_REGION}". Používam EU endpointy.`
  );
}

const SONIOX_STT_URL =
  process.env.SONIOX_STT_URL || SELECTED_SONIOX_ENDPOINTS.stt;
const SONIOX_TTS_REST_URL =
  process.env.SONIOX_TTS_REST_URL || SELECTED_SONIOX_ENDPOINTS.tts;
const SONIOX_TTS_MODELS_URL =
  process.env.SONIOX_TTS_MODELS_URL || SELECTED_SONIOX_ENDPOINTS.models;
const PORT = process.env.PORT || 3000;

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_COOKIE_NAME = "sl_session";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MINUTES || 720) * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS || 8);
const MAX_SESSION_MS = Number(process.env.MAX_SESSION_MINUTES || 30) * 60 * 1000;
const MAX_AUDIO_BYTES_PER_SESSION = Number(process.env.MAX_AUDIO_MB_PER_SESSION || 75) * 1024 * 1024;
const MAX_TTS_REQUESTS_PER_SESSION = Number(process.env.MAX_TTS_REQUESTS_PER_SESSION || 120);
const MAX_TTS_QUEUE = Number(process.env.MAX_TTS_QUEUE || 5);
const MAX_TTS_CHARS = Number(process.env.MAX_TTS_CHARS || 900);
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 40000);
const MAX_WS_MESSAGE_BYTES = Number(process.env.MAX_WS_MESSAGE_KB || 128) * 1024;
const MAX_ACTIVE_WS_TOTAL = Number(process.env.MAX_ACTIVE_WS_TOTAL || 3);
const MAX_ACTIVE_WS_PER_IP = Number(process.env.MAX_ACTIVE_WS_PER_IP || 2);
const MAX_USER_SESSIONS_PER_DAY = Number(process.env.MAX_USER_SESSIONS_PER_DAY || 20);
const MAX_USER_AUDIO_BYTES_PER_DAY = Number(process.env.MAX_USER_AUDIO_MB_PER_DAY || 250) * 1024 * 1024;
const MAX_USER_TTS_REQUESTS_PER_DAY = Number(process.env.MAX_USER_TTS_REQUESTS_PER_DAY || 600);
const MAX_USER_TTS_AUDIO_BYTES_PER_DAY = Number(process.env.MAX_USER_TTS_AUDIO_MB_PER_DAY || 160) * 1024 * 1024;
const MAX_TTS_AUDIO_BYTES_PER_SESSION = Number(process.env.MAX_TTS_AUDIO_MB_PER_SESSION || 80) * 1024 * 1024;
const MAX_PREVIEW_TTS_REQUESTS_PER_HOUR = Number(process.env.MAX_PREVIEW_TTS_REQUESTS_PER_HOUR || 20);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_SECONDS || 120) * 1000;
const NO_CONFIG_TIMEOUT_MS = Number(process.env.NO_CONFIG_TIMEOUT_SECONDS || 12) * 1000;
const SONIOX_CONNECT_TIMEOUT_MS = Number(process.env.SONIOX_CONNECT_TIMEOUT_SECONDS || 10) * 1000;
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_SECONDS || 25) * 1000;
const TTS_PLAYBACK_TIMEOUT_MS = Number(process.env.TTS_PLAYBACK_TIMEOUT_SECONDS || 45) * 1000;
const SONIOX_FINALIZE_TIMEOUT_MS = Number(process.env.SONIOX_FINALIZE_TIMEOUT_SECONDS || 4) * 1000;

const SESSION_SECRET = String(process.env.SESSION_SECRET || "").trim();
const LEGACY_ACCESS_KEY = String(process.env.APP_ACCESS_KEY || "").trim();
const ACCESS_CODE_CONFIG = String(process.env.APP_ACCESS_CODES || "").trim();

if (!process.env.SONIOX_API_KEY) {
  console.error("CHYBA: Premenná prostredia SONIOX_API_KEY nie je nastavená.");
  process.exit(1);
}

const FALLBACK_TTS_VOICES = [
  {
    id: "Maya",
    name: "Maya",
    gender: "female",
    description: "Jasný, stabilný a príjemný ženský hlas.",
  },
  {
    id: "Daniel",
    name: "Daniel",
    gender: "male",
    description: "Hlbší, pokojný a profesionálny mužský hlas.",
  },
  {
    id: "Noah",
    name: "Noah",
    gender: "male",
    description: "Mladší, živší a moderný mužský hlas.",
  },
  {
    id: "Nina",
    name: "Nina",
    gender: "female",
    description: "Jasný, expresívny a priateľský ženský hlas.",
  },
  {
    id: "Emma",
    name: "Emma",
    gender: "female",
    description: "Plynulý, prirodzený a uvoľnený ženský hlas.",
  },
  {
    id: "Jack",
    name: "Jack",
    gender: "male",
    description: "Priateľský a sebavedomý mužský hlas.",
  },
  {
    id: "Adrian",
    name: "Adrian",
    gender: "male",
    description: "Hlboký, sústredený a autoritatívny mužský hlas.",
  },
  {
    id: "Claire",
    name: "Claire",
    gender: "female",
    description: "Elegantný, artikulovaný a čistý ženský hlas.",
  },
  {
    id: "Grace",
    name: "Grace",
    gender: "female",
    description: "Jemný, pokojný a upokojujúci ženský hlas.",
  },
  {
    id: "Owen",
    name: "Owen",
    gender: "male",
    description: "Vyrovnaný a prirodzený mužský hlas.",
  },
  {
    id: "Mina",
    name: "Mina",
    gender: "female",
    description: "Mäkký, teplý a premyslený ženský hlas.",
  },
  {
    id: "Kenji",
    name: "Kenji",
    gender: "male",
    description: "Pokojný, presný a moderný mužský hlas.",
  },
  {
    id: "Rafael",
    name: "Rafael",
    gender: "male",
    description: "Teplý mužský hlas so španielskym prízvukom.",
  },
  {
    id: "Mateo",
    name: "Mateo",
    gender: "male",
    description: "Mladý a priateľský mužský hlas so španielskym prízvukom.",
  },
  {
    id: "Lucia",
    name: "Lucia",
    gender: "female",
    description: "Zrelý ženský hlas so španielskym prízvukom.",
  },
  {
    id: "Sofia",
    name: "Sofia",
    gender: "female",
    description: "Svetlý ženský hlas so španielskym prízvukom.",
  },
  {
    id: "Oliver",
    name: "Oliver",
    gender: "male",
    description: "Pokojný mužský hlas s britským prízvukom.",
  },
  {
    id: "Arthur",
    name: "Arthur",
    gender: "male",
    description: "Hlboký mužský hlas s britským prízvukom.",
  },
  {
    id: "Isla",
    name: "Isla",
    gender: "female",
    description: "Živý ženský hlas s britským prízvukom.",
  },
  {
    id: "Victoria",
    name: "Victoria",
    gender: "female",
    description: "Elegantný ženský hlas s britským prízvukom.",
  },
  {
    id: "Cooper",
    name: "Cooper",
    gender: "male",
    description: "Výrazný mužský hlas s austrálskym prízvukom.",
  },
  {
    id: "Mason",
    name: "Mason",
    gender: "male",
    description: "Uvoľnený mužský hlas s austrálskym prízvukom.",
  },
  {
    id: "Ruby",
    name: "Ruby",
    gender: "female",
    description: "Sebavedomý ženský hlas s austrálskym prízvukom.",
  },
  {
    id: "Elise",
    name: "Elise",
    gender: "female",
    description: "Teplý ženský hlas s austrálskym prízvukom.",
  },
  {
    id: "Arjun",
    name: "Arjun",
    gender: "male",
    description: "Hlboký mužský hlas s indickým prízvukom.",
  },
  {
    id: "Rohan",
    name: "Rohan",
    gender: "male",
    description: "Charizmatický mužský hlas s indickým prízvukom.",
  },
  {
    id: "Priya",
    name: "Priya",
    gender: "female",
    description: "Jasný ženský hlas s indickým prízvukom.",
  },
  {
    id: "Meera",
    name: "Meera",
    gender: "female",
    description: "Profesionálny ženský hlas s indickým prízvukom.",
  },
];

let cachedTtsVoices = null;
let cachedTtsVoicesAt = 0;
let cachedTtsModelId = "tts-rt-v1";
const runtimeCounters = {
  ttsRestFallbacks: 0,
  ttsWsFailures: 0,
  ttsTransportSwitches: 0,
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: MAX_WS_MESSAGE_BYTES,
  perMessageDeflate: false,
});

app.disable("x-powered-by");

function securityHeaders(req, res, next) {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join('; ');

  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), payment=(), usb=()");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (req.path.startsWith('/api/') || req.path === '/health') {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
}

app.use(securityHeaders);
app.use(express.json({ limit: "64kb" }));

function createSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function elapsedMs(startedAt) {
  if (!startedAt) return null;
  return Math.round(performance.now() - startedAt);
}

function isStreamMarker(text) {
  return text === "<end>" || text === "<fin>";
}

function endpointHost(url) {
  try {
    return new URL(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")).host;
  } catch (err) {
    return "unknown";
  }
}

function inferSonioxRegion() {
  return SONIOX_STT_URL.includes(".eu.") ? "eu" : "us";
}

function safeSendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseAccessCodes() {
  const users = [];

  if (ACCESS_CODE_CONFIG) {
    for (const rawPart of ACCESS_CODE_CONFIG.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const separatorIndex = part.indexOf(":");
      if (separatorIndex === -1) continue;
      const username = part.slice(0, separatorIndex).trim().replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40);
      const code = part.slice(separatorIndex + 1).trim();
      if (username && code.length >= 4) users.push({ username, code });
    }
  }

  if (!users.length && LEGACY_ACCESS_KEY) {
    users.push({ username: "owner", code: LEGACY_ACCESS_KEY });
  }

  return users;
}

const ACCESS_USERS = parseAccessCodes();
const sessions = new Map();
const loginAttempts = new Map();
const activeWsByUser = new Map();
const activeWsByIp = new Map();
const usageByUser = new Map();
const previewRateByUser = new Map();
const lastSessionSummaryByUser = new Map();
let activeWsTotal = 0;

if (!ACCESS_USERS.length) {
  console.error(
    "CHYBA: Nastav APP_ACCESS_CODES vo formáte fero:TVOJ_KOD,brat:BRATOV_KOD alebo aspoň APP_ACCESS_KEY."
  );
  process.exit(1);
}

if (IS_PRODUCTION && SESSION_SECRET.length < 32) {
  console.error("CHYBA: V produkcii musí byť SESSION_SECRET dlhý aspoň 32 znakov.");
  process.exit(1);
}

const EFFECTIVE_SESSION_SECRET = SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!SESSION_SECRET) {
  console.warn("[auth] SESSION_SECRET nie je nastavený. Používam dočasný secret iba do reštartu servera.");
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function findAccessUser(code) {
  const cleanCode = String(code || "").trim();
  if (!cleanCode) return null;
  return ACCESS_USERS.find((user) => timingSafeEqualString(cleanCode, user.code)) || null;
}

function getClientIp(req) {
  return String(req?.headers?.["fly-client-ip"] || req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 80);
}

function isLoginRateLimited(ip) {
  const now = Date.now();
  const current = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (now > current.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  current.count += 1;
  loginAttempts.set(ip, current);
  return current.count > MAX_LOGIN_ATTEMPTS;
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function signSessionId(sessionId) {
  return crypto.createHmac("sha256", EFFECTIVE_SESSION_SECRET).update(sessionId).digest("base64url");
}

function createSession(username) {
  const sessionId = crypto.randomBytes(32).toString("base64url");
  const session = {
    id: sessionId,
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(sessionId, session);
  return session;
}

function destroySession(sessionId) {
  if (sessionId) sessions.delete(sessionId);
}

function serializeSessionCookie(session) {
  const value = `${session.id}.${signSessionId(session.id)}`;
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (IS_PRODUCTION) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie() {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (IS_PRODUCTION) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(req) {
  const header = String(req?.headers?.cookie || "");
  const cookies = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getSessionFromRequest(req) {
  const cookieValue = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!cookieValue || !cookieValue.includes(".")) return null;

  const [sessionId, signature] = cookieValue.split(".");
  if (!sessionId || !signature || !timingSafeEqualString(signature, signSessionId(sessionId))) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    destroySession(sessionId);
    return null;
  }
  return session;
}

function requireSession(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: "Najprv sa prihlás prístupovým kódom." });
  }
  req.authSession = session;
  next();
}

function verifyWebSocketOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return !IS_PRODUCTION;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === req.headers.host;
  } catch (err) {
    return false;
  }
}

function rejectUpgrade(socket, status = 401, message = "Unauthorized") {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch (err) {
    // ignore
  }
  socket.destroy();
}

function currentUsageDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function emptyUsage(username) {
  return {
    username,
    date: currentUsageDateKey(),
    sessions: 0,
    audioBytes: 0,
    ttsRequests: 0,
    ttsAudioBytes: 0,
    previewTtsRequests: 0,
    deniedEvents: 0,
  };
}

function getUserUsage(username) {
  const key = String(username || "unknown");
  const today = currentUsageDateKey();
  const existing = usageByUser.get(key);
  if (!existing || existing.date !== today) {
    const fresh = emptyUsage(key);
    usageByUser.set(key, fresh);
    return fresh;
  }
  return existing;
}

function addUsage(username, patch = {}) {
  const usage = getUserUsage(username);
  for (const [key, value] of Object.entries(patch)) {
    if (typeof usage[key] === "number") usage[key] += Number(value || 0);
  }
  return usage;
}

function usageSnapshot(username) {
  const usage = getUserUsage(username);
  return {
    date: usage.date,
    user: usage.username,
    sessions: usage.sessions,
    audio_mb: formatMb(usage.audioBytes),
    tts_requests: usage.ttsRequests,
    tts_audio_mb: formatMb(usage.ttsAudioBytes),
    preview_tts_requests: usage.previewTtsRequests,
    denied_events: usage.deniedEvents,
    limits: {
      max_sessions_per_day: MAX_USER_SESSIONS_PER_DAY,
      max_audio_mb_per_day: Math.round(MAX_USER_AUDIO_BYTES_PER_DAY / 1024 / 1024),
      max_tts_requests_per_day: MAX_USER_TTS_REQUESTS_PER_DAY,
      max_tts_audio_mb_per_day: Math.round(MAX_USER_TTS_AUDIO_BYTES_PER_DAY / 1024 / 1024),
      max_preview_tts_per_hour: MAX_PREVIEW_TTS_REQUESTS_PER_HOUR,
      max_active_ws_total: MAX_ACTIVE_WS_TOTAL,
      max_active_ws_per_ip: MAX_ACTIVE_WS_PER_IP,
      idle_timeout_seconds: Math.round(IDLE_TIMEOUT_MS / 1000),
    },
    remaining: {
      sessions: Math.max(0, MAX_USER_SESSIONS_PER_DAY - usage.sessions),
      audio_mb: formatMb(Math.max(0, MAX_USER_AUDIO_BYTES_PER_DAY - usage.audioBytes)),
      tts_requests: Math.max(0, MAX_USER_TTS_REQUESTS_PER_DAY - usage.ttsRequests),
      tts_audio_mb: formatMb(Math.max(0, MAX_USER_TTS_AUDIO_BYTES_PER_DAY - usage.ttsAudioBytes)),
    },
  };
}

function canStartUserSession(username) {
  const usage = getUserUsage(username);
  return usage.sessions < MAX_USER_SESSIONS_PER_DAY;
}

function canUseMoreAudio(username, nextBytes = 0) {
  const usage = getUserUsage(username);
  return usage.audioBytes + Number(nextBytes || 0) <= MAX_USER_AUDIO_BYTES_PER_DAY;
}

function canUseMoreTts(username, nextAudioBytes = 0, nextRequests = 0) {
  const usage = getUserUsage(username);
  return (
    usage.ttsRequests + Number(nextRequests || 0) <= MAX_USER_TTS_REQUESTS_PER_DAY &&
    usage.ttsAudioBytes + Number(nextAudioBytes || 0) <= MAX_USER_TTS_AUDIO_BYTES_PER_DAY
  );
}

function getActiveIpCount(ip) {
  return activeWsByIp.get(ip) || 0;
}

function incrementActiveIp(ip) {
  activeWsByIp.set(ip, getActiveIpCount(ip) + 1);
}

function decrementActiveIp(ip) {
  const next = Math.max(0, getActiveIpCount(ip) - 1);
  if (next) activeWsByIp.set(ip, next);
  else activeWsByIp.delete(ip);
}

function isPreviewRateLimited(username) {
  const key = String(username || "unknown");
  const now = Date.now();
  const current = previewRateByUser.get(key) || { count: 0, resetAt: now + 60 * 60 * 1000 };
  if (now > current.resetAt) {
    previewRateByUser.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 });
    addUsage(key, { previewTtsRequests: 1 });
    return false;
  }
  current.count += 1;
  previewRateByUser.set(key, current);
  addUsage(key, { previewTtsRequests: 1 });
  return current.count > MAX_PREVIEW_TTS_REQUESTS_PER_HOUR;
}

function truncateText(text, maxLength = MAX_TEXT_CHARS) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

function normalizeVoiceList(modelsResponse) {
  const models = Array.isArray(modelsResponse?.models)
    ? modelsResponse.models
    : Array.isArray(modelsResponse)
    ? modelsResponse
    : [];

  const preferredModel =
    models.find((model) => model?.id === "tts-rt-v1") ||
    models.find(
      (model) => Array.isArray(model?.voices) && model.voices.length > 0
    ) ||
    models[0];

  if (preferredModel?.id) cachedTtsModelId = preferredModel.id;

  const voices = Array.isArray(preferredModel?.voices)
    ? preferredModel.voices
    : [];
  const normalized = voices
    .map((voice) => {
      const id = voice?.id || voice?.name || voice?.voice;
      if (!id) return null;
      return {
        id: normalizeVoiceId(id),
        name: String(voice?.name || id),
        gender: String(voice?.gender || "neutral").toLowerCase(),
        description: String(voice?.description || ""),
      };
    })
    .filter(Boolean);

  return normalized.length ? normalized : FALLBACK_TTS_VOICES;
}

async function fetchTtsVoices() {
  const now = Date.now();
  if (cachedTtsVoices && now - cachedTtsVoicesAt < 10 * 60 * 1000) {
    return cachedTtsVoices;
  }

  const response = await fetch(SONIOX_TTS_MODELS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.SONIOX_API_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Soniox TTS models HTTP ${response.status}`);
  }

  const data = await response.json();
  cachedTtsVoices = normalizeVoiceList(data);
  cachedTtsVoicesAt = now;
  return cachedTtsVoices;
}

async function synthesizeSpeechBuffer({ text, language, voice }) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("Prázdny text pre TTS.");

  const response = await fetch(SONIOX_TTS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SONIOX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-rt-v1",
      language: normalizeLanguageCode(language) || "en",
      voice: normalizeVoiceId(voice),
      audio_format: "wav",
      sample_rate: 24000,
      text: cleanText,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Soniox TTS HTTP ${response.status}: ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuffer);
  if (!audioBuffer.length) throw new Error("Soniox TTS vrátil prázdne audio.");
  return audioBuffer;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "ok",
  });
});

app.get("/api/config", (req, res) => {
  const session = getSessionFromRequest(req);
  res.json({
    appVersion: APP_VERSION,
    requiresLogin: true,
    loggedIn: Boolean(session),
    username: session?.username || null,
    defaultVoice: "Adrian",
    defaultEndpointDelayMs: 500,
    configuredSonioxRegion: SONIOX_REGION,
    sonioxRegion: inferSonioxRegion(),
    sonioxSttHost: endpointHost(SONIOX_STT_URL),
    limits: {
      maxSessionMinutes: Math.round(MAX_SESSION_MS / 60000),
      maxAudioMbPerSession: Math.round(MAX_AUDIO_BYTES_PER_SESSION / 1024 / 1024),
      maxTtsRequestsPerSession: MAX_TTS_REQUESTS_PER_SESSION,
      maxTtsAudioMbPerSession: Math.round(MAX_TTS_AUDIO_BYTES_PER_SESSION / 1024 / 1024),
      maxActiveWsTotal: MAX_ACTIVE_WS_TOTAL,
      maxActiveWsPerIp: MAX_ACTIVE_WS_PER_IP,
      maxUserSessionsPerDay: MAX_USER_SESSIONS_PER_DAY,
      maxUserAudioMbPerDay: Math.round(MAX_USER_AUDIO_BYTES_PER_DAY / 1024 / 1024),
      maxUserTtsRequestsPerDay: MAX_USER_TTS_REQUESTS_PER_DAY,
      maxUserTtsAudioMbPerDay: Math.round(MAX_USER_TTS_AUDIO_BYTES_PER_DAY / 1024 / 1024),
      idleTimeoutSeconds: Math.round(IDLE_TIMEOUT_MS / 1000),
      sonioxFinalizeTimeoutSeconds: Math.round(SONIOX_FINALIZE_TIMEOUT_MS / 1000),
    },
  });
});

app.get("/api/session", (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({
    authenticated: true,
    username: session.username,
    expires_at: new Date(session.expiresAt).toISOString(),
    usage: usageSnapshot(session.username),
  });
});

app.get("/api/usage", requireSession, (req, res) => {
  res.json(usageSnapshot(req.authSession.username));
});

app.get("/api/diagnostics", requireSession, (req, res) => {
  const username = req.authSession.username;
  res.json({
    ok: true,
    version: APP_VERSION,
    node_env: process.env.NODE_ENV || "development",
    uptime_seconds: Math.round(process.uptime()),
    user: username,
    fly: {
      app_name: process.env.FLY_APP_NAME || null,
      region: process.env.FLY_REGION || null,
      machine_id: process.env.FLY_MACHINE_ID || null,
      primary_region: "fra",
    },
    soniox: {
      configured_region: SONIOX_REGION,
      inferred_region: inferSonioxRegion(),
      stt_host: endpointHost(SONIOX_STT_URL),
      tts_host: endpointHost(SONIOX_TTS_REST_URL),
      tts_models_host: endpointHost(SONIOX_TTS_MODELS_URL),
      stt_model: "stt-rt-v4",
      tts_model: cachedTtsModelId || "tts-rt-v1",
    },
    tts: {
      transport: TTS_TRANSPORT,
      default_transport: "rest",
      rest_fallback_available: true,
      websocket_primary: false,
      websocket_experiment_enabled: false,
      counters: {
        rest_fallbacks: runtimeCounters.ttsRestFallbacks,
        websocket_failures: runtimeCounters.ttsWsFailures,
        transport_switches: runtimeCounters.ttsTransportSwitches,
      },
    },
    runtime: {
      active_ws_total: activeWsTotal,
      active_ws_for_user: activeWsByUser.has(username),
      max_active_ws_total: MAX_ACTIVE_WS_TOTAL,
      max_active_ws_per_ip: MAX_ACTIVE_WS_PER_IP,
      default_endpoint_delay_ms: 500,
      audio_capture: "AudioWorklet preferred, ScriptProcessor fallback",
    },
    last_session_summary: lastSessionSummaryByUser.get(username) || null,
    limits: {
      max_session_minutes: Math.round(MAX_SESSION_MS / 60000),
      max_audio_mb_per_session: Math.round(MAX_AUDIO_BYTES_PER_SESSION / 1024 / 1024),
      max_tts_requests_per_session: MAX_TTS_REQUESTS_PER_SESSION,
      max_tts_queue: MAX_TTS_QUEUE,
      max_tts_chars: MAX_TTS_CHARS,
      idle_timeout_seconds: Math.round(IDLE_TIMEOUT_MS / 1000),
      soniox_finalize_timeout_seconds: Math.round(SONIOX_FINALIZE_TIMEOUT_MS / 1000),
    },
    usage: usageSnapshot(username),
    security: {
      http_headers: true,
      websocket_origin_check: true,
      websocket_per_message_deflate: false,
      session_cookie: "HttpOnly; SameSite=Strict" + (IS_PRODUCTION ? "; Secure" : ""),
    },
  });
});

app.post("/api/login", (req, res) => {
  const ip = getClientIp(req);
  if (isLoginRateLimited(ip)) {
    return res.status(429).json({ error: "Príliš veľa pokusov. Skús to neskôr." });
  }

  const user = findAccessUser(req.body?.code);
  if (!user) {
    console.warn(`[auth] Neúspešný login z ${ip}`);
    return res.status(401).json({ error: "Nesprávny prístupový kód." });
  }

  resetLoginAttempts(ip);
  const session = createSession(user.username);
  res.setHeader("Set-Cookie", serializeSessionCookie(session));
  res.json({ authenticated: true, username: session.username, usage: usageSnapshot(session.username) });
});

app.post("/api/logout", (req, res) => {
  const session = getSessionFromRequest(req);
  if (session) destroySession(session.id);
  res.setHeader("Set-Cookie", clearSessionCookie());
  res.json({ ok: true });
});

app.get("/api/voices", requireSession, async (req, res) => {
  try {
    const voices = await fetchTtsVoices();
    res.json({ voices, model: cachedTtsModelId, fallback: false });
  } catch (err) {
    console.error("Nepodarilo sa načítať Soniox TTS hlasy:", err);
    res.json({
      voices: FALLBACK_TTS_VOICES,
      model: "tts-rt-v1",
      fallback: true,
    });
  }
});

app.post("/api/preview-voice", requireSession, async (req, res) => {
  try {
    if (isPreviewRateLimited(req.authSession.username)) {
      addUsage(req.authSession.username, { deniedEvents: 1 });
      return res.status(429).json({ error: "Limit ukážok hlasu za hodinu bol vyčerpaný." });
    }
    if (!canUseMoreTts(req.authSession.username, 0, 1)) {
      addUsage(req.authSession.username, { deniedEvents: 1 });
      return res.status(429).json({ error: "Denný TTS limit používateľa bol vyčerpaný." });
    }
    const audioBuffer = await synthesizeSpeechBuffer({
      text: req.body?.text || "Ahoj, toto je ukážka zvoleného hlasu.",
      language: req.body?.language || "sk",
      voice: req.body?.voice || "Adrian",
    });

    if (!canUseMoreTts(req.authSession.username, audioBuffer.length)) {
      addUsage(req.authSession.username, { deniedEvents: 1 });
      return res.status(429).json({ error: "Denný limit TTS audia bol vyčerpaný." });
    }
    addUsage(req.authSession.username, { ttsRequests: 1, ttsAudioBytes: audioBuffer.length });
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.send(audioBuffer);
  } catch (err) {
    console.error("Chyba preview hlasu:", err);
    res.status(500).json({
      error: err.message || "Nepodarilo sa vygenerovať ukážku hlasu.",
    });
  }
});

app.use(express.static("public", { extensions: ["html"] }));

server.on("upgrade", (req, socket, head) => {
  if (!verifyWebSocketOrigin(req)) {
    return rejectUpgrade(socket, 403, "Forbidden");
  }

  const session = getSessionFromRequest(req);
  if (!session) {
    return rejectUpgrade(socket, 401, "Unauthorized");
  }

  const ip = getClientIp(req);
  if (activeWsTotal >= MAX_ACTIVE_WS_TOTAL) {
    addUsage(session.username, { deniedEvents: 1 });
    return rejectUpgrade(socket, 429, "Too Many Connections");
  }
  if (getActiveIpCount(ip) >= MAX_ACTIVE_WS_PER_IP) {
    addUsage(session.username, { deniedEvents: 1 });
    return rejectUpgrade(socket, 429, "Too Many Connections");
  }
  if (!canStartUserSession(session.username)) {
    addUsage(session.username, { deniedEvents: 1 });
    return rejectUpgrade(socket, 429, "Daily Session Limit");
  }

  req.authSession = session;
  req.clientIp = ip;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (clientWs, req) => {
  const authSession = req.authSession;
  const previousWs = activeWsByUser.get(authSession.username);
  if (previousWs && previousWs.readyState === WebSocket.OPEN) {
    safeSendJson(previousWs, {
      type: "error",
      message: "Bol otvorený nový preklad v inom okne. Toto spojenie sa ukončí.",
    });
    previousWs.close(4008, "superseded");
  }
  activeWsByUser.set(authSession.username, clientWs);
  const clientIp = req.clientIp || getClientIp(req);
  activeWsTotal += 1;
  incrementActiveIp(clientIp);
  addUsage(authSession.username, { sessions: 1 });

  const sessionId = createSessionId();
  const sessionStartedAt = performance.now();
  const sessionHardDeadline = Date.now() + MAX_SESSION_MS;

  const metrics = {
    configReceivedAt: null,
    firstAudioAt: null,
    sonioxConnectStartAt: null,
    sonioxOpenAt: null,
    firstSonioxMessageAt: null,
    firstOriginalTokenAt: null,
    firstTranslationTokenAt: null,
    firstFinalOriginalAt: null,
    firstFinalTranslationAt: null,
    firstEndpointMarkerAt: null,
    firstTtsScheduledAt: null,
    firstTtsStartedAt: null,
    firstTtsReadyAt: null,
    firstPlayAudioSentAt: null,
    firstPlaybackDoneAt: null,
    firstTtsGenerationMs: null,
    lastTtsGenerationMs: null,
    lastFailureReason: null,
    audioChunks: 0,
    audioBytes: 0,
    sonioxMessages: 0,
    originalTokens: 0,
    translationTokens: 0,
    finalOriginalTokens: 0,
    finalTranslationTokens: 0,
    streamMarkers: 0,
    endpointMarkers: 0,
    ttsRequests: 0,
    ttsAudioBytes: 0,
    playAudioSent: 0,
    playbackDone: 0,
    ttsErrors: 0,
  };

  function metricPayload(extra = {}) {
    return {
      session_id: sessionId,
      user: authSession.username,
      t_ms: elapsedMs(sessionStartedAt),
      ...extra,
    };
  }

  function logMetric(event, extra = {}) {
    console.log(`[metrics] ${event} ${JSON.stringify(metricPayload(extra))}`);
  }

  function sinceSessionStart(ts) {
    if (!ts) return null;
    return Math.max(0, Math.round(ts - sessionStartedAt));
  }

  function since(ts) {
    return ts ? elapsedMs(ts) : null;
  }

  function recordFirstMetric(key, event, extra = {}) {
    if (!metrics[key]) {
      metrics[key] = performance.now();
      logMetric(event, {
        ms_since_config: since(metrics.configReceivedAt),
        ms_since_first_audio: since(metrics.firstAudioAt),
        ms_since_soniox_open: since(metrics.sonioxOpenAt),
        ...extra,
      });
    }
  }

  function getMetricsSummary() {
    const firstTokenAt = [metrics.firstOriginalTokenAt, metrics.firstTranslationTokenAt]
      .filter(Boolean)
      .sort((a, b) => a - b)[0] || null;
    return {
      duration_ms: elapsedMs(sessionStartedAt),
      tts_transport: TTS_TRANSPORT,
      soniox_region: inferSonioxRegion(),
      soniox_stt_host: endpointHost(SONIOX_STT_URL),
      audio_chunks: metrics.audioChunks,
      audio_kb: formatKb(metrics.audioBytes),
      soniox_messages: metrics.sonioxMessages,
      original_tokens: metrics.originalTokens,
      translation_tokens: metrics.translationTokens,
      final_original_tokens: metrics.finalOriginalTokens,
      final_translation_tokens: metrics.finalTranslationTokens,
      stream_markers: metrics.streamMarkers,
      endpoint_markers: metrics.endpointMarkers,
      tts_requests: metrics.ttsRequests,
      tts_audio_kb: formatKb(metrics.ttsAudioBytes),
      play_audio_sent: metrics.playAudioSent,
      playback_done: metrics.playbackDone,
      tts_errors: metrics.ttsErrors,
      failure_reason: metrics.lastFailureReason,
      first_audio_ms: sinceSessionStart(metrics.firstAudioAt),
      first_token_ms: sinceSessionStart(firstTokenAt),
      first_soniox_message_ms: sinceSessionStart(metrics.firstSonioxMessageAt),
      first_original_token_ms: sinceSessionStart(metrics.firstOriginalTokenAt),
      first_translation_token_ms: sinceSessionStart(metrics.firstTranslationTokenAt),
      first_final_original_ms: sinceSessionStart(metrics.firstFinalOriginalAt),
      first_final_translation_ms: sinceSessionStart(metrics.firstFinalTranslationAt),
      first_tts_ready_ms: sinceSessionStart(metrics.firstTtsReadyAt),
      first_play_audio_sent_ms: sinceSessionStart(metrics.firstPlayAudioSentAt),
      first_playback_done_ms: sinceSessionStart(metrics.firstPlaybackDoneAt),
      first_tts_generation_ms: metrics.firstTtsGenerationMs,
      last_tts_generation_ms: metrics.lastTtsGenerationMs,
    };
  }

  logMetric("client_connected", {
    client_ip: clientIp,
    user: authSession.username,
    user_agent: String(req?.headers?.["user-agent"] || "unknown").slice(0, 140),
  });

  let clientActive = true;
  let sonioxSttWs = null;

  let langA = "sk";
  let langB = "de";
  let selectedTtsVoice = "Adrian";
  let ttsEnabled = true;
  let endpointDelayMs = 500;
  let outputMode = "speaker";
  let sessionAuthorized = true;
  let acceptAudio = false;
  let sonioxFinalizing = false;
  let sessionFinished = false;
  let sessionFinishRequested = false;
  let sessionFinishReason = "finished";
  let sonioxFinalizeTimer = null;
  let droppedEarlyAudioChunks = 0;
  let blockedUntilReadyChunks = 0;
  let blockedDuringTtsChunks = 0;
  let blockedDuringFinalizingChunks = 0;
  let sessionLimitTimer = null;
  let noConfigTimer = null;
  let idleTimer = null;
  let heartbeatTimer = null;
  let sonioxConnectTimer = null;
  let ttsPlaybackTimer = null;
  let lastActivityAt = Date.now();

  clientWs.isAlive = true;
  clientWs.on("pong", () => {
    clientWs.isAlive = true;
  });

  noConfigTimer = setTimeout(() => {
    if (!metrics.configReceivedAt && clientWs.readyState === WebSocket.OPEN) {
      addUsage(authSession.username, { deniedEvents: 1 });
      safeSendJson(clientWs, { type: "error", message: "Konfigurácia neprišla včas. Spojenie sa ukončí." });
      clientWs.close(4000, "config timeout");
    }
  }, NO_CONFIG_TIMEOUT_MS);

  heartbeatTimer = setInterval(() => {
    if (clientWs.isAlive === false) {
      logMetric("client_heartbeat_failed");
      clientWs.terminate();
      return;
    }
    clientWs.isAlive = false;
    try { clientWs.ping(); } catch (err) { clientWs.terminate(); }
  }, WS_HEARTBEAT_MS);

  idleTimer = setInterval(() => {
    if (!clientActive || sessionFinished) return;
    const idleFor = Date.now() - lastActivityAt;
    if (idleFor > IDLE_TIMEOUT_MS && !ttsInFlight && !isMuted) {
      logMetric("idle_timeout", { idle_ms: idleFor });
      safeSendJson(clientWs, { type: "error", message: "Spojenie bolo neaktívne príliš dlho. Konverzácia sa ukončí." });
      finishClientSession("idle_timeout");
    }
  }, Math.min(30000, Math.max(5000, Math.floor(IDLE_TIMEOUT_MS / 3))));

  let isMuted = false;

  let finalOriginalText = "";
  let finalTranslationText = "";
  let nonFinalOriginalText = "";
  let nonFinalTranslationText = "";

  let pendingTtsText = "";
  let pendingTtsLanguage = langB;
  let pendingTtsTimer = null;

  let ttsQueue = [];
  let ttsInFlight = false;

  clientWs.on("message", (message, isBinary) => {
    lastActivityAt = Date.now();
    const messageBytes = bytesLength(message);
    if (messageBytes > MAX_WS_MESSAGE_BYTES) {
      safeSendJson(clientWs, { type: "error", message: "Správa je príliš veľká." });
      return clientWs.close(1009, "message too large");
    }

    if (!isBinary) {
      handleClientJsonMessage(message.toString());
      return;
    }

    if (
      sessionAuthorized &&
      acceptAudio &&
      !isMuted &&
      !sonioxFinalizing &&
      sonioxSttWs &&
      sonioxSttWs.readyState === WebSocket.OPEN
    ) {
      const chunkBytes = messageBytes;
      metrics.audioChunks += 1;
      metrics.audioBytes += chunkBytes;

      if (!canUseMoreAudio(authSession.username, chunkBytes)) {
        addUsage(authSession.username, { deniedEvents: 1 });
        logMetric("daily_audio_limit_exceeded", { audio_kb: formatKb(getUserUsage(authSession.username).audioBytes) });
        safeSendJson(clientWs, {
          type: "error",
          message: "Denný limit audia používateľa bol vyčerpaný.",
        });
        finishClientSession("daily_audio_limit");
        return;
      }

      addUsage(authSession.username, { audioBytes: chunkBytes });

      if (metrics.audioBytes > MAX_AUDIO_BYTES_PER_SESSION) {
        logMetric("audio_limit_exceeded", { audio_kb: formatKb(metrics.audioBytes) });
        safeSendJson(clientWs, {
          type: "error",
          message: "Dosiahnutý limit audia pre jednu session. Konverzácia sa ukončí.",
        });
        finishClientSession("audio_limit");
        return;
      }

      if (!metrics.firstAudioAt) {
        metrics.firstAudioAt = performance.now();
        logMetric("first_audio_chunk_from_browser", {
          bytes: chunkBytes,
          ms_since_config: since(metrics.configReceivedAt),
          ms_since_soniox_open: since(metrics.sonioxOpenAt),
        });
      }

      if (metrics.audioChunks % 100 === 0) {
        logMetric("audio_stream_progress", {
          chunks: metrics.audioChunks,
          audio_kb: formatKb(metrics.audioBytes),
        });
      }

      sonioxSttWs.send(message, { binary: true });
      return;
    }

    if (isBinary && !sessionFinished) {
      let reason = "blocked_unknown";
      if (isMuted) {
        reason = "tts_muted";
        blockedDuringTtsChunks += 1;
      } else if (sonioxFinalizing || sessionFinishRequested) {
        reason = "finalizing";
        blockedDuringFinalizingChunks += 1;
      } else if (!acceptAudio || !sonioxSttWs || sonioxSttWs.readyState !== WebSocket.OPEN) {
        reason = "soniox_not_ready";
        blockedUntilReadyChunks += 1;
        droppedEarlyAudioChunks += 1;
      } else {
        blockedUntilReadyChunks += 1;
      }

      const blockedTotal = blockedUntilReadyChunks + blockedDuringTtsChunks + blockedDuringFinalizingChunks;
      if (blockedTotal <= 3 || blockedTotal % 25 === 0) {
        logMetric("audio_chunk_blocked", {
          reason,
          message_bytes: messageBytes,
          blocked_until_ready_chunks: blockedUntilReadyChunks,
          blocked_during_tts_chunks: blockedDuringTtsChunks,
          blocked_during_finalizing_chunks: blockedDuringFinalizingChunks,
        });
      }
    }
  });

  clientWs.on("close", () => {
    logMetric("client_disconnected", { summary: getMetricsSummary(), usage: usageSnapshot(authSession.username) });
    clientActive = false;
    if (activeWsByUser.get(authSession.username) === clientWs) {
      activeWsByUser.delete(authSession.username);
    }
    if (activeWsTotal > 0) activeWsTotal -= 1;
    decrementActiveIp(clientIp);
    if (sessionLimitTimer) clearTimeout(sessionLimitTimer);
    if (noConfigTimer) clearTimeout(noConfigTimer);
    if (idleTimer) clearInterval(idleTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sonioxConnectTimer) clearTimeout(sonioxConnectTimer);
    if (sonioxFinalizeTimer) clearTimeout(sonioxFinalizeTimer);
    if (ttsPlaybackTimer) clearTimeout(ttsPlaybackTimer);
    clearPendingTtsTimer();
    ttsQueue = [];
    closeSonioxStt({ graceful: true });
  });

  function handleClientJsonMessage(raw) {
    if (!raw.trim()) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      console.error("Neplatná JSON správa od klienta:", err);
      safeSendJson(clientWs, {
        type: "error",
        message: "Neplatná JSON správa z prehliadača.",
      });
      return;
    }

    if (msg.type === "config") {
      if (noConfigTimer) {
        clearTimeout(noConfigTimer);
        noConfigTimer = null;
      }
      sessionAuthorized = true;
      langA = normalizeLanguageCode(msg.language_a || "sk") || "sk";
      langB = normalizeLanguageCode(msg.language_b || "de") || "de";
      selectedTtsVoice = normalizeVoiceId(msg.tts_voice || "Adrian");
      ttsEnabled = normalizeBoolean(msg.tts_enabled, true);
      outputMode = normalizeOutputMode(msg.output_mode);
      endpointDelayMs = normalizeEndpointDelay(msg.endpoint_delay_ms);
      metrics.configReceivedAt = performance.now();

      logMetric("session_config_received", {
        language_a: langA,
        language_b: langB,
        voice: selectedTtsVoice,
        tts_enabled: ttsEnabled,
        output_mode: outputMode,
        endpoint_delay_ms: endpointDelayMs,
        soniox_region: inferSonioxRegion(),
        soniox_stt_host: endpointHost(SONIOX_STT_URL),
        ms_since_client_connected: elapsedMs(sessionStartedAt),
      });

      resetTextState();
      clearPendingTtsTimer();
      ttsQueue = [];
      ttsInFlight = false;
      isMuted = false;
      safeSendJson(clientWs, { type: "unmute" });
      safeSendJson(clientWs, {
        type: "stt_connecting",
        soniox_region: inferSonioxRegion(),
        soniox_stt_host: endpointHost(SONIOX_STT_URL),
      });
      if (sessionLimitTimer) clearTimeout(sessionLimitTimer);
      sessionLimitTimer = setTimeout(() => {
        logMetric("session_time_limit_reached", getMetricsSummary());
        safeSendJson(clientWs, {
          type: "error",
          message: "Dosiahnutý časový limit jednej konverzácie.",
        });
        finishClientSession("time_limit");
      }, Math.max(1000, sessionHardDeadline - Date.now()));
      startSonioxStt(langA, langB);
      return;
    }

    if (msg.type === "update_settings") {
      selectedTtsVoice = normalizeVoiceId(msg.tts_voice || selectedTtsVoice);
      ttsEnabled = normalizeBoolean(msg.tts_enabled, ttsEnabled);
      outputMode = normalizeOutputMode(msg.output_mode || outputMode);

      if (!ttsEnabled) {
        clearPendingTtsTimer();
        ttsQueue = [];
        ttsInFlight = false;
        if (isMuted) {
          isMuted = false;
          safeSendJson(clientWs, { type: "unmute" });
        }
      }

      safeSendJson(clientWs, {
        type: "settings_updated",
        tts_voice: selectedTtsVoice,
        tts_enabled: ttsEnabled,
        output_mode: outputMode,
      });
      return;
    }

    if (msg.type === "clear_text") {
      resetTextState();
      safeSendJson(clientWs, {
        type: "token",
        original_text: "",
        translated_text: "",
      });
      return;
    }

    if (msg.type === "client_stop") {
      finishClientSession("client_stop");
      return;
    }

    if (msg.type === "playback_done") {
      handlePlaybackDone();
      return;
    }
  }

  function resetTextState() {
    finalOriginalText = "";
    finalTranslationText = "";
    nonFinalOriginalText = "";
    nonFinalTranslationText = "";
    pendingTtsText = "";
    pendingTtsLanguage = langB === "auto" ? langA : langB;
  }

  function clearPendingTtsTimer() {
    if (pendingTtsTimer) {
      clearTimeout(pendingTtsTimer);
      pendingTtsTimer = null;
    }
  }

  function closeSonioxStt(options = {}) {
    const { graceful = false } = options;
    if (!sonioxSttWs) return;

    if (sonioxSttWs.readyState === WebSocket.OPEN) {
      if (graceful && !sonioxFinalizing) {
        sonioxFinalizing = true;
        acceptAudio = false;
        try {
          sonioxSttWs.send("");
          logMetric("soniox_end_of_audio_sent", {
            finalize_timeout_ms: SONIOX_FINALIZE_TIMEOUT_MS,
          });
        } catch (err) {
          logMetric("soniox_end_of_audio_send_failed", {
            message: err?.message || String(err),
          });
        }
        return;
      }
      sonioxSttWs.close();
    } else if (sonioxSttWs.readyState === WebSocket.CONNECTING) {
      sonioxSttWs.terminate?.();
    } else if (sonioxSttWs.readyState === WebSocket.CLOSING || sonioxSttWs.readyState === WebSocket.CLOSED) {
      // Nothing else to do. The close handler will finish the client session when needed.
    }
  }

  function completeClientSession(reason = "finished") {
    if (sessionFinished) return;
    sessionFinished = true;
    acceptAudio = false;
    metrics.lastFailureReason = reason;

    if (sonioxFinalizeTimer) {
      clearTimeout(sonioxFinalizeTimer);
      sonioxFinalizeTimer = null;
    }
    if (sessionLimitTimer) {
      clearTimeout(sessionLimitTimer);
      sessionLimitTimer = null;
    }

    clearPendingTtsTimer();
    ttsQueue = [];

    const summary = getMetricsSummary();
    lastSessionSummaryByUser.set(authSession.username, summary);

    logMetric("client_session_completed", {
      reason,
      summary,
      dropped_early_audio_chunks: droppedEarlyAudioChunks,
      blocked_until_ready_chunks: blockedUntilReadyChunks,
      blocked_during_tts_chunks: blockedDuringTtsChunks,
      blocked_during_finalizing_chunks: blockedDuringFinalizingChunks,
      usage: usageSnapshot(authSession.username),
    });

    safeSendJson(clientWs, {
      type: "session_finished",
      reason,
      summary,
    });

    setTimeout(() => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1000, reason);
    }, 120);
  }

  function finishClientSession(reason = "finished") {
    if (sessionFinishRequested || sessionFinished) return;
    sessionFinishRequested = true;
    sessionFinishReason = reason;
    acceptAudio = false;
    clearPendingTtsTimer();

    safeSendJson(clientWs, {
      type: "stream_finishing",
      reason,
      finalize_timeout_ms: SONIOX_FINALIZE_TIMEOUT_MS,
    });

    logMetric("client_session_finishing", {
      reason,
      has_soniox_ws: Boolean(sonioxSttWs),
      soniox_ready_state: sonioxSttWs?.readyState ?? null,
    });

    if (!sonioxSttWs || sonioxSttWs.readyState === WebSocket.CLOSED) {
      completeClientSession(reason);
      return;
    }

    closeSonioxStt({ graceful: true });

    sonioxFinalizeTimer = setTimeout(() => {
      logMetric("soniox_finalize_timeout", {
        reason,
        timeout_ms: SONIOX_FINALIZE_TIMEOUT_MS,
        soniox_ready_state: sonioxSttWs?.readyState ?? null,
      });
      if (sonioxSttWs && sonioxSttWs.readyState === WebSocket.OPEN) {
        try { sonioxSttWs.close(); } catch (err) { /* ignore */ }
      } else if (sonioxSttWs && sonioxSttWs.readyState === WebSocket.CONNECTING) {
        sonioxSttWs.terminate?.();
      }
      completeClientSession(reason + "_finalize_timeout");
    }, SONIOX_FINALIZE_TIMEOUT_MS);
  }

  function startSonioxStt(languageA, languageB) {
    closeSonioxStt();
    metrics.sonioxConnectStartAt = performance.now();
    logMetric("soniox_stt_connect_start", {
      soniox_stt_url: SONIOX_STT_URL,
      soniox_region: inferSonioxRegion(),
    });

    sonioxSttWs = new WebSocket(SONIOX_STT_URL);
    if (sonioxConnectTimer) clearTimeout(sonioxConnectTimer);
    sonioxConnectTimer = setTimeout(() => {
      if (sonioxSttWs && sonioxSttWs.readyState === WebSocket.CONNECTING) {
        logMetric("soniox_connect_timeout", { timeout_ms: SONIOX_CONNECT_TIMEOUT_MS });
        safeSendJson(clientWs, { type: "error", message: "Soniox sa nepripojil včas. Skús to znova." });
        sonioxSttWs.terminate?.();
        finishClientSession("soniox_connect_timeout");
      }
    }, SONIOX_CONNECT_TIMEOUT_MS);

    const autoDetectOtherLanguage = languageB === "auto";
    const languageHints = autoDetectOtherLanguage
      ? []
      : Array.from(new Set([languageA, languageB].filter(Boolean)));
    const translationConfig = autoDetectOtherLanguage
      ? {
          type: "one_way",
          target_language: languageA,
        }
      : {
          type: "two_way",
          language_a: languageA,
          language_b: languageB,
        };

    const initMsg = {
      api_key: process.env.SONIOX_API_KEY,
      model: "stt-rt-v4",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      ...(languageHints.length ? { language_hints: languageHints } : {}),
      enable_language_identification: true,
      enable_endpoint_detection: true,
      finalize_on_end: true,
      max_endpoint_delay_ms: endpointDelayMs,
      translation: translationConfig,
    };

    sonioxSttWs.on("open", () => {
      if (sonioxConnectTimer) {
        clearTimeout(sonioxConnectTimer);
        sonioxConnectTimer = null;
      }
      metrics.sonioxOpenAt = performance.now();
      logMetric("soniox_stt_open", {
        connect_ms: since(metrics.sonioxConnectStartAt),
        ms_since_config: since(metrics.configReceivedAt),
      });

      sonioxSttWs.send(JSON.stringify(initMsg));
      acceptAudio = true;
      safeSendJson(clientWs, {
        type: "server_ready",
        endpoint_delay_ms: endpointDelayMs,
        soniox_region: inferSonioxRegion(),
        soniox_stt_host: endpointHost(SONIOX_STT_URL),
      });
      logMetric("soniox_stt_config_sent", {
        model: initMsg.model,
        audio_format: initMsg.audio_format,
        sample_rate: initMsg.sample_rate,
        endpoint_delay_ms: initMsg.max_endpoint_delay_ms,
        translation_type: initMsg.translation.type,
        language_a: initMsg.translation.language_a || null,
        language_b: initMsg.translation.language_b || null,
        target_language: initMsg.translation.target_language || null,
        language_hints: initMsg.language_hints || [],
      });
    });

    sonioxSttWs.on("message", (data) => {
      let result;
      try {
        result = JSON.parse(data.toString());
      } catch (err) {
        console.error("Soniox STT vrátil nečitateľnú správu:", data.toString());
        return;
      }

      metrics.sonioxMessages += 1;
      if (!metrics.firstSonioxMessageAt) {
        metrics.firstSonioxMessageAt = performance.now();
        logMetric("first_soniox_message", {
          ms_since_first_audio: since(metrics.firstAudioAt),
          ms_since_soniox_open: since(metrics.sonioxOpenAt),
          tokens: Array.isArray(result.tokens) ? result.tokens.length : 0,
        });
      }

      if (result.error_code || result.error_message) {
        logMetric("soniox_stt_error", {
          error_code: result.error_code || null,
          error_message: result.error_message || null,
        });
        console.error("Soniox STT chyba:", result);
        safeSendJson(clientWs, {
          type: "error",
          message: result.error_message || "Chyba rozpoznávania reči.",
        });
        return;
      }

      processSonioxTokens(result);
      if (result.finished) {
        logMetric("soniox_finished", getMetricsSummary());
        acceptAudio = false;
        completeClientSession(sessionFinishRequested ? "soniox_finished" : "soniox_finished_unrequested");
      }
    });

    sonioxSttWs.on("error", (err) => {
      logMetric("soniox_stt_ws_error", {
        message: err?.message || String(err),
      });
      console.error("Chyba Soniox STT WebSocketu:", err);
      safeSendJson(clientWs, {
        type: "error",
        message: "Chyba spojenia so Soniox STT.",
      });
    });

    sonioxSttWs.on("close", (code, reason) => {
      if (sonioxConnectTimer) {
        clearTimeout(sonioxConnectTimer);
        sonioxConnectTimer = null;
      }
      logMetric("soniox_stt_closed", {
        code,
        reason: reason ? reason.toString().slice(0, 160) : "",
        summary: getMetricsSummary(),
      });
      acceptAudio = false;
      sonioxSttWs = null;
      if (clientActive && !sessionFinished) {
        if (sessionFinishRequested || sonioxFinalizing) {
          completeClientSession("soniox_closed");
        } else if (metrics.configReceivedAt) {
          safeSendJson(clientWs, {
            type: "error",
            message: "Soniox STT spojenie sa ukončilo.",
          });
          completeClientSession("soniox_closed_unexpectedly");
        }
      }
    });
  }

  function processSonioxTokens(result) {
    const tokens = Array.isArray(result.tokens) ? result.tokens : [];
    if (!tokens.length) return;

    let nextNonFinalOriginal = "";
    let nextNonFinalTranslation = "";
    let finalTranslationDelta = "";
    const targetLanguage = langB === "auto" ? langA : langB;
    let detectedTranslationLanguage = pendingTtsLanguage || targetLanguage;

    for (const token of tokens) {
      if (!token || typeof token.text !== "string") continue;

      const text = token.text;
      const status = token.translation_status || "original";
      const isTranslation = status === "translation";
      const isFinal = Boolean(token.is_final);

      if (isStreamMarker(text)) {
        metrics.streamMarkers += 1;
        if (text === "<end>") {
          metrics.endpointMarkers += 1;
          recordFirstMetric("firstEndpointMarkerAt", "first_endpoint_marker", {
            marker: text,
            status,
            is_final: isFinal,
          });
        }
        logMetric("soniox_stream_marker", {
          marker: text,
          status,
          is_final: isFinal,
          language: token.language || null,
          source_language: token.source_language || null,
        });
        continue;
      }

      if (isTranslation) {
        metrics.translationTokens += 1;
        recordFirstMetric("firstTranslationTokenAt", "first_translation_token", {
          is_final: isFinal,
          chars: text.length,
          language: token.language || null,
          source_language: token.source_language || null,
        });
        if (isFinal) {
          metrics.finalTranslationTokens += 1;
          recordFirstMetric("firstFinalTranslationAt", "first_final_translation_token", {
            chars: text.length,
            language: token.language || null,
            source_language: token.source_language || null,
          });
        }
        const tokenLanguage = normalizeLanguageCode(token.language);
        const sourceLanguage = normalizeLanguageCode(token.source_language);

        if (tokenLanguage) {
          detectedTranslationLanguage = tokenLanguage;
        } else if (sourceLanguage === langA) {
          detectedTranslationLanguage = targetLanguage;
        } else if (sourceLanguage === langB) {
          detectedTranslationLanguage = langA;
        }

        if (isFinal) {
          finalTranslationText += text;
          finalTranslationDelta += text;
        } else {
          nextNonFinalTranslation += text;
        }
      } else {
        metrics.originalTokens += 1;
        recordFirstMetric("firstOriginalTokenAt", "first_original_token", {
          is_final: isFinal,
          chars: text.length,
          language: token.language || null,
        });
        if (isFinal) {
          metrics.finalOriginalTokens += 1;
          recordFirstMetric("firstFinalOriginalAt", "first_final_original_token", {
            chars: text.length,
            language: token.language || null,
          });
          finalOriginalText += text;
        } else {
          nextNonFinalOriginal += text;
        }
      }
    }

    finalOriginalText = truncateText(finalOriginalText);
    finalTranslationText = truncateText(finalTranslationText);
    nonFinalOriginalText = nextNonFinalOriginal;
    nonFinalTranslationText = nextNonFinalTranslation;

    const originalText = truncateText(finalOriginalText + nonFinalOriginalText);
    const translatedText = truncateText(finalTranslationText + nonFinalTranslationText);

    safeSendJson(clientWs, {
      type: "token",
      original_text: originalText,
      translated_text: translatedText,
      final_original_text: finalOriginalText,
      final_translated_text: finalTranslationText,
      tts_enabled: ttsEnabled,
    });

    if (ttsEnabled && finalTranslationDelta.trim()) {
      scheduleTts(finalTranslationDelta, detectedTranslationLanguage);
    }
  }

  function scheduleTts(text, language) {
    if (!ttsEnabled) return;

    recordFirstMetric("firstTtsScheduledAt", "first_tts_scheduled", {
      chars: String(text || "").trim().length,
      language: normalizeLanguageCode(language) || pendingTtsLanguage || null,
      ms_since_first_final_translation: since(metrics.firstFinalTranslationAt),
    });

    pendingTtsText += text;
    pendingTtsLanguage =
      normalizeLanguageCode(language) ||
      pendingTtsLanguage ||
      (langB === "auto" ? langA : langB);

    clearPendingTtsTimer();
    pendingTtsTimer = setTimeout(() => {
      const textToSpeak = pendingTtsText.trim();
      const languageToSpeak = pendingTtsLanguage;

      pendingTtsText = "";
      pendingTtsTimer = null;

      if (textToSpeak) {
        enqueueTts(textToSpeak, languageToSpeak);
      }
    }, 420);
  }

  function enqueueTts(text, language) {
    if (!ttsEnabled) return;
    if (metrics.ttsRequests >= MAX_TTS_REQUESTS_PER_SESSION || !canUseMoreTts(authSession.username, 0, 1)) {
      logMetric("tts_limit_reached", { limit: MAX_TTS_REQUESTS_PER_SESSION });
      return;
    }
    if (!canUseMoreTts(authSession.username, 0, 1)) {
      addUsage(authSession.username, { deniedEvents: 1 });
      logMetric("daily_tts_limit_reached", usageSnapshot(authSession.username));
      return;
    }

    const chunks = chunkTextForTts(text, MAX_TTS_CHARS);
    for (const chunk of chunks) {
      if (ttsQueue.length >= MAX_TTS_QUEUE) {
        ttsQueue.shift();
        logMetric("tts_queue_trimmed", { max_queue: MAX_TTS_QUEUE });
      }
      ttsQueue.push({
        text: chunk,
        language:
          normalizeLanguageCode(language) || (langB === "auto" ? langA : langB),
        voice: selectedTtsVoice,
      });
    }

    logMetric("tts_enqueued", {
      chars: String(text || "").length,
      language: normalizeLanguageCode(language) || (langB === "auto" ? langA : langB),
      voice: selectedTtsVoice,
      queue_length: ttsQueue.length,
    });

    if (!ttsInFlight) {
      processNextTts();
    }
  }

  async function processNextTts() {
    if (!clientActive || ttsInFlight || !ttsEnabled) return;

    const next = ttsQueue.shift();

    if (!next) {
      if (isMuted) {
        isMuted = false;
        safeSendJson(clientWs, { type: "unmute" });
      }
      return;
    }

    if (metrics.ttsRequests >= MAX_TTS_REQUESTS_PER_SESSION) {
      addUsage(authSession.username, { deniedEvents: 1 });
      logMetric("tts_request_limit_blocked", { limit: MAX_TTS_REQUESTS_PER_SESSION, daily_usage: usageSnapshot(authSession.username) });
      ttsQueue = [];
      if (isMuted) {
        isMuted = false;
        safeSendJson(clientWs, { type: "unmute" });
      }
      return;
    }

    ttsInFlight = true;
    const shouldMuteForPlayback = outputMode === "speaker";
    if (shouldMuteForPlayback) {
      isMuted = true;
      safeSendJson(clientWs, { type: "mute", output_mode: outputMode });
    } else {
      safeSendJson(clientWs, { type: "playback_mode", output_mode: outputMode, microphone_muted: false });
    }

    const ttsRequestId = metrics.ttsRequests + 1;
    const ttsStartedAt = performance.now();
    metrics.ttsRequests = ttsRequestId;
    addUsage(authSession.username, { ttsRequests: 1 });
    recordFirstMetric("firstTtsStartedAt", "first_tts_request_started", {
      tts_request_id: ttsRequestId,
      chars: String(next.text || "").length,
      language: next.language,
      voice: next.voice,
      queue_remaining: ttsQueue.length,
    });
    logMetric("tts_request_start", {
      tts_request_id: ttsRequestId,
      chars: String(next.text || "").length,
      language: next.language,
      voice: next.voice,
      queue_remaining: ttsQueue.length,
    });

    try {
      const audioBuffer = await synthesizeSpeechBuffer(next);
      if (metrics.ttsAudioBytes + audioBuffer.length > MAX_TTS_AUDIO_BYTES_PER_SESSION) {
        addUsage(authSession.username, { deniedEvents: 1 });
        logMetric("tts_audio_session_limit_exceeded", { audio_kb: formatKb(metrics.ttsAudioBytes + audioBuffer.length) });
        safeSendJson(clientWs, { type: "error", message: "Limit TTS audia pre túto konverzáciu bol vyčerpaný." });
        ttsQueue = [];
        ttsInFlight = false;
        if (isMuted) { isMuted = false; safeSendJson(clientWs, { type: "unmute" }); }
        return;
      }
      if (!canUseMoreTts(authSession.username, audioBuffer.length)) {
        addUsage(authSession.username, { deniedEvents: 1 });
        logMetric("tts_audio_daily_limit_exceeded", usageSnapshot(authSession.username));
        safeSendJson(clientWs, { type: "error", message: "Denný limit TTS audia bol vyčerpaný." });
        ttsQueue = [];
        ttsInFlight = false;
        if (isMuted) { isMuted = false; safeSendJson(clientWs, { type: "unmute" }); }
        return;
      }
      metrics.ttsAudioBytes += audioBuffer.length;
      addUsage(authSession.username, { ttsAudioBytes: audioBuffer.length });
      const generationMs = elapsedMs(ttsStartedAt);
      if (!metrics.firstTtsReadyAt) {
        metrics.firstTtsReadyAt = performance.now();
      }
      if (metrics.firstTtsGenerationMs === null) {
        metrics.firstTtsGenerationMs = generationMs;
      }
      metrics.lastTtsGenerationMs = generationMs;
      logMetric("tts_audio_ready", {
        tts_request_id: ttsRequestId,
        generation_ms: generationMs,
        audio_bytes: audioBuffer.length,
        audio_kb: formatKb(audioBuffer.length),
        language: next.language,
        voice: next.voice,
        output_mode: outputMode,
        ms_since_first_final_translation: since(metrics.firstFinalTranslationAt),
      });

      safeSendJson(clientWs, {
        type: "play_audio",
        mime: "audio/wav",
        size: audioBuffer.length,
        voice: next.voice,
        language: next.language,
        tts_request_id: ttsRequestId,
        generation_ms: generationMs,
        output_mode: outputMode,
      });
      metrics.playAudioSent += 1;
      recordFirstMetric("firstPlayAudioSentAt", "first_play_audio_sent", {
        tts_request_id: ttsRequestId,
        generation_ms: generationMs,
        audio_bytes: audioBuffer.length,
      });

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(audioBuffer, { binary: true });
        logMetric("tts_audio_sent_to_browser", {
          tts_request_id: ttsRequestId,
          audio_bytes: audioBuffer.length,
        });
        if (ttsPlaybackTimer) clearTimeout(ttsPlaybackTimer);
        ttsPlaybackTimer = setTimeout(() => {
          if (ttsInFlight) {
            logMetric("tts_playback_timeout", { tts_request_id: ttsRequestId, timeout_ms: TTS_PLAYBACK_TIMEOUT_MS });
            handlePlaybackDone();
          }
        }, TTS_PLAYBACK_TIMEOUT_MS);
      }
    } catch (err) {
      metrics.ttsErrors += 1;
      logMetric("tts_error", {
        tts_request_id: ttsRequestId,
        message: err?.message || String(err),
        generation_ms: elapsedMs(ttsStartedAt),
      });
      console.error("Chyba TTS:", err);
      safeSendJson(clientWs, {
        type: "error",
        message: "Chyba syntézy reči: " + err.message,
      });
      ttsInFlight = false;
      processNextTts();
    }
  }

  function handlePlaybackDone() {
    lastActivityAt = Date.now();
    if (ttsPlaybackTimer) {
      clearTimeout(ttsPlaybackTimer);
      ttsPlaybackTimer = null;
    }

    const hadActivePlayback = ttsInFlight || isMuted || ttsQueue.length > 0;
    if (!hadActivePlayback) {
      logMetric("tts_playback_done_ignored", {
        reason: "no_active_playback",
        queue_remaining: ttsQueue.length,
        output_mode: outputMode,
      });
      return;
    }

    if (ttsInFlight) {
      ttsInFlight = false;
    }

    metrics.playbackDone += 1;
    recordFirstMetric("firstPlaybackDoneAt", "first_playback_done", {
      queue_remaining: ttsQueue.length,
      output_mode: outputMode,
    });

    logMetric("tts_playback_done", {
      queue_remaining: ttsQueue.length,
      tts_enabled: ttsEnabled,
      muted: isMuted,
      output_mode: outputMode,
    });

    if (ttsQueue.length > 0 && ttsEnabled) {
      processNextTts();
      return;
    }

    if (isMuted) {
      isMuted = false;
      safeSendJson(clientWs, { type: "unmute" });
      logMetric("microphone_unmuted_after_tts");
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server beží na porte ${PORT} | verzia ${APP_VERSION}`);
  console.log(
    `[metrics] server_start ${JSON.stringify({
      version: APP_VERSION,
      tts_transport: TTS_TRANSPORT,
      soniox_region: inferSonioxRegion(),
      soniox_stt_url: SONIOX_STT_URL,
      soniox_tts_url: SONIOX_TTS_REST_URL,
      soniox_tts_models_url: SONIOX_TTS_MODELS_URL,
    })}`
  );
});
