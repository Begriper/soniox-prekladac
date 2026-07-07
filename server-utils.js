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

const DEFAULT_STT_MODEL = "stt-rt-v5";

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

function normalizeSttLanguageList(modelsResponse, preferredModelId = DEFAULT_STT_MODEL) {
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

function createConversationTimelineState(options = {}) {
  const maxItems = Math.max(1, Number(options.maxItems || 80));
  return {
    items: [],
    currentItemId: null,
    nextId: 1,
    maxItems,
  };
}

function isAutoLanguage(language) {
  return String(language || "").trim().toLowerCase() === "auto";
}

function getTimelineLanguages(options = {}) {
  return {
    languageA: normalizeLanguageCode(options.languageA) || "sk",
    languageB: isAutoLanguage(options.languageB)
      ? "auto"
      : normalizeLanguageCode(options.languageB) || "de",
  };
}

function inferTranslationSourceLanguage(translationLanguage, options = {}) {
  const { languageA, languageB } = getTimelineLanguages(options);
  if (languageB === "auto") return "";
  if (translationLanguage === languageA) return languageB;
  if (translationLanguage === languageB) return languageA;
  return "";
}

function inferTranslationTargetLanguage(sourceLanguage, options = {}) {
  const { languageA, languageB } = getTimelineLanguages(options);
  if (languageB === "auto") return languageA;
  if (sourceLanguage === languageA) return languageB;
  if (sourceLanguage === languageB) return languageA;
  return languageB || languageA;
}

function refreshConversationItemText(item) {
  item.source_text = `${item.final_source_text || ""}${item.non_final_source_text || ""}`;
  item.translated_text = `${item.final_translated_text || ""}${item.non_final_translated_text || ""}`;
  return item;
}

function hasConversationItemText(item) {
  return Boolean(
    (item?.source_text || "").trim() ||
    (item?.translated_text || "").trim() ||
    (item?.final_source_text || "").trim() ||
    (item?.final_translated_text || "").trim() ||
    (item?.non_final_source_text || "").trim() ||
    (item?.non_final_translated_text || "").trim()
  );
}

function trimConversationItems(state) {
  while (state.items.length > state.maxItems) {
    const removed = state.items.shift();
    if (removed?.id === state.currentItemId) {
      state.currentItemId = null;
    }
  }
}

function createConversationItem(state, sourceLanguage, targetLanguage) {
  const item = {
    id: `turn-${state.nextId++}`,
    source_language: sourceLanguage || "",
    target_language: targetLanguage || "",
    final_source_text: "",
    non_final_source_text: "",
    source_text: "",
    final_translated_text: "",
    non_final_translated_text: "",
    translated_text: "",
    is_final: false,
  };
  state.items.push(item);
  state.currentItemId = item.id;
  trimConversationItems(state);
  return item;
}

function getCurrentConversationItem(state) {
  if (!state.currentItemId) return null;
  return state.items.find((item) => item.id === state.currentItemId) || null;
}

function languagesMatchOrMissing(itemLanguage, tokenLanguage) {
  return !itemLanguage || !tokenLanguage || itemLanguage === tokenLanguage;
}

function findConversationItemForTranslation(state, sourceLanguage, targetLanguage) {
  const current = getCurrentConversationItem(state);
  if (
    current &&
    languagesMatchOrMissing(current.source_language, sourceLanguage) &&
    languagesMatchOrMissing(current.target_language, targetLanguage)
  ) {
    return current;
  }

  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (
      languagesMatchOrMissing(item.source_language, sourceLanguage) &&
      languagesMatchOrMissing(item.target_language, targetLanguage) &&
      (!item.translated_text || !item.is_final)
    ) {
      return item;
    }
  }

  return null;
}

function findConversationItemForSource(state, sourceLanguage, targetLanguage) {
  const current = getCurrentConversationItem(state);
  if (!current || current.is_final) return null;
  if (!languagesMatchOrMissing(current.source_language, sourceLanguage)) return null;
  if (!languagesMatchOrMissing(current.target_language, targetLanguage)) return null;
  return current;
}

function ensureConversationItem(state, sourceLanguage, targetLanguage, isTranslation) {
  const existing = isTranslation
    ? findConversationItemForTranslation(state, sourceLanguage, targetLanguage)
    : findConversationItemForSource(state, sourceLanguage, targetLanguage);
  const item = existing || createConversationItem(state, sourceLanguage, targetLanguage);

  if (sourceLanguage && !item.source_language) item.source_language = sourceLanguage;
  if (targetLanguage && !item.target_language) item.target_language = targetLanguage;
  if (!item.is_final) state.currentItemId = item.id;
  return item;
}

