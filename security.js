"use strict";
const crypto = require("node:crypto");
const net = require("node:net");

function parseCookies(header = "") {
  const result = Object.create(null);
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { return Object.create(null); }
  }
  return result;
}
function equal(a, b) {
  const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}
function validOrigin(req, allowedOrigins) {
  return allowedOrigins.has(req.headers.origin);
}
function clientIp(req, trustFly = false) {
  const candidate = trustFly ? req.headers["fly-client-ip"] : req.socket.remoteAddress;
  return typeof candidate === "string" && net.isIP(candidate) ? candidate : "unknown";
}
function parseMessage(data) {
  let msg;
  try { msg = JSON.parse(String(data)); } catch { return null; }
  if (!msg || Array.isArray(msg) || typeof msg !== "object" || typeof msg.type !== "string") return null;
  const fields = {
    config: ["language_a", "language_b", "tts_voice", "voice_a", "voice_b", "output_mode", "profile_id", "conversation_mode"],
    update_settings: ["voice_a", "voice_b", "output_mode"],
    confirm_language: ["language"], playback_started: ["playback_id"], playback_done: ["playback_id", "status"],
    local_playback_start: ["playback_id"], local_playback_end: ["playback_id"],
    replay_translation: ["item_id"], stop_audio: ["request_id"], client_stop: [], clear_text: [], ptt_start: [], ptt_end: [],
  };
  if (!Object.hasOwn(fields, msg.type)) return null;
  for (const field of fields[msg.type]) {
    if (msg[field] !== undefined && (typeof msg[field] !== "string" || msg[field].length > 100)) return null;
  }
  if (msg.tts_enabled !== undefined && typeof msg.tts_enabled !== "boolean") return null;
  if (msg.conversation_mode !== undefined && !["auto", "ptt"].includes(msg.conversation_mode)) return null;
  if (msg.output_mode !== undefined && !["speaker", "headphones"].includes(msg.output_mode)) return null;
  return msg;
}
class WindowLimiter {
  constructor(max, duration, capacity = 4096) { Object.assign(this, { max, duration, capacity }); this.entries = new Map(); }
  allow(key, now = Date.now()) {
    this.prune(now);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.capacity) return false;
      entry = { count: 0, expires: now + this.duration };
      this.entries.set(key, entry);
    }
    return ++entry.count <= this.max;
  }
  prune(now = Date.now()) { for (const [key, e] of this.entries) if (e.expires <= now) this.entries.delete(key); }
}
module.exports = { parseCookies, equal, validOrigin, clientIp, parseMessage, WindowLimiter };
