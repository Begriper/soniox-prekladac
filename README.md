# Živý prekladač — v6.0 production hardening

Verzia: `2.7.0-v6-production-hardening`

Súkromný produkčný webový hlasový prekladač cez Soniox pre private/family použitie. v6.0 je konzervatívna hardening verzia: nemení stabilný Soniox STT tok, nemení login/session model a ponecháva REST TTS ako predvolený a stabilný TTS transport.

## Čo aplikácia obsahuje

### Fáza 1 — auth

- login obrazovka pred aplikáciou,
- session cookie,
- ochrana API endpointov,
- ochrana WebSocketu pred neprihláseným používateľom.

### Fáza 2 — credit guard

- denné limity podľa používateľa,
- limit aktívnych WebSocket spojení,
- idle timeout,
- WebSocket heartbeat,
- `/api/usage`.

### Fáza 3 — audio stability

- audio sa posiela až po `server_ready`,
- krátky pre-ready buffer,
- korektné Soniox end-of-audio ukončenie,
- fallback timeout pre finalizáciu.

### Fáza 4 — conversation UX

- režim `Reproduktor` / `Slúchadlá`,
- `Textový režim`,
- `Stop audio`,
- `Zopakovať hlas`,
- stavové čipy pre server, mikrofón, prehrávanie a režim.

### Fáza 5 — performance AudioWorklet

- `public/audio-capture-worklet.js`,
- `AudioWorkletNode` ako primárny spôsob snímania mikrofónu,
- fallback na `createScriptProcessor`, ak AudioWorklet nie je dostupný,
- PCM chunk-y po 2048 vzorkách,
- resampling výstupu na cieľových 16 kHz,
- v UI vidíš, či ide `AudioWorklet` alebo fallback.

### Fáza 5.1 — final hardening

- bezpečnostné HTTP hlavičky,
- chránený endpoint `/api/diagnostics`,
- predvolený endpoint delay 500 ms,
- čitateľnejšie usage hodnoty,
- ochrana proti duplicitnému `playback_done`.

### Fáza 6.0 — conservative production hardening

- `.dockerignore` chráni aj `.env.*`, pričom `.env.example` ostáva bezpečný príklad,
- jednotný release label `2.7.0-v6-production-hardening`,
- verejný `/health` vracia iba minimálne bezpečné info,
- detailné runtime info ostáva v `/api/diagnostics` za session,
- diagnostika ukazuje aktuálny TTS transport a pripravené fallback counters,
- session metrics obsahujú baseline timing pre tokeny, finálny preklad, TTS generovanie, `play_audio` a `playback_done`,
- ľahký test harness cez Node built-in test runner bez nových dependencies,
- drobný mobile UX polish pre jasnejší režim `Reproduktor` / `Slúchadlá`.

## Dôležité produkčné rozhodnutia

- REST TTS je stále predvolený transport.
- Soniox TTS WebSocket nie je vo v6.0 primárny transport.
- TTS WebSocket môže byť najskôr budúci v6.1 experiment za feature flagom a s REST fallbackom.
- Soniox API key zostáva iba na backend-e.
- Login/session, WebSocket auth, origin check, security headers a usage limity ostávajú zachované.
- Denné kvóty a sessions sú stále in-memory a po reštarte Fly Machine sa vynulujú. To je akceptované pre private/family použitie, nie pre verejný multi-user SaaS.

## Lokálne spustenie

Vytvor `.env` podľa `.env.example`. Použi vlastné hodnoty, nikdy necommituj reálne secrets.

Potom:

```powershell
npm install
npm run check
npm test
npm run audit
npm start
```

Otvor:

```txt
http://localhost:3000
```

## Diagnostika

Verejný health endpoint je zámerne minimálny:

```txt
/health
```

Po prihlásení môžeš v tom istom prehliadači otvoriť detailnú diagnostiku:

```txt
/api/diagnostics
```

Diagnostika obsahuje bezpečné runtime informácie pre owner debugging vrátane:

- verzie aplikácie,
- Fly runtime identifikátorov,
- Soniox regiónov/hostov,
- aktuálneho TTS transportu (`rest`),
- fallback counters pripravených pre budúce experimenty,
- usage snapshotu,
- security flags.

## Testovanie

Syntax check:

```powershell
npm run check
```

Node built-in test runner:

```powershell
npm test
```

Aktuálne testy pokrývajú čisté helper funkcie pre normalizáciu vstupov a TTS chunkovanie.

## Fly.io deployment

Deployment sa nerobí automaticky. Pred nasadením musí prejsť:

```powershell
npm run check
npm test
npm run audit
```

Nasadenie na Fly rob iba po explicitnom schválení ownera:

```powershell
fly deploy -a soniox-prekladac
```

## Kontrolný checklist po nasadení

1. Login funguje a bez loginu sa nedostaneš do aplikácie.
2. Po štarte konverzácie vidíš `Počúvam… môžeš hovoriť (AudioWorklet)` alebo fallback audio.
3. Preklad funguje v režime `Reproduktor` aj `Slúchadlá`.
4. V režime `Reproduktor` sa mikrofón počas hovoreného prekladu stlmí.
5. V režime `Slúchadlá` mikrofón zostáva aktívny; používaj ho iba so slúchadlami.
6. `Textový režim` vypne hovorený výstup a šetrí TTS requesty.
7. `Zopakovať hlas` prehrá posledné prijaté audio bez ďalšieho Soniox TTS requestu.
8. Pri stopnutí vidíš `Dokončujem posledné slová…`.
9. `/health` vracia iba minimálne bezpečné info.
10. `/api/diagnostics` je dostupné iba po prihlásení.
11. `npm run check` a `npm test` prešli pred deployom.

## Stabilné časti, ktoré netreba meniť bez dôvodu

- REST TTS default a fallback,
- speaker-mode microphone mute,
- login/session,
- WebSocket session protection,
- origin check,
- security HTTP headers,
- usage limity,
- Soniox STT flow.
