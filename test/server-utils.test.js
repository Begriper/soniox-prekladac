const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendConversationToken,
  chunkTextForTts,
  createConversationTimelineState,
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
} = require('../server-utils');

test('normalizeLanguageCode strips region and unsafe characters', () => {
  assert.equal(normalizeLanguageCode('sk-SK'), 'sk');
  assert.equal(normalizeLanguageCode(' EN_us '), 'enus');
  assert.equal(normalizeLanguageCode('123'), '');
});

test('normalizeVoiceId keeps safe identifiers and falls back to Adrian', () => {
  assert.equal(normalizeVoiceId(' Adrian.v2 '), 'Adrian.v2');
  assert.equal(normalizeVoiceId('Bad<script>Voice'), 'BadscriptVoice');
  assert.equal(normalizeVoiceId(''), 'Adrian');
});

test('normalizeEndpointDelay clamps to the supported latency window', () => {
  assert.equal(normalizeEndpointDelay(100), 500);
  assert.equal(normalizeEndpointDelay(900), 900);
  assert.equal(normalizeEndpointDelay(9999), 3000);
  assert.equal(normalizeEndpointDelay('not-a-number'), 1500);
});

test('normalizeOutputMode only allows speaker or headphones', () => {
  assert.equal(normalizeOutputMode('headphones'), 'headphones');
  assert.equal(normalizeOutputMode('speaker'), 'speaker');
  assert.equal(normalizeOutputMode('bad'), 'speaker');
});

test('normalizeBoolean accepts common string values and preserves fallback', () => {
  assert.equal(normalizeBoolean('yes', false), true);
  assert.equal(normalizeBoolean('off', true), false);
  assert.equal(normalizeBoolean(undefined, false), false);
});

test('chunkTextForTts preserves all text beyond four bounded chunks', () => {
  const text = 'First sentence. Second sentence is longer. Third sentence continues. Fourth sentence continues. Fifth sentence continues.';
  const chunks = chunkTextForTts(text, 24);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.length > 4);
  assert.equal(chunks.join(' '), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 24));
  assert.equal(chunkTextForTts('  ahoj  ', 24)[0], 'ahoj');
});

test('normalizeSttLanguageList prefers stt-rt-v5, deduplicates, and sorts languages', () => {
  const result = normalizeSttLanguageList({
    models: [
      { id: 'older-model', languages: ['zz'] },
      {
        id: 'stt-rt-v5',
        languages: [
          'sk',
          { code: 'en', name: 'English' },
          { language: 'sk', name: 'Slovak duplicate' },
          { language_code: 'de-DE', display_name: 'German' }
        ]
      }
    ]
  });

  assert.equal(result.modelId, 'stt-rt-v5');
  assert.deepEqual(result.languages, [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'German' },
    { code: 'sk', name: 'Slovak' }
  ]);
});

test('normalizeSttLanguageList falls back to first model with languages', () => {
  const result = normalizeSttLanguageList({
    models: [
      { id: 'empty-model', languages: [] },
      { id: 'language-model', languages: ['de', 'en'] }
    ]
  });

  assert.equal(result.modelId, 'language-model');
  assert.deepEqual(result.languages, [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'German' }
  ]);
});

test('normalizeSttLanguageList creates readable names for string language codes', () => {
  const result = normalizeSttLanguageList({
    models: [{ id: 'stt-rt-v5', languages: ['sk'] }]
  });

  assert.deepEqual(result.languages, [{ code: 'sk', name: 'Slovak' }]);
});

test('conversation timeline groups explicit two-way Slovak to German turn', () => {
  const state = createConversationTimelineState();
  const options = { languageA: 'sk', languageB: 'de' };

  appendConversationToken(state, { text: 'Ahoj', translation_status: 'original', language: 'sk', is_final: true }, options);
  const result = appendConversationToken(state, { text: 'Hallo', translation_status: 'translation', language: 'de', source_language: 'sk', is_final: true }, options);
  markConversationEndpoint(state);

  assert.deepEqual(state.items.map((item) => ({
    source_language: item.source_language,
    target_language: item.target_language,
    source_text: item.source_text,
    translated_text: item.translated_text,
    is_final: item.is_final
  })), [{
    source_language: 'sk',
    target_language: 'de',
    source_text: 'Ahoj',
    translated_text: 'Hallo',
    is_final: true
  }]);
  assert.equal(result.tts_text, 'Hallo');
  assert.equal(result.tts_language, 'de');
});

test('conversation timeline groups explicit two-way German to Slovak turn', () => {
  const state = createConversationTimelineState();
  const options = { languageA: 'sk', languageB: 'de' };

  appendConversationToken(state, { text: 'Wie geht es?', translation_status: 'original', language: 'de', is_final: true }, options);
  const result = appendConversationToken(state, { text: 'Ako sa máš?', translation_status: 'translation', language: 'sk', source_language: 'de', is_final: true }, options);

  assert.equal(state.items[0].source_language, 'de');
  assert.equal(state.items[0].target_language, 'sk');
  assert.equal(state.items[0].source_text, 'Wie geht es?');
  assert.equal(state.items[0].translated_text, 'Ako sa máš?');
  assert.equal(result.tts_language, 'sk');
});

