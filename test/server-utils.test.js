const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendConversationToken,
  chunkTextForTts,
  createConversationTimelineState,
  markConversationEndpoint,
  normalizeLanguageCode,
  serializeConversationItems,
} = require('../server-utils');

test('normalizeLanguageCode strips region and unsafe characters', () => {
  assert.equal(normalizeLanguageCode('sk-SK'), 'sk');
  assert.equal(normalizeLanguageCode(' EN_us '), 'enus');
  assert.equal(normalizeLanguageCode('123'), '');
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
