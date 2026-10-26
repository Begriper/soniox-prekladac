"use strict";
const { TTS_MODEL } = require("./runtime-models");
async function synthesizeRest({ url, apiKey, text, language, voice, signal, fetchImpl = fetch, maxBytes = 8 * 1024 * 1024 }) {
  const deadline = AbortSignal.timeout(15000);
  const response = await fetchImpl(url, {
    method: "POST", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, text, language, voice, audio_format: "pcm_s16le", sample_rate: 24000 }),
  });
  if (!response.ok) { const err = new Error("Voice unavailable"); err.errorCode = response.status; await response.body?.cancel(); throw err; }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Audio too large");
    chunks.push(Buffer.from(chunk));
  }
  if (!bytes) throw new Error("Empty audio");
  return Buffer.concat(chunks);
}
module.exports = { synthesizeRest };

