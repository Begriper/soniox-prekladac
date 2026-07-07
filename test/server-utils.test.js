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
  assert.equal(normalizeEndpointDelay('not-a-number'), 500);
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

test('chunkTextForTts splits long text on natural boundaries and caps chunks', () => {
  const text = 'First sentence. Second sentence is longer. Third sentence continues. Fourth sentence continues. Fifth sentence continues.';
  const chunks = chunkTextForTts(text, 24);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.length <= 4);
  assert.ok(chunks.every((chunk) => chunk.length <= 25));
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

test('normalizeTtsVoiceList keeps all voices from tts-rt-v1 with metadata', () => {
  const result = normalizeTtsVoiceList({
    models: [
      { id: 'legacy-tts', voices: [{ id: 'Old', gender: 'male' }] },
      {
        id: 'tts-rt-v1',
        voices: [
          { id: 'Maya', name: 'Maya', gender: 'Female', description: 'Warm voice' },
          { voice: 'Daniel', gender: 'Male', description: 'Calm voice' }
        ]
      }
    ]
  });

  assert.equal(result.modelId, 'tts-rt-v1');
  assert.deepEqual(result.voices, [
    { id: 'Maya', name: 'Maya', gender: 'female', description: 'Warm voice' },
    { id: 'Daniel', name: 'Daniel', gender: 'male', description: 'Calm voice' }
  ]);
});
