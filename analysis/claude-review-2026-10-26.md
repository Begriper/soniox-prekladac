# Claude review — 26. 10. 2026

Rozsah: aktuálny pracovný strom na `codex/dynamic-soniox-capabilities` (verzia 3.1.0, nasadená ako Fly release 48). Prečítaný celý serverový aj frontend kód. Produkciu, secrets ani Soniox API som nevolal.

Overenie: `npm run check` OK, `npm test` 60/60 OK (lokálne Node 22.14, projekt vyžaduje Node 24). `npm audit --omit=dev`: **2 nové zraniteľnosti**.

## Priorita 1 — riziko straty a bezpečnosť

1. **Kód produkcie nie je v Gite a repo nemá remote.** HEAD (7. 7. 2026) obsahuje starú verziu (`server.js` 2261 riadkov); celá verzia 3.x nasadená na Fly (release 47, 48) existuje iba ako necommitnuté zmeny na jednom disku. `git remote -v` je prázdny. Odporúčanie: skontrolovať diff, commitnúť, pridať privátny GitHub remote.
2. **npm audit (nové advisories po 24. 9.):**
   - `body-parser <1.20.9` — high, DoS cez skomprimované telo requestu ([GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)). `express.json()` beží pred autentifikáciou (`server.js:104`), Origin hlavičku vie útočník nastaviť sám, takže `/api/login` je dosiahnuteľný bez prihlásenia.
   - `proxy-addr` — critical, IP spoofing pri `trust proxy` subnetoch ([GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)). Aplikácia `trust proxy` nepoužíva (IP berie z `Fly-Client-IP`), praktický dopad je nízky.
   - Oprava: `npm audit fix` (express 4.22.3), potom testy a nový deploy.

## Priorita 2 — spoľahlivosť na mobile

3. **Server pri každom tokene posiela celý prepis.** `speech-session.js:80` volá `serializeConversationItems` nad celým timeline (až 40 000 znakov, 990 položiek) a posiela ho niekoľkokrát za sekundu. Dôsledky: zbytočné mobilné dáta, CPU na telefóne (`app.js:324` robí `JSON.stringify` každej položky pri každom renderi) a pri slabom signáli môže `bufferedAmount > 512 KB` (`speech-session.js:59`) ukončiť reláciu ako „slow connection“ — práve v dlhom rozhovore. Oprava: posielať iba zmenené položky (delta podľa `id`).
4. **Prepnutie aplikácie = koniec rozhovoru.** `visibilitychange` → `hidden` okamžite odpojí (`app.js:617`). Notifikácia, rýchla kontrola správy alebo hovor ukončí preklad. Po výpadku siete tiež nie je automatické obnovenie. Návrh: po návrate/obnove siete automaticky znovu pripojiť s rovnakými nastaveniami (prepis už zostáva).
5. **iOS Safari audio.** Pri aktívnom mikrofóne iOS často smeruje zvuk do slúchadla pri uchu alebo stíši reproduktor. Safari 16.4+ má `navigator.audioSession.type = "play-and-record"`; zatiaľ sa nepoužíva. Overiť na fyzickom iPhone.
6. **Capture `AudioContext({ sampleRate: 16000 })`** (`app.js:402`). Worklet už prevzorkuje sám, takže fixná 16 kHz nie je potrebná; niektoré prehliadače (historicky Firefox) odmietajú `createMediaStreamSource` pri inej frekvencii ako má zariadenie. Bezpečnejšie je predvolené `new AudioContext()`. Overiť.
7. **PWA ikony.** Manifest má iba SVG. iOS potrebuje `apple-touch-icon` PNG 180 px, Android PNG 192/512 (+ maskable) pre spoľahlivú inštaláciu.
8. Drobnosť: ak obnova zoznamu vlastných hlasov zlyhá po 10 min, klon sa uprostred rozhovoru označí ako nedostupný (`catalog.js:84`). Fail-closed je správne, ale používateľ stratí hlas.

## Soniox — je to aktuálne?

Áno. Projekt používa najnovšie modely a odporúčaný tok:

| Funkcia | Stav v projekte | Aktuálna Soniox doc |
|---|---|---|
| STT model | `stt-rt-v5` | najnovší real-time, vydaný 16. 6. 2026 |
| TTS model | `tts-rt-v2` | najnovší, GA 11. 8. 2026; v1 deprecated |
| Preklad | natívny `two_way` / `one_way` | odporúčaný spôsob |
| Priebežné TTS | `text_end:false` po tokenoch (slúchadlá), `<end>` uzavrie stream | zhodné s oficiálnym STS návodom |
| Context | profily `general`/`terms`/`translation_terms` | podporované |
| Hlasy | shared voices + vlastný klon | podporované |

Príležitosť: `ENDPOINT_DELAY_MS=1500` (predvolené). Oficiálny STS príklad používa `max_endpoint_delay_ms: 500`. Skúsiť 800–1000 cez Fly secret/env a zmerať presnosť vs. latenciu — bez zmeny kódu.

Zdroje: [STT modely](https://soniox.com/docs/stt/models), [TTS modely](https://soniox.com/docs/tts/models), [STS preklad](https://soniox.com/docs/translation/sts-translation).

## Web (PWA) vs. natívna aplikácia

Odporúčanie: **ostať pri PWA.** Prístup z ľubovoľného zariadenia, bez App Store, API kľúč ostáva na serveri, jeden kód. Natívny obal (napr. Capacitor nad existujúcim frontendom) má zmysel až keď fyzické testy ukážu tvrdé limity: beh pri zamknutej obrazovke, iOS smerovanie zvuku, Bluetooth.

## Spolupráca Claude + Codex

- Pracovať v jednom lokálnom priečinku je v poriadku, ale **nie súčasne** na rovnakých súboroch. Každá úloha vlastná vetva, commit po schválení diffu.
- GitHub remote = záloha + história, ktorú vidia oba nástroje.
- V Claude Code je nainštalovaný Codex plugin (`/codex:rescue`, `/codex:setup` s voliteľnou review bránou) — Claude môže delegovať druhý pohľad alebo review na Codex bez ďalšieho MCP.

## Navrhované poradie

1. Commit súčasného stavu + privátny GitHub remote.
2. `npm audit fix`, testy, deploy.
3. Delta správy prepisu (bod 3) + auto-reconnect (bod 4).
4. iOS audio session, capture sample rate, PNG ikony.
5. Ladenie `ENDPOINT_DELAY_MS` meraním na telefóne.
6. Dizajn (Claude Design) až po stabilite.
