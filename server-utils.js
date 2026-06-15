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

const LANGUAGE_NAME_FALLBACKS = {
  af: "Afrikaans",
  ar: "Arabic",
  bg: "Bulgarian",
  bn: "Bengali",
  ca: "Catalan",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  fi: "Finnish",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  lt: "Lithuanian",
  lv: "Latvian",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sl: "Slovenian",
  sr: "Serbian",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  zh: "Chinese",
};

function extractSonioxModels(modelsResponse) {
  if (Array.isArray(modelsResponse?.models)) return modelsResponse.models;
  if (Array.isArray(modelsResponse)) return modelsResponse;
  return [];
}

function normalizeLanguageEntryCode(code) {
  if (!code || typeof code !== "string") return "";
  return normalizeLanguageCode(code.replace(/_/g, "-"));
}

function readableLanguageName(code) {
  const normalizedCode = normalizeLanguageEntryCode(code);
  if (!normalizedCode) return "";

  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    const displayName = displayNames.of(normalizedCode);
    if (displayName && displayName !== normalizedCode) return displayName;
  } catch (err) {
    // Some minimal runtimes may not ship Intl.DisplayNames data.
  }

  return LANGUAGE_NAME_FALLBACKS[normalizedCode] || normalizedCode.toUpperCase();
}

function normalizeSttLanguageEntry(language) {
  let rawCode = "";
  let rawName = "";

  if (typeof language === "string") {
    rawCode = language;
  } else if (language && typeof language === "object") {
    rawCode =
      language.code ||
      language.id ||
      language.language_code ||
      language.language ||
      language.locale ||
      "";
    rawName =
      language.name ||
      language.display_name ||
      language.label ||
      language.language_name ||
      "";
  }

  const code = normalizeLanguageEntryCode(rawCode);
  if (!code) return null;

  const name = String(rawName || readableLanguageName(code)).trim();
  return {
    code,
    name: name || code.toUpperCase(),
  };
}

function normalizeSttLanguageList(modelsResponse, preferredModelId = "stt-rt-v4") {
  const models = extractSonioxModels(modelsResponse);
  const hasLanguages = (model) =>
    Array.isArray(model?.languages) && model.languages.length > 0;
  const preferredModel = models.find(
    (model) => model?.id === preferredModelId && hasLanguages(model)
  );
  const selectedModel =
    preferredModel || models.find(hasLanguages) || models.find((model) => model?.id === preferredModelId) || models[0];

  const languages = Array.isArray(selectedModel?.languages)
    ? selectedModel.languages
    : [];
  const deduped = new Map();

  for (const language of languages) {
    const normalized = normalizeSttLanguageEntry(language);
    if (normalized && !deduped.has(normalized.code)) {
      deduped.set(normalized.code, normalized);
    }
  }

  return {
    modelId: selectedModel?.id || preferredModelId,
    languages: Array.from(deduped.values()).sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.code.localeCompare(b.code, "en")
    ),
  };
}

function normalizeTtsVoiceList(modelsResponse, preferredModelId = "tts-rt-v1") {
  const models = extractSonioxModels(modelsResponse);
  const preferredModel = models.find((model) => model?.id === preferredModelId);
  const selectedModel =
    preferredModel ||
    models.find((model) => Array.isArray(model?.voices) && model.voices.length > 0) ||
    models[0];
  const voices = Array.isArray(selectedModel?.voices) ? selectedModel.voices : [];

  return {
    modelId: selectedModel?.id || preferredModelId,
    voices: voices
      .map((voice) => {
        const id = voice?.id || voice?.name || voice?.voice;
        if (!id) return null;
        return {
          id: normalizeVoiceId(id),
          name: String(voice?.name || voice?.display_name || id),
          gender: String(voice?.gender || "neutral").toLowerCase(),
          description: String(voice?.description || ""),
        };
      })
      .filter(Boolean),
  };
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
  normalizeSttLanguageList,
  normalizeTtsVoiceList,
  normalizeVoiceId,
};
