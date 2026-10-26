"use strict";
const { TTS_MODEL } = require("./runtime-models");
// With onChunk the PCM is passed on as it arrives (even byte lengths) and only the byte count is returned.
async function synthesizeRest({ url, apiKey, text, language, voice, speed = 1, signal, onChunk, fetchImpl = fetch, maxBytes = 8 * 1024 * 1024 }) {
  const deadline = AbortSignal.timeout(15000);
  const response = await fetchImpl(url, {
    method: "POST", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, text, language, voice, audio_format: "pcm_s16le", sample_rate: 24000, ...(speed !== 1 ? { speed } : {}) }),
  });
  if (!response.ok) { const err = new Error("Voice unavailable"); err.errorCode = response.status; await response.body?.cancel(); throw err; }
  const chunks = []; let bytes = 0, carry = null;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Audio too large");
    if (!onChunk) { chunks.push(Buffer.from(chunk)); continue; }
    let data = carry ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
    carry = data.length % 2 ? data.subarray(data.length - 1) : null;
    if (carry) data = data.subarray(0, data.length - 1);
    if (data.length) await onChunk(data);
  }
  if (!bytes) throw new Error("Empty audio");
  return onChunk ? bytes : Buffer.concat(chunks);
}
module.exports = { synthesizeRest };