function clearConversationNonFinalText(state) {
  for (const item of state.items) {
    item.non_final_source_text = "";
    item.non_final_translated_text = "";
    refreshConversationItemText(item);
  }
}

function appendConversationToken(state, token, options = {}) {
  if (!state || !Array.isArray(state.items)) {
    throw new TypeError("Invalid conversation timeline state.");
  }
  if (!token || typeof token.text !== "string") return { ignored: true };

  const text = token.text;
  const status = token.translation_status || "original";
  const isTranslation = status === "translation";
  const isFinal = Boolean(token.is_final);
  const tokenLanguage = normalizeLanguageCode(token.language);
  const sourceLanguageFromToken = normalizeLanguageCode(token.source_language);
  const timelineLanguages = getTimelineLanguages(options);

  if (
    timelineLanguages.languageB === "auto" &&
    (
      (!isTranslation && tokenLanguage === timelineLanguages.languageA) ||
      (isTranslation && sourceLanguageFromToken === timelineLanguages.languageA)
    )
  ) {
    return {
      ignored: true,
      reason: "auto_language_a",
      item: null,
      bucket: "ignored",
      tts_text: "",
      tts_language: "",
    };
  }

  const sourceLanguage = isTranslation
    ? sourceLanguageFromToken || inferTranslationSourceLanguage(tokenLanguage, options)
    : tokenLanguage || timelineLanguages.languageA;
  const targetLanguage = isTranslation
    ? tokenLanguage || inferTranslationTargetLanguage(sourceLanguage, options)
    : inferTranslationTargetLanguage(sourceLanguage, options);
  const item = ensureConversationItem(state, sourceLanguage, targetLanguage, isTranslation);

  if (isTranslation) {
    if (isFinal) {
      item.final_translated_text += text;
    } else {
      item.non_final_translated_text += text;
    }
  } else {
    if (isFinal) {
      item.final_source_text += text;
    } else {
      item.non_final_source_text += text;
    }
  }

  refreshConversationItemText(item);

  return {
    ignored: false,
    item,
    bucket: isTranslation ? "translation" : "source",
    tts_text: isTranslation && isFinal ? text : "",
    tts_language: isTranslation ? item.target_language : "",
  };
}

function validateReplayTranslationRequest(payload = {}, maxChars = 900) {
  const maxLength = Math.max(1, Number(maxChars || 900));
  const text = String(payload?.text || "").trim();
  const language = normalizeLanguageCode(payload?.language);

  if (!text) {
    return { ok: false, item_id: "", text: "", language: "", voice: "", error: "empty_text" };
  }

  if (text.length > maxLength) {
    return { ok: false, item_id: "", text: "", language: "", voice: "", error: "text_too_long" };
  }

  if (!language) {
    return { ok: false, item_id: "", text: "", language: "", voice: "", error: "missing_language" };
  }

  return {
    ok: true,
    item_id: String(payload?.item_id || "").trim().slice(0, 80),
    text,
    language,
    voice: normalizeVoiceId(payload?.voice || "Adrian"),
    error: "",
  };
}

function markConversationEndpoint(state) {
  const item = getCurrentConversationItem(state);
  if (!item) return null;
  item.is_final = true;
  state.currentItemId = null;
  return refreshConversationItemText(item);
}

function serializeConversationItems(state) {
  return state.items
    .filter(hasConversationItemText)
    .map((item) => ({
      id: item.id,
      source_language: item.source_language || "",
      target_language: item.target_language || "",
      source_text: item.source_text || "",
      translated_text: item.translated_text || "",
      is_final: Boolean(item.is_final),
    }));
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
  appendConversationToken,
  chunkTextForTts,
  clearConversationNonFinalText,
  createConversationTimelineState,
  DEFAULT_STT_MODEL,
  formatKb,
  formatMb,
  markConversationEndpoint,
  normalizeBoolean,
  normalizeEndpointDelay,
  normalizeLanguageCode,
  normalizeOutputMode,
  normalizeSttLanguageList,
  normalizeTtsVoiceList,
  normalizeVoiceId,
  serializeConversationItems,
  validateReplayTranslationRequest,
};
