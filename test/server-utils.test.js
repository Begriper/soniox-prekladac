const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chunkTextForTts,
  normalizeBoolean,
  normalizeEndpointDelay,
  normalizeLanguageCode,
  normalizeOutputMode,
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
  const text = 'Prvá veta. Druhá veta je dlhšia. Tretia veta pokračuje. Štvrtá veta pokračuje. Piata veta pokračuje.';
  const chunks = chunkTextForTts(text, 24);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.length <= 4);
  assert.ok(chunks.every((chunk) => chunk.length <= 25));
  assert.equal(chunkTextForTts('  ahoj  ', 24)[0], 'ahoj');
});
