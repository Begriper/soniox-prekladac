# Živý prekladač — produkčný Performance AudioWorklet v5

Verzia: `2.6.1-production-final-hardening`

Toto je súkromná produkčná verzia webového hlasového prekladača cez Soniox. Nadväzuje na fázy 1–4 a pridáva výkonovejší spôsob snímania mikrofónu cez `AudioWorklet`.

## Čo už obsahuje

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

- nový `public/audio-capture-worklet.js`,
- moderný `AudioWorkletNode` ako primárny spôsob snímania mikrofónu,
- fallback na `createScriptProcessor`, ak AudioWorklet nie je dostupný,
- PCM chunk-y po 2048 vzorkách,
- resampling výstupu na cieľových 16 kHz,
- v UI vidíš, či ide `AudioWorklet` alebo fallback.

## Lokálne spustenie

Vytvor `.env` podľa `.env.example`:

```env
SONIOX_API_KEY=tvoj_soniox_api_kluc
SONIOX_REGION=eu
APP_ACCESS_CODES=fero:123456,brat:654321
SESSION_SECRET=aspon_32_znakov_dlhy_nahodny_secret_123456
SONIOX_FINALIZE_TIMEOUT_SECONDS=4
```

Potom:

```powershell
npm install
npm run check
npm run audit
npm start
```

Otvor:

```txt
http://localhost:3000
```

## Fly.io deployment

Secrets:

```powershell
fly secrets set SONIOX_API_KEY="tvoj_soniox_api_kluc" -a soniox-prekladac
fly secrets set SONIOX_REGION="eu" -a soniox-prekladac
fly secrets set APP_ACCESS_CODES="fero:TVOJ_KOD,brat:BRATOV_KOD" -a soniox-prekladac
fly secrets set SESSION_SECRET="aspon_32_znakov_dlhy_nahodny_secret" -a soniox-prekladac
fly secrets set SONIOX_FINALIZE_TIMEOUT_SECONDS="4" -a soniox-prekladac
```

Deploy:

```powershell
fly deploy -a soniox-prekladac
```

Logy:

```powershell
fly logs -a soniox-prekladac
```

## Kontrolný checklist po nasadení

1. Login funguje a bez loginu sa nedostaneš do aplikácie.
2. Po štarte konverzácie vidíš `Počúvam… môžeš hovoriť (AudioWorklet)`.
3. Ak prehliadač AudioWorklet nepodporuje, aplikácia má ukázať fallback a stále fungovať.
4. Preklad funguje v režime `Reproduktor` aj `Slúchadlá`.
5. `Textový režim` vypne hovorený výstup a šetrí TTS requesty.
6. `Zopakovať hlas` prehrá posledné prijaté audio bez ďalšieho Soniox TTS requestu.
7. Pri stopnutí vidíš `Dokončujem posledné slová…`.
8. `npm run check` musí prejsť bez syntax chyby.

## Dôležité

- Fáza 5 nemení Soniox API kľúče ani login model.
- Denné kvóty sú stále in-memory a po reštarte Fly Machine sa vynulujú.
- REST TTS ostáva zámerne zachovaný, aby sa v tejto fáze nemenilo príliš veľa naraz.
- TTS WebSocket bude samostatná ďalšia fáza.


## Fáza 5.1 — final hardening

Táto verzia pridáva bezpečnostné HTTP hlavičky, `/api/diagnostics`, predvolený endpoint delay 500 ms, čitateľnejšie usage hodnoty a ochranu proti duplicitnému `playback_done`.

### Diagnostika po deployi

Po prihlásení môžeš v prehliadači alebo cez PowerShell overiť:

```powershell
Invoke-WebRequest "https://soniox-prekladac.fly.dev/api/diagnostics" -UseBasicParsing -WebSession $session
```

Jednoduchšie je otvoriť aplikáciu v prehliadači, prihlásiť sa a potom v tom istom prehliadači otvoriť:

```txt
https://soniox-prekladac.fly.dev/api/diagnostics
```

### Fly režim

`fly.toml` má `min_machines_running = 1`, čo je vhodné po pridaní platobnej karty, aby prvý request nemusel čakať na cold start.
