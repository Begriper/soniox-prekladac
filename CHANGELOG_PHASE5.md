# CHANGELOG — fáza 5: Performance AudioWorklet v5

Verzia: `2.6.0-production-performance-audioworklet`

Táto fáza nadväzuje na fázy 1–4. Cieľom je zlepšiť výkon a stabilitu snímania mikrofónu v prehliadači bez veľkého zásahu do backendového STT/TTS toku.

## Nové

- pridaný `public/audio-capture-worklet.js`, ktorý zachytáva mikrofón cez `AudioWorklet`,
- frontend sa najprv pokúsi použiť `AudioWorkletNode`,
- ak prehliadač AudioWorklet nepodporuje alebo zlyhá jeho inicializácia, aplikácia automaticky použije fallback cez pôvodný `createScriptProcessor`,
- AudioWorklet posiela menšie PCM chunk-y po 2048 vzorkách namiesto pôvodného 4096-sample fallbacku,
- AudioWorklet normalizuje výstup na cieľových 16 kHz, aj keď prehliadač reálne otvorí inú sample rate,
- UI v riadku odozvy ukazuje, či beží `AudioWorklet` alebo `fallback audio`,
- pridaná interná kontrola a počítanie dropped audio chunk-ov pri zahltenom WebSockete,
- `npm run check` kontroluje aj nový worklet súbor,
- verzia backendu zvýšená na `2.6.0-production-performance-audioworklet`.

## Zachované

- login/session z fázy 1,
- credit guard a kvóty z fázy 2,
- server-ready audio gate a graceful Soniox stop z fázy 3,
- režim Reproduktor/Slúchadlá, Textový režim, Stop audio a Zopakovať hlas z fázy 4,
- REST TTS ostáva stabilný default.

## Poznámky

- Toto ešte nie je prechod na Soniox TTS WebSocket. Ten patrí do ďalšej výkonovej fázy, lebo zasahuje do serverového TTS queue a prehrávania audia.
- `createScriptProcessor` ostáva len ako fallback pre staršie/nekompatibilné prehliadače.