test('conversation timeline keeps auto mode as detected source to language A', () => {
  const state = createConversationTimelineState();
  const options = { languageA: 'sk', languageB: 'auto' };

  appendConversationToken(state, { text: 'Buenos días', translation_status: 'original', language: 'es', is_final: true }, options);
  const result = appendConversationToken(state, { text: 'Dobré ráno', translation_status: 'translation', language: 'sk', source_language: 'es', is_final: true }, options);

  assert.equal(state.items[0].source_language, 'es');
  assert.equal(state.items[0].target_language, 'sk');
  assert.equal(state.items[0].source_text, 'Buenos días');
  assert.equal(state.items[0].translated_text, 'Dobré ráno');
  assert.equal(result.tts_language, 'sk');
});

test('conversation timeline keeps multiple auto detected languages targeting language A', () => {
  const state = createConversationTimelineState();
  const options = { languageA: 'sk', languageB: 'auto' };

  appendConversationToken(state, { text: 'Good morning', translation_status: 'original', language: 'en', is_final: true }, options);
  appendConversationToken(state, { text: 'Dobré ráno', translation_status: 'translation', language: 'sk', source_language: 'en', is_final: true }, options);
  markConversationEndpoint(state);
  appendConversationToken(state, { text: 'Buenos días', translation_status: 'original', language: 'es', is_final: true }, options);
  appendConversationToken(state, { text: 'Dobré ráno', translation_status: 'translation', language: 'sk', source_language: 'es', is_final: true }, options);

  assert.deepEqual(serializeConversationItems(state).map((item) => ({
    source_language: item.source_language,
    target_language: item.target_language,
    source_text: item.source_text,
    translated_text: item.translated_text
  })), [
    {
      source_language: 'en',
      target_language: 'sk',
      source_text: 'Good morning',
      translated_text: 'Dobré ráno'
    },
    {
      source_language: 'es',
      target_language: 'sk',
      source_text: 'Buenos días',
      translated_text: 'Dobré ráno'
    }
  ]);
});

test('conversation timeline ignores language A speech in auto mode', () => {
  const state = createConversationTimelineState();
  const options = { languageA: 'sk', languageB: 'auto' };

  const originalResult = appendConversationToken(state, { text: 'Ahoj', translation_status: 'original', language: 'sk', is_final: true }, options);
  const translationResult = appendConversationToken(state, { text: 'Ahoj', translation_status: 'translation', language: 'sk', source_language: 'sk', is_final: true }, options);

  assert.equal(originalResult.ignored, true);
  assert.equal(translationResult.ignored, true);
  assert.deepEqual(serializeConversationItems(state), []);
  assert.equal(translationResult.tts_text, '');
  assert.equal(translationResult.tts_language, '');
});

test('validateReplayTranslationRequest accepts safe translated text', () => {
  const result = validateReplayTranslationRequest({
    item_id: 'turn-3',
    text: 'Guten Morgen',
    language: 'de',
    voice: 'Cooper — Male'
  }, 60);

  assert.deepEqual(result, {
    ok: true,
    item_id: 'turn-3',
    text: 'Guten Morgen',
    language: 'de',
    voice: 'Cooper  Male',
    error: ''
  });
});

test('validateReplayTranslationRequest rejects empty or too long text', () => {
  assert.equal(validateReplayTranslationRequest({ text: ' ', language: 'de' }, 10).ok, false);
  assert.equal(validateReplayTranslationRequest({ text: 'abcdefghijkl', language: 'de' }, 10).ok, false);
  assert.equal(validateReplayTranslationRequest({ text: 'Hallo', language: '' }, 10).ok, false);
});

test('normalizeTtsVoiceList keeps all voices from tts-rt-v2 with metadata', () => {
  const result = normalizeTtsVoiceList({
    models: [
      { id: 'legacy-tts', voices: [{ id: 'Old', gender: 'male' }] },
      {
        id: 'tts-rt-v2',
        voices: [
          { id: 'Maya', name: 'Maya', gender: 'Female', description: 'Warm voice' },
          { voice: 'Daniel', gender: 'Male', description: 'Calm voice' }
        ]
      }
    ]
  });

  assert.equal(result.modelId, 'tts-rt-v2');
  assert.deepEqual(result.voices, [
    { id: 'Maya', name: 'Maya', gender: 'female', description: 'Warm voice' },
    { id: 'Daniel', name: 'Daniel', gender: 'male', description: 'Calm voice' }
  ]);
});
