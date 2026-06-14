# CHANGELOG — fáza 6: Conservative production hardening

Verzia: `2.7.0-v6-production-hardening`

## Zhrnutie

Fáza 6 je konzervatívna production hardening verzia. Cieľom je vyššia stabilita, lepšia diagnostika, základné testy a menší mobile UX polish bez zmeny stabilného STT/TTS jadra.

## Nové a upravené

- Zjednotený release label na `2.7.0-v6-production-hardening`.
- `.dockerignore` teraz ignoruje aj `.env.*` a explicitne povoľuje iba bezpečný `.env.example`.
- Verejný `/health` bol minimalizovaný na bezpečný health check bez Soniox hostov, regiónov alebo počtu aktívnych spojení.
- Detailné runtime informácie ostávajú v chránenom `/api/diagnostics` za session.
- `/api/diagnostics` ukazuje aktuálny TTS transport (`rest`) a fallback counters pripravené pre budúce experimenty.
- Session metrics baseline doplnené o:
  - `tts_transport`,
  - prvý token,
  - prvý finálny preklad,
  - TTS generation timing,
  - počet `play_audio` správ,
  - počet `playback_done` udalostí,
  - TTS error count,
  - failure reason v session summary.
- Pridaný ľahký test harness cez Node built-in test runner bez nových dependencies.
- Čisté helper funkcie pre normalizáciu vstupov a TTS chunkovanie boli minimálne extrahované do `server-utils.js`.
- Mobile UX polish bez redesignu:
  - jasnejší popis režimu `Reproduktor` / `Slúchadlá`,
  - jasnejšie status texty počas speaker-mode TTS mute,
  - responzívnejší utility button row.

## Zachované

- REST TTS zostáva predvolený a stabilný transport.
- Soniox TTS WebSocket nie je vo v6.0 primárny transport.
- REST TTS fallback nebol odstránený.
- Soniox STT flow nebol zámerne menený.
- Login/session model ostáva zachovaný.
- WebSocket auth a origin check ostávajú zachované.
- Security HTTP headers ostávajú zachované.
- Usage limity ostávajú zachované.
- Speaker-mode microphone mute ostáva zachovaný.
- Žiadny React/Next/Vite/TypeScript migration.
- Žiadna databáza ani persistent user accounts.
- Žiadny Google Translate benchmark v produkčnom toku.

## Testovanie

Pred nasadením musia prejsť:

```powershell
npm run check
npm test
```

`npm test` používa Node built-in test runner.

## Poznámka k TTS WebSocket

TTS WebSocket je vhodný až ako budúci v6.1 experiment za feature flagom, s REST TTS ako default fallbackom a po vyhodnotení metrics baseline z v6.0.
