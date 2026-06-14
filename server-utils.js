function bytesLength(data) {
  if (!data) return 0;
  if (typeof data.length === "number") return data.length;
  if (typeof data.byteLength === "number") return data.byteLength;
  return 0;
}

function formatKb(bytes) {
  return Math.round((Number(bytes || 0) / 1024) * 10) / 10;
}

function formatMb(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
}

function normalizeLanguageCode(code) {
  if (!code || typeof code !== "string") return "";
  return code
    .trim()
    .split("-")[0]
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .slice(0, 8);
}

function normalizeVoiceId(voice) {
  if (!voice || typeof voice !== "string") return "Adrian";
  const cleaned = voice
    .trim()
    .replace(/[^a-zA-Z0-9._\- ]/g, "")
    .slice(0, 50);
  return cleaned || "Adrian";
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) return true;
    if (["false", "0", "no", "off"].includes(lower)) return false;
  }
  return fallback;
}

function normalizeEndpointDelay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 500;
  return Math.max(500, Math.min(3000, Math.round(number)));
}

function normalizeOutputMode(value) {
  const mode = String(value || "speaker").trim().toLowerCase();
  return mode === "headphones" ? "headphones" : "speaker";
}

function chunkTextForTts(text, maxLength = 900) {
  const clean = String(text || "").trim();
  if (clean.length <= maxLength) return [clean].filter(Boolean);
  const chunks = [];
  let remaining = clean;
  while (remaining.length > maxLength) {
    let splitAt = Math.max(
      remaining.lastIndexOf(". ", maxLength),
      remaining.lastIndexOf("! ", maxLength),
      remaining.lastIndexOf("? ", maxLength),
      remaining.lastIndexOf(", ", maxLength),
      remaining.lastIndexOf(" ", maxLength)
    );
    if (splitAt < Math.floor(maxLength * 0.45)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean).slice(0, 4);
}

module.exports = {
  bytesLength,
  chunkTextForTts,
  formatKb,
  formatMb,
  normalizeBoolean,
  normalizeEndpointDelay,
  normalizeLanguageCode,
  normalizeOutputMode,
  normalizeVoiceId,
};
