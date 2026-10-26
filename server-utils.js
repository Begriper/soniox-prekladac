function normalizeLanguageCode(code) {
  if (!code || typeof code !== "string") return "";
  return code
    .trim()
    .split("-")[0]
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .slice(0, 8);
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
      is_final: Boolean(item.is_final && item.final_translated_text.trim() && !item.non_final_translated_text),
    }));
}

function chunkTextForTts(text, maxLength = 900) {
  if (!Number.isInteger(maxLength) || maxLength < 2) throw new RangeError("Invalid chunk size");
  let remaining = String(text || "").trim();
  const chunks = [];
  while (remaining.length > maxLength) {
    let end = remaining.lastIndexOf(" ", maxLength);
    if (end < Math.floor(maxLength * .45)) end = maxLength;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

module.exports = {
  appendConversationToken,
  chunkTextForTts,
  clearConversationNonFinalText,
  createConversationTimelineState,
  markConversationEndpoint,
  normalizeLanguageCode,
  serializeConversationItems,
};
