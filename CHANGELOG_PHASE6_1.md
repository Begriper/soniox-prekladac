# Fáza 6.1 — Hybrid WebSocket TTS

Verzia: `2.8.0-v6.1-hybrid-tts`

## Zmeny

- Soniox TTS WebSocket je primárny transport; REST ostáva automatický fallback pred prvým audio chunkom.
- Pribudol samostatný `tts-transport.js` s persistentným spojením, prewarm streamami, keepalive, cancel a reconnect logikou.
- Režim `Reproduktor` čaká na Soniox `<end>`, stlmí mikrofón a následne streamuje PCM audio bez čakania na celý WAV.
- Browser prehráva `pcm_s16le` chunky cez Web Audio API a zachováva replay aj presný `playback_done`.
- `Spoken translation` je dostupný priamo pri výbere hlasu a jeho stav sa ukladá do `localStorage`.
- Diagnostika obsahuje WebSocket host, reconnecty, zlyhania, fallbacky, audio chunky a ukončené streamy.
- TTS audio kvóty sa kontrolujú a účtujú pred odoslaním každého PCM chunku.

## Konfigurácia

```env
TTS_TRANSPORT=auto
```

Podporované hodnoty sú `auto`, `ws` a `rest`. Predvolená hodnota je `auto`.

## Overenie

- `npm run check`
- `npm test`
- `npm run audit`
- desktop a mobile UI kontrola cez Playwright

