const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chunkTextForTts,
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

test('normalizeSttLanguageList prefers stt-rt-v4, deduplicates, and sorts languages', () => {
  const result = normalizeSttLanguageList({
    models: [
      { id: 'older-model', languages: ['zz'] },
      {
        id: 'stt-rt-v4',
        languages: [
          'sk',
          { code: 'en', name: 'English' },
          { language: 'sk', name: 'Slovak duplicate' },
          { language_code: 'de-DE', display_name: 'German' }
        ]
      }
    ]
  });

  assert.equal(result.modelId, 'stt-rt-v4');
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
    models: [{ id: 'stt-rt-v4', languages: ['sk'] }]
  });

  assert.deepEqual(result.languages, [{ code: 'sk', name: 'Slovak' }]);
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
