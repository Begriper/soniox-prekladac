"use strict";
const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const WebSocket = require("ws");
const { UsageStore } = require("./usage-store");
const { installAdminApi } = require("./admin-api");
const { hashPassword, verifyPassword } = require("./passwords");
const { Catalog } = require("./catalog");
const { SpeechSession } = require("./speech-session");
const { PROFILES } = require("./context-profiles");
const { synthesizeRest } = require("./tts-rest");
const { STT_MODEL, TTS_MODEL } = require("./runtime-models");
const { normalizeTtsTransport } = require("./tts-transport");
const { parseCookies, equal, validOrigin, clientIp, WindowLimiter } = require("./security");
const APP_VERSION = "3.2.0";
const COOKIE = "sl_session";
const RESUME_WINDOW_MS = 5 * 60000;
const MAX_LOGINS_PER_USER = 10;
function number(env, key, fallback, min = 1, max = 1e12) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error("Invalid configuration: " + key);
  return value;
}
function createApplication(env = process.env) {
  const production = env.NODE_ENV === "production";
  if (!env.SONIOX_API_KEY) throw new Error("SONIOX_API_KEY is required");
  const secret = env.SESSION_SECRET || (production ? "" : crypto.randomBytes(32).toString("hex"));
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  const users = (env.APP_ACCESS_CODES || "").split(",").filter(Boolean).map(part => {
    const i = part.indexOf(":");
    const username = part.slice(0, i).trim(), code = part.slice(i + 1).trim();
    if (i < 1 || !/^[\w.-]{1,40}$/.test(username) || code.length < 16) throw new Error("Use unique access codes of at least 16 characters");
    return { username, code };
  });
  if (!users.length || new Set(users.map(u => u.code)).size !== users.length || new Set(users.map(u => u.username)).size !== users.length) throw new Error("Invalid access users");
  const ownerUsername = env.APP_OWNER_USERNAME || (users.length === 1 ? users[0].username : "");
  if (ownerUsername && !users.some(u => u.username === ownerUsername)) throw new Error("APP_OWNER_USERNAME must match APP_ACCESS_CODES");
  const region = env.SONIOX_REGION || "eu";
  if (!["eu", "us", "jp", "in"].includes(region)) throw new Error("Invalid SONIOX_REGION");
  const suffix = region === "us" ? "" : "." + region;
  const urls = {
    stt: env.SONIOX_STT_URL || "wss://stt-rt" + suffix + ".soniox.com/transcribe-websocket",
    ttsWs: env.SONIOX_TTS_WS_URL || "wss://tts-rt" + suffix + ".soniox.com/tts-websocket",
    ttsRest: env.SONIOX_TTS_REST_URL || "https://tts-rt" + suffix + ".soniox.com/tts",
    sttModels: env.SONIOX_STT_MODELS_URL || "https://api" + suffix + ".soniox.com/v1/models",
    ttsModels: env.SONIOX_TTS_MODELS_URL || "https://api" + suffix + ".soniox.com/v1/tts-models",
    sharedVoices: env.SONIOX_SHARED_VOICES_URL || "https://api" + suffix + ".soniox.com/v1/shared-voices",
    customVoices: env.SONIOX_CUSTOM_VOICES_URL || "https://api" + suffix + ".soniox.com/v1/voices",
    usageLogs: env.SONIOX_USAGE_LOGS_URL || "https://api" + suffix + ".soniox.com/v1/usage-logs",
  };
  for (const [kind, value] of Object.entries(urls)) {
    const url = new URL(value);
    if (url.username || url.password || url.search || (production && !["https:", "wss:"].includes(url.protocol))) throw new Error("Invalid endpoint: " + kind);
  }
  const port = number(env, "PORT", 3000, 1, 65535);
  const prices = { stt: number(env, "PRICE_STT_USD_PER_HOUR", 0.12, 0), tts: number(env, "PRICE_TTS_USD_PER_HOUR", 0.70, 0) };
  const origins = new Set((env.APP_ORIGINS || (production ? "https://" + (env.FLY_APP_NAME || "soniox-prekladac") + ".fly.dev" : "http://localhost:" + port + ",http://127.0.0.1:" + port)).split(",").map(s => {
    const u = new URL(s.trim());
    if (u.origin !== s.trim() || (production && u.protocol !== "https:")) throw new Error("Invalid APP_ORIGINS");
    return u.origin;
  }));
  const limits = {
    sessions: number(env, "MAX_USER_SESSIONS_PER_DAY", 20),
    audioBytes: number(env, "MAX_USER_AUDIO_MB_PER_DAY", 250) * 1024 * 1024,
    ttsRequests: number(env, "MAX_USER_TTS_REQUESTS_PER_DAY", 600),
    ttsAudioBytes: number(env, "MAX_USER_TTS_AUDIO_MB_PER_DAY", 160) * 1024 * 1024,
    ttsChars: number(env, "MAX_USER_TTS_CHARS_PER_DAY", 200000),
    sttSeconds: number(env, "MAX_USER_STT_MINUTES_PER_DAY", 180) * 60,
  };
  const sessionLimits = {
    sessionMs: number(env, "MAX_SESSION_MINUTES", 30) * 60000,
    sessionAudioBytes: number(env, "MAX_AUDIO_MB_PER_SESSION", 75) * 1024 * 1024,
    sessionTtsRequests: number(env, "MAX_TTS_REQUESTS_PER_SESSION", 120),
    sessionTtsBytes: number(env, "MAX_TTS_AUDIO_MB_PER_SESSION", 80) * 1024 * 1024,
    idleMs: number(env, "IDLE_TIMEOUT_SECONDS", 120) * 1000,
  };
  const endpoint = {
    delay: number(env, "ENDPOINT_DELAY_MS", 1500, 500, 3000),
    level: number(env, "ENDPOINT_LATENCY_LEVEL", 0, 0, 3),
    sensitivity: number(env, "ENDPOINT_SENSITIVITY", 0, -1, 1),
  };
  if (!Number.isInteger(endpoint.level)) throw new Error("Invalid endpoint level");
  const ttl = number(env, "SESSION_TTL_MINUTES", 43200, 1, 43200) * 60000;
  const maxTotal = number(env, "MAX_ACTIVE_WS_TOTAL", 3, 1, 100);
  const maxIp = number(env, "MAX_ACTIVE_WS_PER_IP", 2, 1, 100);
  const store = new UsageStore(env.USAGE_DB_PATH || (production ? "/data/usage.sqlite" : path.join(__dirname, ".local-data", "usage.sqlite")), limits);
  const catalog = new Catalog({ store, apiKey: env.SONIOX_API_KEY, urls: { stt: urls.sttModels, tts: urls.ttsModels, shared: urls.sharedVoices, custom: urls.customVoices }, ownerUsername, ownerVoiceName: env.APP_OWNER_VOICE_NAME || "my voice" });
  const conversations = new Map(), previews = new Map(), upgrading = new Map(), summaries = new Map(), recentSessions = new Map();
  const loginIp = new WindowLimiter(number(env, "MAX_LOGIN_ATTEMPTS", 8), 600000);
  const loginGlobal = new WindowLimiter(100, 600000, 1);
  const loginUsername = new WindowLimiter(10, 600000);
  const previewRate = new WindowLimiter(number(env, "MAX_PREVIEW_TTS_REQUESTS_PER_HOUR", 20), 3600000);
  let dummyHash;
  const ready = (async () => {
    dummyHash = await hashPassword(crypto.randomBytes(32).toString("base64url"));
    if (!store.listUsers().length) {
      const imported = [];
      for (const user of users) imported.push({ ...user, passwordHash: await hashPassword(user.code) });
      store.db.exec("BEGIN IMMEDIATE");
      try {
        if (!store.listUsers().length) for (const user of imported) {
          const role = user.username === ownerUsername ? "admin" : "user";
          store.createUser({ username: user.username, role, passwordHash: user.passwordHash });
          store.audit("system", "bootstrap_import", user.username, { role });
        }
        store.migrateRevokedUsers();
        store.db.exec("COMMIT");
      } catch (err) { store.db.exec("ROLLBACK"); throw err; }
    }
  })();
  // Callers retain the synchronous factory; requests and startup wait for scrypt import.
  void ready.catch(() => {});
  const app = express(), server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (production) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST" && !validOrigin(req, origins)) return res.status(403).json({ error: "Prístup odmietnutý." });
    next();
  });
  app.use(express.json({ limit: "8kb", strict: true }));
  app.use((_req, _res, next) => { void ready.then(() => next(), next); });
  const sign = id => crypto.createHmac("sha256", secret).update(id).digest("base64url");
  const sessionHash = id => crypto.createHash("sha256").update(id).digest("hex");
  const cookie = (value, seconds) => COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + seconds + (production ? "; Secure" : "");
  function destroy(id) {
    store.deleteSession(sessionHash(id));
    for (const conversation of conversations.values()) if (conversation.auth.id === id) conversation.end("Prihlásenie bolo ukončené.", "auth_expired");
    for (const p of previews.values()) if (p.sessionId === id) p.abort.abort();
    recentSessions.delete(id);
  }
  function endUser(username) {
    store.deleteUserSessions(username);
    for (const c of conversations.values()) if (c.auth.username === username) destroy(c.auth.id);
    const preview = previews.get(username); if (preview) destroy(preview.sessionId);
    for (const id of recentSessions.keys()) if (!store.getSession(sessionHash(id))) recentSessions.delete(id);
  }
  function session(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE];
    if (!value || !/^[\w-]{43}\.[\w-]{43}$/.test(value)) return null;
    const [id, signature] = value.split(".");
    if (!equal(sign(id), signature)) return null;
    const row = store.getSession(sessionHash(id));
    if (!row) return null;
    const user = store.getUser(row.username), now = Date.now();
    if (now >= row.expires_at || !user || user.disabled_at) { destroy(id); return null; }
    if (now - row.last_seen_at >= 60000) store.touchSession(row.id_hash, now);
    return { id, username: row.username, expiresAt: row.expires_at, role: user.role };
  }
  function requireSession(req, res, next) {
    req.auth = session(req);
    if (!req.auth) return res.status(401).json({ error: "Najprv sa prihlás." });
    next();
  }
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const usage = username => ({ ...store.read(username), limits: store.limitsFor(username), user: username });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (req, res) => res.json({ appVersion: APP_VERSION, requiresLogin: true, loggedIn: Boolean(session(req)), defaultVoice: "Adrian", defaultEndpointDelayMs: endpoint.delay, ttsModel: TTS_MODEL, profiles: Object.entries(PROFILES).map(([id, value]) => ({ id, label: value.label })) }));
  app.post("/api/login", route(async (req, res) => {
    const ip = clientIp(req, env.TRUST_FLY_PROXY === "true" && Boolean(env.FLY_APP_NAME));
    if (!loginIp.allow(ip) || !loginGlobal.allow("all")) return res.status(429).json({ error: "Príliš veľa pokusov. Skús neskôr." });
    const legacy = req.body?.username === undefined && req.body?.password === undefined;
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = legacy ? req.body?.code : req.body?.password;
    const denied = () => res.status(401).json({ error: "Nesprávne meno alebo heslo, alebo je účet zablokovaný." });
    if (!legacy && !loginUsername.allow(username)) return res.status(429).json({ error: "Príliš veľa pokusov. Skús neskôr." });
    if (typeof password !== "string" || password.length > 512 || (!legacy && !/^[\w.-]{1,40}$/.test(username))) return denied();
    const pw = legacy ? password.trim() : password;
    const owner = users.find(u => u.username === ownerUsername);
    let user;
    if (owner && (legacy || username === ownerUsername) && equal(owner.code, pw)) {
      user = store.getUser(ownerUsername);
      const recovering = !user || user.disabled_at || user.role !== "admin";
      if (!user) {
        const passwordHash = await hashPassword(owner.code);
        user = store.getUser(ownerUsername) || store.createUser({ username: ownerUsername, role: "admin", passwordHash });
      }
      // The environment credential is an explicit recovery path, including a lost role.
      if (recovering) {
        store.statement("UPDATE users SET role='admin',disabled_at=NULL WHERE username=?").run(ownerUsername);
        store.clearLegacyRevocation(ownerUsername);
        store.audit(ownerUsername, "break_glass", ownerUsername);
      }
    } else if (legacy) {
      for (const candidate of store.listUsers()) if (!candidate.disabled_at && await verifyPassword(pw, candidate.password_hash)) { user = candidate; break; }
    } else {
      const candidate = store.getUser(username);
      if (await verifyPassword(pw, candidate?.password_hash || dummyHash)) user = candidate;
    }
    // Re-read after async scrypt: an admin may have disabled the account meanwhile.
    const verified = user;
    user = user && store.getUser(user.username);
    if (verified && user && (verified.password_hash !== user.password_hash || verified.created_at !== user.created_at)) return denied();
    if (!user || user.disabled_at) return denied();
    store.pruneSessions(Date.now());
    // A per-account cap instead of a global one: no account can fill the table and lock out the owner.
    const old = session(req); if (old) destroy(old.id);
    store.trimUserSessions(user.username, MAX_LOGINS_PER_USER - 1);
    const auth = { id: crypto.randomBytes(32).toString("base64url"), username: user.username, expiresAt: Date.now() + ttl, role: user.role };
    store.createSession({ idHash: sessionHash(auth.id), username: auth.username, expiresAt: auth.expiresAt, device: (req.headers["user-agent"] || "").slice(0, 120) });
    store.touchLogin(user.username);
    res.setHeader("Set-Cookie", cookie(auth.id + "." + sign(auth.id), Math.floor(ttl / 1000)));
    res.json({ authenticated: true, username: user.username, role: user.role, usage: usage(user.username) });
  }));
  app.get("/api/session", requireSession, (req, res) => res.json({ authenticated: true, username: req.auth.username, role: req.auth.role, expires_at: new Date(req.auth.expiresAt).toISOString(), usage: usage(req.auth.username) }));
  app.post("/api/logout", (req, res) => {
    const auth = session(req); if (auth) destroy(auth.id);
    res.setHeader("Set-Cookie", cookie("", 0)); res.json({ ok: true });
  });
  app.get("/api/usage", requireSession, (req, res) => res.json(usage(req.auth.username)));
  app.get("/api/languages", requireSession, route(async (_req, res) => {
    const [stt, tts] = await Promise.all([catalog.get("stt"), catalog.get("tts")]);
    res.json({ ...stt, voices: undefined, languages: stt.languages.map(l => ({ ...l, tts: tts.languages.some(t => t.code === l.code), script_note: { zh: "Hlas podporuje zjednodušenú čínštinu.", sr: "Hlas podporuje latinku.", bs: "Hlas podporuje latinku.", kk: "Hlas podporuje cyriliku." }[l.code] || "" })) });
  }));
  app.get("/api/voices", requireSession, route(async (req, res) => res.json(await catalog.voicesFor(req.auth.username))));
  installAdminApi(app, { store, session, route, endUser, conversations, ownerUsername, prices, usageLogsUrl: urls.usageLogs, apiKey: env.SONIOX_API_KEY });
  app.get("/api/diagnostics", requireSession, (req, res) => res.json({ version: APP_VERSION, models: { stt: STT_MODEL, tts: TTS_MODEL }, region, endpoint, transport: normalizeTtsTransport(env.TTS_TRANSPORT), active: conversations.size, usage: usage(req.auth.username), last_session_summary: summaries.get(req.auth.username) || null }));
  app.post("/api/preview-voice", requireSession, route(async (req, res) => {
    const username = req.auth.username;
    if (previews.has(username) || [...conversations.values()].some(c => c.auth.username === username) || !previewRate.allow(username)) return res.status(429).json({ error: "Limit ukážok hlasu." });
    const abort = new AbortController();
    const operation = { abort, sessionId: req.auth.id };
    previews.set(username, operation);
    const expiry = setTimeout(() => abort.abort(), Math.max(1, Math.min(req.auth.expiresAt - Date.now(), 2147483647)));
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", disconnect);
    try {
      const language = req.body?.language || "sk", voice = req.body?.voice || "Adrian";
      await catalog.ensureVoices();
      if (abort.signal.aborted || !session(req)) {
        if (!res.destroyed) res.status(401).json({ error: "Najprv sa prihlás." });
        return;
      }
      if (!catalog.hasVoiceFor(username, voice) || !catalog.canSpeak(language)) return res.status(400).json({ error: "Hlas alebo jazyk nie je dostupný." });
      const phrases = { sk: "Dobrý deň. Toto je ukážka hlasu.", de: "Guten Tag. Dies ist eine Stimmprobe.", es: "Hola. Esta es una muestra de voz.", en: "Hello. This is a voice sample." };
      const text = phrases[language] || "1, 2, 3.";
      if (!store.reserve(username, { ttsRequests: 1, ttsChars: [...text].length, previewTtsRequests: 1 })) return res.status(429).json({ error: "Denný limit hlasu." });
      const buffer = await synthesizeRest({ url: urls.ttsRest, apiKey: env.SONIOX_API_KEY, clientReferenceId: username, text, language, voice, signal: abort.signal });
      if (abort.signal.aborted || !session(req)) return;
      if (!store.reserve(username, { ttsAudioBytes: buffer.length })) return res.status(429).json({ error: "Denný limit audia." });
      res.type("application/octet-stream").send(buffer);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
      if (!res.destroyed && !res.headersSent) res.status(401).json({ error: "Najprv sa prihlás." });
    } finally {
      clearTimeout(expiry);
      res.off("close", disconnect);
      if (previews.get(username) === operation) previews.delete(username);
    }
  }));
  app.post("/api/replay", requireSession, route(async (req, res) => {
    const { text, language, voice } = req.body || {};
    const speed = req.body?.tts_speed !== undefined ? req.body.tts_speed : req.body?.speed;
    if (req.body?.tts_speed !== undefined && req.body?.speed !== undefined && req.body.tts_speed !== req.body.speed) return res.status(400).json({ error: "Neplatná rýchlosť hlasu." });
    if (speed !== undefined && (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.7 || speed > 1.3)) return res.status(400).json({ error: "Neplatná rýchlosť hlasu." });
    const username = req.auth.username;
    if (previews.has(username) || [...conversations.values()].some(c => c.auth.username === username)) {
      return res.status(409).json({ error: "Najprv zastav aktuálne počúvanie alebo hlas." });
    }
    const abort = new AbortController();
    const operation = { abort, sessionId: req.auth.id };
    previews.set(username, operation);
    const expiry = setTimeout(() => abort.abort(), Math.max(1, Math.min(req.auth.expiresAt - Date.now(), 2147483647)));
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", disconnect);
    try {
      await catalog.ensureVoices();
      if (abort.signal.aborted || !session(req)) {
        if (!res.destroyed) res.status(401).json({ error: "Najprv sa prihlás." });
        return;
      }
      if (typeof text !== "string" || !text.trim() || text.length > 900 ||
          !catalog.hasVoiceFor(username, voice) || !catalog.canSpeak(language, text)) {
        return res.status(400).json({ error: "Neplatný alebo príliš dlhý text hlasu." });
      }
      if (!store.reserve(username, { ttsRequests: 1, ttsChars: [...text].length })) return res.status(429).json({ error: "Denný limit hlasu." });
      const buffer = await synthesizeRest({ url: urls.ttsRest, apiKey: env.SONIOX_API_KEY, clientReferenceId: username, text, language, voice, speed, signal: abort.signal });
      if (abort.signal.aborted || !session(req)) return;
      if (!store.reserve(username, { ttsAudioBytes: buffer.length })) return res.status(429).json({ error: "Denný limit audia." });
      res.type("application/octet-stream").send(buffer);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
      if (!res.destroyed && !res.headersSent) res.status(401).json({ error: "Najprv sa prihlás." });
    } finally {
      clearTimeout(expiry);
      res.off("close", disconnect);
      if (previews.get(username) === operation) previews.delete(username);
    }
  }));
  app.use(express.static(path.join(__dirname, "public"), { maxAge: 0, etag: true }));
  app.use((_err, _req, res, _next) => {
    if (!res.headersSent) res.status(503).json({ error: "Operácia nie je dostupná. Skús znova." });
  });
  function reject(socket, status) { socket.end("HTTP/1.1 " + status + " Rejected\r\nConnection: close\r\n\r\n"); }
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      socket.on("error", () => socket.destroy());
      try {
        await ready;
        if (socket.destroyed) return;
        if (req.url !== "/" || !validOrigin(req, origins)) return reject(socket, 403);
        const auth = session(req); if (!auth) return reject(socket, 401);
        const ip = clientIp(req, env.TRUST_FLY_PROXY === "true" && Boolean(env.FLY_APP_NAME));
        await catalog.ensureVoices();
        if (socket.destroyed) return;
        if (!session(req)) return reject(socket, 401);
        if (previews.has(auth.username)) return reject(socket, 409);
        // A phone that lost signal reconnects before the server notices the dead socket;
        // the same login takes over its own conversation instead of being refused.
        let resumed = Date.now() - (recentSessions.get(auth.id) ?? -Infinity) < RESUME_WINDOW_MS;
        for (const c of [...conversations.values()]) if (c.auth.id === auth.id) { c.end("Rozhovor pokračuje v novom spojení.", "replaced"); resumed = true; }
        if (conversations.size + upgrading.size >= maxTotal ||
            [...conversations.values()].filter(c => c.ip === ip).length + [...upgrading.values()].filter(c => c.ip === ip).length >= maxIp) return reject(socket, 429);
        if ([...conversations.values()].some(c => c.auth.username === auth.username) ||
            [...upgrading.values()].some(c => c.username === auth.username)) return reject(socket, 409);
        upgrading.set(socket, { username: auth.username, ip });
        socket.once("close", () => upgrading.delete(socket));
        // Reconnects within the resume window continue the same conversation and do not count as a new session.
        const admitted = resumed || store.reserve(auth.username, { sessions: 1 });
        wss.handleUpgrade(req, socket, head, client => {
          upgrading.delete(socket);
          // Without a listener a malformed frame would throw and stop the whole process.
          client.on("error", () => client.terminate());
          if (!session(req)) return client.terminate();
          if (!admitted) {
            // Accepting first lets the client show the real reason instead of a generic connection error.
            const id = crypto.randomUUID();
            client.send(JSON.stringify({ type: "session_open", conversation_id: id }));
            client.send(JSON.stringify({ type: "error", code: "quota_exceeded", fatal: true, message: "Denný limit rozhovorov bol vyčerpaný.", conversation_id: id }));
            return client.close(4000, "quota_exceeded");
          }
          try {
            const conversation = new SpeechSession(client, {
              auth, ip, store, catalog, apiKey: env.SONIOX_API_KEY, urls, limits: sessionLimits,
              endpoint, transport: normalizeTtsTransport(env.TTS_TRANSPORT),
              onClose: summary => {
                conversations.delete(client); summaries.set(auth.username, summary); recentSessions.set(auth.id, Date.now());
                try { store.recordConversation(auth.username, summary); } catch { /* Logging must not prevent cleanup. */ }
              },
            });
            conversations.set(client, conversation);
          } catch { client.terminate(); }
        });
      } catch {
        upgrading.delete(socket);
        reject(socket, 503);
      }
    })();
  });
  const cleanup = setInterval(() => {
    try {
      for (const c of conversations.values()) if (Date.now() >= c.auth.expiresAt || !store.getSession(sessionHash(c.auth.id)) || store.getUser(c.auth.username)?.disabled_at) destroy(c.auth.id);
      for (const [username, p] of previews) if (!store.getSession(sessionHash(p.sessionId)) || store.getUser(username)?.disabled_at) p.abort.abort();
      store.pruneSessions(Date.now());
      for (const [id, at] of recentSessions) if (Date.now() - at >= RESUME_WINDOW_MS || !store.getSession(sessionHash(id))) recentSessions.delete(id);
      store.prune();
    } catch { /* Subsequent paid operations fail closed. */ }
    loginIp.prune(); loginGlobal.prune(); loginUsername.prune(); previewRate.prune();
  }, 60000);
  cleanup.unref();
  return { app, server, store, catalog, conversations, port, ready, close: async () => {
    clearInterval(cleanup);
    for (const c of conversations.values()) { c.close(); c.client.terminate(); }
    for (const p of previews.values()) p.abort.abort();
    await new Promise(resolve => server.close(resolve)); await ready.catch(() => {}); store.close();
  } };
}
if (require.main === module) {
  require("dotenv").config();
  try {
    const runtime = createApplication();
    void runtime.ready.then(() => runtime.server.listen(runtime.port, "0.0.0.0", () => console.log("Translator " + APP_VERSION + " listening on " + runtime.port))).catch(async err => {
      console.error("Startup failed: " + err.message); await runtime.close(); process.exitCode = 1;
    });
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void runtime.close().then(() => process.exit(0)); });
  } catch (err) { console.error("Startup failed: " + err.message); process.exitCode = 1; }
}
module.exports = { createApplication };
