# Hĺbková analýza — 26. 10. 2026

Doplnok k `claude-review-2026-10-26.md`. Zdroje: celý kód (`main` = produkcia v49), aktuálna Soniox API dokumentácia, open-source projekty nad Soniox API, prehliadka UI na mobile (375 px, lokálny mock server).

Codex (gpt-6.1-sol) revíziu nedokončil: CLI 0.164 na tomto počítači nevie spustiť žiadny príkaz (`helper_sandbox_lock_failed`, `SetNamedSecurityInfoW ... 5` na `C:\Users\feros\.codex\.sandbox-bin`, ktorý vlastní `BUILTIN\Administrators`). Pripravený prompt je v scratchpade; dá sa spustiť v Codex aplikácii.

## A. Kritické — s termínom

### A1. Soniox od 15. 1. 2027 odmietne autentifikáciu, ktorú appka používa
- Soniox označil pole `api_key` v štartovacej správe STT aj v konfigurácii TTS streamu za **deprecated**. Od **15. 1. 2027** sa spojenie, ktoré posiela kľúč iba tam, **odmietne**. Kľúč sa má posielať pri pripojení: hlavička `Authorization: Bearer <key>` alebo WebSocket subprotokol `soniox-api-key`.
- Appka ho posiela presne deprecated spôsobom: `speech-session.js:174` (STT) a `tts-transport.js:72` (každý TTS stream).
- Bez opravy **prestane od 15. 1. 2027 fungovať celý preklad**. Oprava je malá: `new WebSocket(url, { headers: { Authorization: "Bearer " + key } })` a odstrániť `api_key` z JSON.
- Rovnako to riešia iní: sokuji v0.45.1 „sign in the way Soniox requires from 15 January 2027“.
- Zdroje: [STT WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api), [TTS WebSocket API](https://soniox.com/docs/api-reference/tts/websocket-api).

## B. Chyby nájdené v kóde

### B1. PTT režim spadne po ~20 s bez stlačenia tlačidla
- Soniox ukončí STT stream chybou 408 `request_timeout`, ak 20 s nepríde audio ani `keepalive` ([keepalive](https://soniox.com/docs/stt/rt/connection-keepalive)).
- V PTT, keď nikto nedrží tlačidlo, server audio zahadzuje (`speech-session.js:155`). Keepalive sa však posiela iba ak `!acceptAudio || muted()` (`speech-session.js:40`). V tomto stave neplatí ani jedno.
- Výsledok: po ~20 s ticha v PTT príde chyba a rozhovor sa ukončí hláškou „Rozpoznávanie nie je dostupné“.
- Oprava: posielať keepalive aj keď `conversationMode === "ptt" && !pttActive`.

### B2. Prewarm TTS je zbytočný
- Soniox ukončí TTS stream s `request_timeout`, ak niekoľko sekúnd nepríde `text` (keepalive tento časovač neresetuje).
- Appka robí prewarm oboch smerov hneď po otvorení STT (`speech-session.js:184`). Prvá veta príde zvyčajne o viac sekúnd neskôr, keď je prewarm stream už mŕtvy.
- Úspora ~400 ms sa teda nikdy neprejaví. Lepšie: otvoriť stream pri prvom ne-finálnom prekladovom tokene danej výpovede.

### B3. Priebežné TTS (slúchadlá) môže padnúť pri pomalej reči
- V režime slúchadiel sa prekladové tokeny posielajú do otvoreného TTS streamu priebežne (`speech-session.js:253`, `tts-transport.js:111`).
- Ak hovoriaci spraví v polovici vety pauzu dlhšiu ako „niekoľko sekúnd“ (limit TTS) a endpoint ešte nepríde, Soniox stream ukončí. Hlas sa preruší s „Hlas sa nepodarilo dokončiť“.
- Oprava: pri pauze bez nového textu uzavrieť stream (`text_end:true`) a zvyšok vety poslať do nového.

### B4. (z prvej analýzy) celý prepis pri každom tokene, odpojenie pri prepnutí appky, bez auto-reconnectu
Platí naďalej; podrobnosti sú v `claude-review-2026-10-26.md`.

## C. Nevyužité možnosti Soniox

| Funkcia | Stav | Prínos pre teba |
|---|---|---|
| TTS `speed` (0.7–1.3) | nepoužíva sa | rýchlejší hlas = menšie zaostávanie prekladu za rozhovorom |
| `max_endpoint_delay_ms` | 1500 ms | Soniox STS návod používa 500; skúsiť 800–1000 |
| `client_reference_id` | nepoužíva sa | v Soniox usage logoch uvidíš, koľko minul ktorý člen rodiny |
| `return_timestamps` (TTS) | nepoužíva sa | zvýrazňovanie práve vyslovovaného slova (karaoke efekt) |
| `language_hints_strict` | nepoužíva sa | potlačí zamieňanie s tretím jazykom (overiť podporu v v5) |
| `enable_speaker_diarization` | nepoužíva sa | netreba, smer určuje jazyk |

## D. Čo robia iní (open source nad Soniox)

- **[sokuji](https://github.com/kizuna-ai-lab/sokuji)** (1,4k ★, aktívny): obojsmerný preklad na stretnutia. Už prešiel na novú autentifikáciu. Opravoval chybu, keď sa preklad hovoril nesprávnym hlasom, a pridal zvýrazňovanie titulkov od prvého slova.
- **[my-translator](https://github.com/phuc-nt/my-translator)** (1,3k ★): v obojsmernom režime TTS **vypína**, aby sa mikrofón nechytal vlastného hlasu (appka to rieši stlmením mikrofónu na reproduktore). Má „smart scroll“ (posúva sa len keď si dole) a veľké A-/A+ písmo pre čítanie z diaľky.
- **[Soniox STS demo](https://github.com/soniox/soniox_examples/tree/master/apps/soniox-speech-to-speech-translation-demo)**: jeden TTS stream na výpoveď, `<end>` ho uzavrie. Appka to robí rovnako.
- **Komunita ([HN](https://news.ycombinator.com/item?id=49474353), [Artificial Analysis](https://x.com/ArtificialAnlys/status/2067257887815295291))**: v5 Real-Time je na špičke presnosti a latencie. Porovnania latencie s Google/OpenAI sú zatiaľ iba neoficiálne dojmy.

## E. Čo vyhodiť alebo zjednodušiť

- `server-utils.js`: 10 exportov sa v aplikácii nepoužíva (`bytesLength`, `formatKb`, `formatMb`, `normalizeSttLanguageList`, `normalizeTtsVoiceList`, `validateReplayTranslationRequest`, `normalizeEndpointDelay`, `normalizeOutputMode`, `normalizeBoolean`, `normalizeVoiceId`). Zmazať aj ich testy.
- `CHANGELOG_PHASE2…6_1.md` (7 súborov) a `DEPLOY_V5_1.ps1`: história, presunúť do `docs/archive/` alebo zmazať (sú v Gite).
- Fly secret `SONIOX_FINALIZE_TIMEOUT_SECONDS`: kód ho nečíta. Zmazať.
- `APP_ACCESS_KEY` fallback (`server.js:27`): starý formát, zmazať.
- `ScriptProcessor` fallback (`public/app.js:418`): všetky podporované prehliadače majú AudioWorklet. Zmazať.
- UI: 4 filtre hlasu × 2 strany, vyhľadávanie jazyka ako samostatné pole, vysvetľujúce odseky (viď F).

## F. Dizajn — prečo pôsobí rozbito a čo s tým

### Čo som videl na mobile (375 px)
1. **Hlavná obrazovka je formulár, nie rozhovor.** Hore „01 / PRÍPRAVA“, dve karty jazykov (vyhľadávacie pole + select pre každý jazyk), prostredie, prepínače. Samotný prepis je až pod nimi a na začiatku je prázdna karta.
2. **Príliš veľa textu.** „Mikrofón je vypnutý.“, „História sa ukladá iba na požiadanie…“, „Reproduktor je predvolený režim…“. Prémiové appky vysvetľujú stavom a ikonou, nie odsekmi.
3. **Rovnocenné tlačidlá všade.** Uložiť / História / Nový rozhovor / Kopírovať / Iba text / Oproti sebe / Reproduktor majú približne rovnakú váhu ako hlavná akcia.
4. **„Zastaviť hlas“ je vždy na obrazovke**, aj keď nič nehrá (iba zašednuté).
5. **Nastavenia sú dlhý formulár**: zvukový výstup, potom 2× (vyhľadávanie, typ, prízvuk, vek, štýl, hlas, ukážka) nad 200 hlasmi.
6. **Prihlásenie je marketingová stránka** („Rozumieme si.“) pre súkromnú appku, kde chceš byť za 2 sekundy dnu.

### Návrh štruktúry (mobile-first)
- **Hore:** kompaktný pás jazykov `🇸🇰 Slovenčina ⇄ 🇩🇪 Deutsch`. Ťuknutie otvorí výber jazyka ako bottom sheet (naposledy použité hore, vyhľadávanie v ňom).
- **Stred = rozhovor:** bubliny ako v chate (ja vpravo, druhá osoba vľavo). Preklad veľkým písmom (24–28 px), originál menší a stlmený. Živý text sa zvýrazňuje. Smart scroll.
- **Dole:** jedno veľké okrúhle tlačidlo mikrofónu s prstencom stavu (počúvam / prekladám / hovorím). „Zastaviť hlas“ sa objaví iba počas prehrávania. V PTT dve veľké polovice s vlajkami.
- **Režim „oproti sebe“** ako hlavná funkcia: rozdelená obrazovka, horná polovica otočená o 180° pre druhú osobu, každý vidí svoj jazyk veľkým písmom.
- **Nastavenia ako bottom sheet s 3 sekciami:** Hlas (6 odporúčaných hlasov s ukážkou + „Ďalšie hlasy“), Rozhovor (prostredie, AUTO/PTT, reproduktor/slúchadlá, rýchlosť hlasu), Účet (spotreba dnes, rodina, odhlásiť).
- **Prihlásenie:** jedna čistá karta s logom a poľom na kód, bez hero sekcie.
- **Detaily kvality:** haptika pri štarte a stope (Android), plynulé prechody stavov, PNG ikony a splash screen pre plochu, jedna akcentová farba, tmavý aj svetlý režim.

## G. Odporúčané poradie

1. **A1 autentifikácia** (termín 15. 1. 2027) + **B1 PTT keepalive**: malé, kritické, nasaditeľné hneď.
2. **B2/B3 TTS stream lifecycle** + `speed` + endpoint 800–1000 ms: latencia a spoľahlivosť hlasu.
3. **Delta prepisu + auto-reconnect**: spoľahlivosť na ulici.
4. **Upratanie** (sekcia E).
5. **Redizajn** (sekcia F): najprv návrh obrazoviek v Claude Design, po schválení implementácia v `public/`.
