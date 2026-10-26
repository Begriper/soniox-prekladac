# Plán na perfektnú úroveň — 26. 10. 2026

Spoločná analýza dvoch modelov nad `main` (produkcia v3.2.0, Fly release v50):

- **Claude (Opus 5.5):** celý kód, Soniox dokumentácia a komunita (cez subagenta), UI na mock serveri pri 360, 390 a 768 px, reprodukcie.
- **Codex (`gpt-6.1-sol`, effort `high`):** `adversarial-review` nad celým kódom a samostatná analýza iba na čítanie s rovnakým zadaním.

Nadväzuje na `claude-review-2026-10-26.md` a `deep-analysis-2026-10-26.md`. Body, ktoré v3.2.0 už opravila (autentifikácia v hlavičke, PTT keepalive, TTS prewarm a rozdelenie pri pauze, rozdielový prepis, auto-reconnect, rýchlosť hlasu, `client_reference_id`, upratanie mŕtveho kódu), sa tu neopakujú.

Stav overenia: `npm run check` OK, `npm test` 56/56 OK (Node 24). Kód sa v tejto fáze nemenil.

**Legenda:** Kto = kto nález našiel (C = Claude, X = Codex, C+X = obaja nezávisle). Overenie = ako bol nález overený. Náročnosť: S (do pol dňa), M (1–2 dni), L (viac dní).

---

## 1. Zhrnutie

1. **Spoľahlivosť na ulici má ešte dve diery.** Auto-reconnect po skutočnom výpadku siete nefunguje, lebo server odmietne nové spojenie s `409`, kým nezistí, že staré je mŕtve (25–50 s). Overené reprodukciou. Druhá diera: počítadlo pokusov sa nuluje príliš skoro (Codex), takže nestabilná sieť pokusy nikdy neukončí a míňa denný limit relácií.
2. **Každý deploy odhlási všetkých.** Prihlásenia sú iba v pamäti servera.
3. **Latencia má najväčšiu rezervu v predvolenom režime Reproduktor.** TTS sa tam začína až po `<end>` a nastavenie endpointu ešte nepoužíva odporúčanie Sonioxu pre nízku latenciu.
4. **Codex našiel ďalšie skryté chyby**: koniec reči pri PTT, zaseknutá fronta hlasu, reconnect slučka, miešanie verzií v service workeri, REST fallback, ktorý na pomalom spojení preruší dlhší hlas, synchrónny zápis do SQLite pri každom audio rámci a ďalšie. Všetky som overil v kóde. Žiadny model nenašiel P0.
5. **Meranie latencie dnes nevidí endpointing** (Codex), preto musí ísť pred ladením endpointu, nie po ňom.
6. **Tvoja požiadavka, admin účet a správa používateľov**, je navrhnutá v sekcii 5. Dá sa postaviť na existujúcej SQLite databáze na Fly volume, bez novej služby a bez nových npm balíkov.

---

## 2. Spoľahlivosť a chyby

### R1. Auto-reconnect po výpadku siete skončí trikrát na `409` — P1, S
- **Kto:** C. **Overenie:** reprodukcia na mock serveri: prvé spojenie zostane visieť (ako telefón, ktorý stratil signál). Pokusy po 1,5 s, 3 s a 6 s (presne oneskorenia klienta) dostali `409`, `409`, `409`.
- **Príčina:** `server.js` pri upgrade odmietne používateľa, ktorý už má rozhovor (`conversations…some(c => c.auth.username === …)` → 409). Server mŕtve spojenie zistí až heartbeatom každých 25 s, teda za 25–50 s. Klient to vzdá po troch pokusoch, ~10 s.
- **Dopad:** presne situácia, pre ktorú auto-reconnect vznikol (Wi-Fi → LTE, výťah, tunel), končí hláškou „Spojenie sa prerušilo“ a ručným pokračovaním, ktoré tiež môže dostať 409. Starý STT stream medzitým beží a platí sa.
- **Oprava:** keď sa pripojí rovnaké prihlásenie (`auth.id`), starý rozhovor ukončiť (`end("…", "replaced")`) a nový prijať. Heartbeat skrátiť na 10 s. Test: reprodukčný skript z tejto analýzy prepísať do `test/`.

### R2. `server_ready` nuluje počítadlo reconnectov — P1, S
- **Kto:** X (adversarial review aj samostatná analýza F06). **Overenie:** C v kóde: `public/app.js:414` nuluje `reconnectAttempts` pri každom `server_ready`.
- **Dopad:** pri spojení, ktoré padá krátko po pripojení, sa pokusy opakujú donekonečna. Každý pokus si rezervuje dennú reláciu (limit 20), takže rodinný člen môže na slabom signáli minúť denný limit za pár minút.
- **Oprava:** nulovať až po 30 s stabilného spojenia. Spolu s R1 a R6 v jednom PR.

### R3. Každý deploy alebo reštart odhlási všetkých — P1, S–M
- **Kto:** C. **Overenie:** kód: `sessions = new Map()` v `server.js`, nič sa neukladá.
- **Dopad:** po každom nasadení musí každý člen rodiny znova zadať kód. Pri admin správe používateľov by to bolo ešte nepríjemnejšie.
- **Oprava:** relácie ukladať do SQLite (iba SHA-256 hash ID, expirácia, používateľ). Patrí do admin balíka (sekcia 5, krok A1).

### R4. Service worker môže spojiť nový HTML so starým `app.js` — P2, S
- **Kto:** X. **Overenie:** C v kóde: `public/sw.js` je network-first pre každý súbor zvlášť a pri chybe vráti cache pod rovnakou URL. Na slabom signáli môže HTML prísť nové a `app.js` z cache starý. Codex to reprodukoval a výsledkom je prázdna appka.
- **Oprava:** verzované URL (`/app.js?v=3.3.0` atď. z `APP_VERSION`), cache pomenovaná podľa verzie, HTML z cache iba spolu s jeho verziou súborov.

### R5. Pustenie PTT odreže koniec reči (~64 ms) — P1, S
- **Kto:** X (adversarial review aj F01, obe s reprodukciou). **Overenie:** C v kóde: `finishPtt` nastaví `pttPressed = false` skôr, než worklet odošle posledný neúplný blok (1024 vzoriek = 64 ms). `sendPcm` ho potom zahodí.
- **Dopad:** odrezaná posledná hláska alebo slabika, horšie rozpoznanie posledného slova.
- **Oprava:** pred vypnutím brány poslať workletu `flush`, počkať na `flushed`, až potom ticho a `ptt_end` (mechanizmus už existuje v `stopCapture`).

### R6. Zrušený hlas počas obnovy katalógu zasekne frontu — P2, S
- **Kto:** X. **Overenie:** C v kóde: `pump()` čaká na `refreshVoices()` s nastaveným `preparingJob`. Ak medzitým príde `stop_audio` alebo vypnutie/zapnutie hlasu a nová výpoveď, nový `pump()` skončí na `preparingJob` a starý sa vráti bez spracovania fronty. Okno vzniká iba vtedy, keď je katalóg starší ako 10 minút (potom `await` robí sieťové volania).
- **Oprava:** po uvoľnení `preparingJob` znovu zavolať `pump()`. Lepšie je odstrániť príčinu, pozri L4.

### R7. Reconnecty a prepnutie appky míňajú denný limit relácií — P2, S
- **Kto:** C (nadväzuje na R2). **Overenie:** kód: každý upgrade volá `store.reserve(…, { sessions: 1 })`. Rovnako každý návrat do appky (prepnutie appky = `client_stop`) aj každý reconnect. Pri `429` z upgradu klient ukáže iba „Spojenie sa prerušilo“, nie „Denný limit“.
- **Oprava:** obnovenie do 5 minút od predchádzajúcej relácie toho istého prihlásenia nepočítať ako novú reláciu. Pri vyčerpaní limitu poslať jasnú chybu (WS sa prijme, pošle sa `error` s `quota_exceeded`, potom sa zatvorí).

### R8. Limit 3 súbežných TTS streamov na celý Soniox účet — P2, S
- **Kto:** C. **Overenie:** [Soniox TTS limits](https://soniox.com/docs/tts/rt/limits-and-quotas): predvolene 3 súbežné streamy cez všetky spojenia. Kód: na reláciu až 2 prewarm streamy + 1 aktívny (`tts-transport.js` prewarm `slice(0, 2)`, limit 4 na spojenie), globálny rozpočet žiadny, `MAX_ACTIVE_WS_TOTAL=3`.
- **Dopad:** keď naraz hovoria dvaja členovia rodiny v režime slúchadiel, ďalší stream môže dostať `max_concurrent_streams_reached` → „Hlas sa nepodarilo dokončiť“.
- **Oprava:** prewarm najviac 1 stream na reláciu, globálny počítadlový rozpočet TTS streamov v procese, pri preťažení čakať namiesto chyby. Prípadne požiadať Soniox o vyšší limit.

### R10. REST fallback pošle dlhý hlas naraz a na pomalom spojení ho preruší — P2, M
- **Kto:** X (F02, reprodukcia s 25 s audia: prerušené po 512 KiB). **Overenie:** C v kóde: `speech-session.js` po REST odpovedi synchrónnou slučkou volá `audio()` po 16 KiB bez čakania. `audio()` vyhodí `client_unavailable`, keď `bufferedAmount` prekročí 512 KiB.
- **Dopad:** záložná cesta, ktorá má hlas zachrániť, na slabom signáli prehrá iba začiatok. Navyše čaká na celé vygenerovanie.
- **Oprava:** REST telo spracúvať priebežne a posielať so spätným tlakom (čakať na pokles `bufferedAmount`).

### R11. Prepnutie appky zahodí poslednú výpoveď — P2, M
- **Kto:** X (F03). **Overenie:** C v kóde: pri `visibilitychange → hidden` sa pošle `client_stop` a hneď `disconnect()`, ktorý odpojí handlery a zavrie WS. Server potom zruší STT aj TTS a finálny výsledok poslednej vety sa stratí.
- **Oprava:** zastaviť capture, poslať flush + `client_stop` a krátko (≤ 1,5 s, kým prehliadač ešte beží) počkať na finálne tokeny. Ak to nestihne, vetu označiť „prerušené, zopakuj“.

### R12. Mikrofón môže „hluchnúť“, kým UI ukazuje „Počúvam“ — P2, M
- **Kto:** X (F04). **Overenie:** C v kóde: v `app.js` nie je obsluha `MediaStreamTrack` `ended`/`mute`, `AudioContext` `statechange`, `processorerror` ani `devicechange`.
- **Dopad:** telefonát, odpojenie Bluetooth slúchadla alebo prerušený audio kontext na iPhone. Appka ďalej „počúva“, ale nič neprichádza.
- **Oprava:** sledovať tieto udalosti a čas posledného rámca z workletu. Pri poruche prejsť do stavu „Ťukni pre obnovenie“. Na iPhone otestovať `navigator.audioSession.type = "play-and-record"` (T1).

### R13. Dočasná chyba Sonioxu ukončí rozhovor namiesto obnovenia — P2, S
- **Kto:** X (F05, reprodukcia s `503`). **Overenie:** C v kóde: `speech-session.js` každú STT chybu mapuje na fatálne `stt_provider_error`. Klient obnovuje iba `stt_connection` a `stt_timeout`. `error_type` a `request_id` sa zahodia.
- **Oprava:** mapovať Soniox `error_type`: `503`/`500`/`408` obnoviť s backoffom, `402` (kredit) a `429` jasne vysvetliť. `request_id` ukladať do diagnostiky (bez textu a audia).

### R14. Koniec vlastného hlasu sa môže vrátiť do mikrofónu — P2, M
- **Kto:** X (F10, bez akustického testu). **Overenie:** C v kóde: po `playback_done` server hneď odstlmí mikrofón a ďalší rámec z workletu môže obsahovať koniec prehrávania a dozvuk. Naopak, mikrofón sa stlmí už pri vytvorení prehrávania, teda aj počas čakania na prvé audio, takže vtedy sa reč druhej osoby stratí.
- **Oprava:** po skončení hlasu zahodiť rámce zachytené pred koncom prehrávania + rezerva ~150 ms (naladiť fyzicky). Stlmiť až pri prvom audiu. V UI zreteľne ukázať „Mikrofón pozastavený“ (U1).

### R15. Ostatné nálezy Codexu (overené v kóde)
- **Slúchadlový barge-in je iba prah hlasitosti** (`app.js` `sendPcm`, RMS > 1200 v 4 rámcoch): vietor alebo autobus preruší preklad, tichý hovoriaci ho nepreruší. Adaptívny prah šumu + hysteréza. X (F11). P3, M.
- **Dokončený originál bez prekladu ostane navždy „živý“**: `serializeConversationItems` podmieňuje `is_final` finálnym prekladom. Zobraziť „Preklad sa nedokončil“. X (F16, reprodukcia). P3, S.
- **REST cesty bez `client_reference_id`, HTTP replay bez rýchlosti hlasu**, cache kľúč bez rýchlosti (`tts-rest.js`, `/api/replay`, `cacheKey`). Pre admin prehľad zo Soniox usage-logs je `client_reference_id` všade potrebný. X (F18). P2 (s A2), S.
- **Mocky nepokrývajú streamované TTS ani PTT flush**: TTS mock posiela audio až po `text_end`. Doplniť regresné scenáre ku každej oprave. X (F17). Súčasť každého PR.

### R9. Drobnosti
- **Error handler vracia 503 aj na neplatný JSON** (`server.js`, posledný `app.use`). Má byť 400. C, kód. P3, S.
- **Ukážka hlasu klávesnicou vyberie hlas**: `keydown` z tlačidla ▶ prebuble do riadka (`app.js` `fillVoiceList`). Kontrolovať `event.target`. X (F14). P3, S.
- **Kontrast `--subtle` (#6f7f8b) na `--surface`** je ~4,2:1, pod WCAG AA 4,5:1 pre malé písmo (meta riadok bubliny 0,75 rem). Stačí zosvetliť na ~#7f8f9b. C, výpočet. P3, S.
- **`aria-live` na celom feede** číta aj ne-finálne tokeny, takže čítačka obrazovky „koktá“. `aria-live` dať iba na finálny preklad. C, kód. P3, S.
- **Admin panel sa zobrazí iba vtedy, keď server vráti `custom_voice`** (`voiceInfo` v `app.js`). Je to nepriama kontrola vlastníka cez stav klonovaného hlasu. Nahradí ju rola v sekcii 5. C, kód.

---

## 3. Latencia (koniec reči → prvý počuteľný preklad)

### Rozpočet dnes (odhad, režim Reproduktor = predvolený)

| Úsek | Dnes | Poznámka |
|---|---|---|
| Koniec reči → `<end>` | ~0,5–1,5 s | sémantický endpoint, strop `max_endpoint_delay_ms=1500`, `level 0`, `sensitivity 0` |
| Finalizácia prekladu | ~0,1–0,3 s | two_way preklad dobieha k `<end>` |
| `pump` → `refreshVoices` | 0 ms, raz za 10 min aj 0,3–2 s | sieťové volanie v horúcej ceste (L4) |
| Otvorenie TTS streamu + prvé audio | ~0,4–1,0 s | v režime Reproduktor bez prewarmu, stream sa otvorí až po `<end>` |
| Server → telefón → plánovanie | ~0,05–0,15 s | 24 kHz PCM, `+25 ms` pri plánovaní |
| **Spolu** | **~1,1–3,0 s** | merané hodnoty sú v `/api/diagnostics` → `last_session_summary.latency` |

### L0. Najprv merať celú cestu — P1, M
- **Kto:** X (F08). **Overenie:** C v kóde: `endpoint_to_playback_ack_ms` začína pri prijatí `<end>` (`speech-session.js` `endpointTimes`), takže **endpointing v ňom vôbec nie je**. Končí prijatím potvrdenia z telefónu, čím pridáva spätný sieťový prenos.
- **Dôsledok:** zmena L1 (skorší `<end>`) by sa v dnešnej diagnostike neprejavila. Preto L0 musí ísť pred L1.
- **Oprava:** merať zvlášť: koniec reči (`end_ms` posledného finálneho originálneho tokenu alebo posledný hlasný rámec) → `<end>` → zaradenie do fronty → prvé TTS audio → naplánovanie v telefóne + počet podtečení. Monotónne hodiny. Do diagnostiky pridať medián a P95 každej etapy.

### L1. Nastavenie endpointu podľa Sonioxu — P1, S
- **Kto:** C+X (obaja z [Soniox endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection)). **Overenie:** [Soniox endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection) uvádza ako „lower-latency starting point“ `endpoint_latency_adjustment_level: 2`, `endpoint_sensitivity: 0.3`, `max_endpoint_delay_ms: 1500`. Appka má `0 / 0 / 1500`. Rozsah `max_endpoint_delay_ms` je 500–3000, predvolene 2000.
- **Oprava:** bez zmeny kódu cez Fly env `ENDPOINT_LATENCY_LEVEL=2`, `ENDPOINT_SENSITIVITY=0.3`, **po** L0. Porovnať medián a P95 „koniec reči → `<end>`“ pred a po, spolu s počtom predčasne rozdelených viet. Ak ich pribudne, vrátiť sensitivity na 0. Až potom prípadne skúsiť `max_endpoint_delay_ms` 1000, nie plošne 500.
- **Prínos:** odhadom 0,2–0,6 s.

### L2. V režime Reproduktor pripraviť hlas ešte počas reči — P1, M
- **Kto:** C. **Overenie:** kód: `prewarmFor` a priebežné posielanie textu do TTS bežia iba pre `outputMode === "headphones"`. V režime Reproduktor sa job zaradí až pri `<end>` (`flushOne` → `queueJob`). Soniox STS demo otvára TTS stream pri prvom prekladovom tokene a uvádza úsporu ~400 ms mediánu.
- **Oprava (dva kroky):**
  1. Prewarm aj v režime Reproduktor pri prvom ne-finálnom prekladovom tokene. Úspora času otvorenia streamu. Malé.
  2. Finálny preklad posielať do TTS priebežne aj v režime Reproduktor, ale audio **držať na serveri v pamäti** a pustiť ho do telefónu až pri `<end>`. Mikrofón sa stlmí, až keď hrá zvuk, takže hovoriaci nie je prerušený. Pri `<end>` je prvé audio často už hotové. Existujúce delenie streamu pri pauze (`TTS_PAUSE_MS`) chráni pred TTS timeoutom.
- **Prínos:** odhadom 0,4–1,0 s, teda najväčšia jednotlivá úspora.
- **Riziko:** ak Soniox finálny preklad ešte opraví (nie je to obvyklé, finálne tokeny sú finálne), hrá sa to, čo bolo finálne. Rovnako ako dnes v režime slúchadiel.

### L3. Plynulosť prehrávania na slabom signáli — P3, S
- **Kto:** C. **Overenie:** kód: každý audio blok sa plánuje hneď (`schedule` v `app.js`, `+25 ms`). Pri oneskorenom bloku vznikne medzera alebo cvaknutie.
- **Oprava:** po prvom „podtečení“ (blok príde po konci predchádzajúceho) pridať adaptívny buffer 120–200 ms pre zvyšok výpovede.

### L4. Obnova katalógu hlasov mimo horúcej cesty — P2, S
- **Kto:** C+X (nezávisle; X ako F07, súvisí aj s R6). **Overenie:** kód: `pump()`, WS upgrade aj ukážka hlasu robia `await catalog.refreshVoices()`. Raz za 10 minút to znamená stránkované sieťové volania (5 s timeout na stránku) priamo pred prvým zvukom.
- **Oprava:** stale-while-revalidate: v horúcej ceste použiť posledný katalóg a obnovu spustiť na pozadí. Tým zmizne aj okno pre R6.

### L6. Synchrónna SQLite transakcia pri každom audio rámci — P2, S
- **Kto:** X (F09). **Overenie:** C v kóde: `audio()` volá `store.reserve({ audioBytes })` pre každý 64 ms rámec, teda ~16 transakcií `BEGIN IMMEDIATE … COMMIT` za sekundu na hovoriaceho. Bez `PRAGMA synchronous=NORMAL`, takže v režime WAL ide pri každom commite fsync na Fly volume, a to v tom istom vlákne, ktoré preposiela audio.
- **Dopad:** jitter pre všetky aktívne rozhovory. Veľkosť sa dá určiť až meraním (L0).
- **Oprava:** rezervovať po 1 s kvantách (32 KiB) a čerpať v RAM. Rezervácia ostáva pred platenou operáciou (fail-closed). Zvážiť `synchronous=NORMAL` (WAL je pri ňom stále konzistentný).

### L7. Začiatok prvej vety počas pripájania sa zahodí — P2, M
- **Kto:** X (F15). **Overenie:** C v kóde: capture beží skôr, než príde `server_ready`, a `sendPcm` do `ready` všetko zahadzuje. Ľudia začnú hovoriť hneď po ťuknutí. Rovnako pri reconnecte.
- **Oprava:** ohraničený buffer (~3 s) od ťuknutia, odoslaný po `server_ready`. Soniox to pri dlhšom pripájaní odporúča ([FAQ](https://soniox.com/docs/faq)).

### L5. Slabý signál: Opus namiesto PCM smerom hore — P3, M (experiment)
- **Kto:** C. **Overenie:** [Soniox audio formats](https://soniox.com/docs/stt/rt/real-time-transcription): `audio_format: "auto"` prijme `webm`/`ogg`. Opus výslovne uvedený nie je, treba otestovať. PCM 16 kHz = 256 kbit/s, Opus ~24 kbit/s.
- **Kompromis:** MediaRecorder pridá ~100–250 ms (timeslice), worklet a PCM sú dnes rýchlejšie. Má zmysel iba ako automatický režim pri zlom signáli. Najprv zmerať, či je upload na LTE vôbec úzke miesto (`bufferedAmount` v diagnostike).

---

## 4. Soniox: aktuálnosť (overené 26. 10. 2026)

| Oblasť | Čo robí appka | Čo hovorí dokumentácia | Akcia |
|---|---|---|---|
| STT model | `stt-rt-v5` | najnovší (16. 6. 2026); `stt-rt-v4` je alias na v5 | nič |
| TTS model | `tts-rt-v2` | GA 11. 8. 2026; v1 odstránený 31. 8. | nič |
| Autentifikácia | `Authorization: Bearer` (STT, TTS, REST) | `api_key` v JSON odmietnutý od 15. 1. 2027, nesmie sa posielať oboje | OK, v3.2.0 to splnila |
| STT keepalive | `{"type":"keepalive"}` každých 10 s, ak sa neposiela audio | 408 po 20 s bez audia aj keepalive; posielať každých 5–10 s | OK. Pozor: Soniox **účtuje celé trvanie streamu**, aj keď ide iba keepalive |
| TTS keepalive | `{keep_alive:true}` každých 20 s | iný formát ako STT, 20–30 s, spojenie padne po ~40 s; stream bez textu padne po pár s | OK |
| Endpoint | `1500 / level 0 / sensitivity 0` | odporúčaný štart pre nízku latenciu `1500 / 2 / 0.3` | **L1** |
| Finalize | PTT: 200 ms ticha, potom `finalize` | posielať ~200 ms po konci reči, nie príliš často | OK (po R5) |
| Context | `general` + `terms` (+ `translation_terms` pre CNC) | limit 8000 tokenov; `text` má nižší vplyv | OK. Nápad: vlastný slovník mien a miest v profile |
| `language_hints_strict` | nepoužíva sa | best-effort, najlepšie pri jednom jazyku | nepoužiť (two_way má dva jazyky) |
| TTS limity | bez globálneho rozpočtu | 3 súbežné streamy na účet, 5 na spojenie, 100 req/min, 2 min audia na stream | **R8** |
| TTS `reduce_silence` | nepoužíva sa | iba ak model hlási `supports_silence_reduction` | overiť v `/v1/tts-models`; ak áno, zapnúť, skráti pauzy |
| TTS `return_timestamps` | nepoužíva sa | dostupné | voliteľné: zvýrazňovanie práve čítaného slova (U6) |
| Max dĺžka STT | appka ukončí po 30 min | Soniox 300 min | OK |
| Temporary API keys | nepoužívajú sa (proxy) | `POST /v1/auth/temporary-api-key`, zvlášť pre STT a TTS, `client_reference_id` viazaný na kľúč | **ostať pri proxy** (pozri rozpor D1) |
| Usage API | nepoužíva sa | `GET /v1/usage-logs` má `client_reference_id` a **cenu** na požiadavku | **využiť v admin prehľade** (sekcia 5) |
| Cenník | — | STT ~$0,12/h, TTS ~$0,70/h vygenerovanej reči | odhad nákladov v admin prehľade |

Komunita (podrobnosti v `deep-analysis-2026-10-26.md`, D):
- **Soniox STS demo:** prewarm TTS pri prvom prekladovom tokene, jeden stream na výpoveď, výpovede sa nehrajú cez seba. Bez ošetrenia ozveny. Appka má stlmenie mikrofónu na reproduktore, čo je lepšie.
- **my-translator:** A−/A+ veľkosť písma až do 140 px na čítanie z diaľky, smart scroll (appka ho už má), glosár `translation_terms`.
- **sokuji:** živé titulky pre druhú stranu, jednoduchý a pokročilý režim.
- **Soniox error handling:** po `1006` sa hneď pripojiť znova. Ak príde `429`, počkať, kým uplynie 20 s okno starého streamu. Pri R1 server starý STT stream sám zavrie, takže sa to nestane.
- Reddit ani GitHub issues o chybách iOS Safari so Sonioxom sa nenašli. Všeobecné iOS riziká (odomknutie `AudioContext` gestom, Bluetooth headset bez audia v `onaudioprocess`, hlasitosť pri aktívnom mikrofóne) treba otestovať na reálnom iPhone (T1).

---

## 5. Tvoja požiadavka: admin účet a správa používateľov

### Čo je dnes
- Používatelia sú vo Fly secrete `APP_ACCESS_CODES` (`meno:kód,…`). Nového človeka pridáš iba cez `fly secrets set` a reštart. Prihlasuje sa iba kódom, bez mena.
- `APP_OWNER_USERNAME=fero` je „vlastník“: vidí zoznam používateľov a vie prístup **natrvalo** zrušiť (`revoked_users`), nič viac.
- Limity sú **rovnaké pre všetkých** (env premenné `MAX_USER_*`).
- Spotreba sa už zapisuje do **SQLite na Fly volume** (`/data/usage.sqlite`, tabuľka `usage`: používateľ × deň × minúty STT, TTS znaky, požiadavky, bajty). Drží sa 32 dní. Text rozhovorov sa na serveri neukladá a tak to má ostať.

**Odpoveď na otázku „kde by to bolo uložené“:** v tej istej SQLite databáze na Fly volume, kde už je spotreba. Netreba žiadnu novú databázu, službu ani npm balík. Node 24 má `node:sqlite` aj `crypto.scrypt` na heslá vstavané.

### Návrh

**Roly:** `admin` (ty) a `user` (brat, rodina). Admin prekladá úplne rovnako ako ostatní. Navyše má v Nastaveniach sekciu **Správa**.

**Prihlásenie:** meno + heslo (správca hesiel v telefóne ho vie uložiť). Heslá iba ako `scrypt` hash so soľou, nikdy v čitateľnej podobe a nikdy v logoch.

**Čo uvidíš a čo vieš robiť:**

| Funkcia | Popis |
|---|---|
| Zoznam používateľov | meno, rola, stav (aktívny/zablokovaný), posledné prihlásenie a použitie, dnešná spotreba ako pruh voči limitu, „práve hovorí“ |
| Nový používateľ | meno, rola, limity. Heslo vygeneruje server (alebo ho zadáš) a zobrazí **iba raz** s tlačidlom „Kopírovať pozvánku“ (odkaz + meno + heslo) na poslanie bratovi |
| Zmena hesla | vygeneruje nové heslo a odhlási všetky jeho zariadenia |
| Limity na osobu | minúty rozpoznávania za deň, TTS znaky za deň, relácie za deň, **mesačný strop minút**; prázdne = predvolené z env |
| Zablokovať / odblokovať | namiesto dnešného nevratného „zrušiť“; zablokovanie okamžite ukončí aj aktívny rozhovor |
| Odhlásiť všetky zariadenia | zruší jeho relácie |
| Zmazať účet | účet zmizne, súhrnná spotreba zostane anonymizovaná pre súčty |
| Rozbor spotreby | na osobu: dnes / 7 dní / 30 dní / tento mesiac; minúty STT, minúty hlasu, počet rozhovorov, jazykové páry, prostredia (lekár, úrad…), priemerná latencia, **odhad ceny v USD**; graf po dňoch (jednoduché CSS stĺpce, bez knižnice) |
| Skutočná cena zo Sonioxu | voliteľne: server raz za hodinu načíta `GET /v1/usage-logs` a priradí cenu podľa `client_reference_id` (už sa posiela = meno). Odhad tak môžeš porovnať s tým, čo Soniox naozaj účtoval |
| Audit | kto, kedy a čo zmenil (vytvorenie, heslo, limity, blokovanie) |

**Dátový model (SQLite, rovnaký súbor):**
- `users(username PK, role, password_hash, created_at, disabled_at, last_login_at, limits_json, note)`
- `auth_sessions(id_hash PK, username, created_at, expires_at, last_seen_at, device)`: rieši aj R3, deploy už nikoho neodhlási
- `usage` (existuje) + retencia predĺžená na 400 dní (sú to malé riadky)
- `conversation_log(id, username, started_at, duration_ms, stt_seconds, tts_chars, tts_requests, language_a, language_b, profile, latency_median_ms, end_code)`: **bez textu rozhovoru**
- `audit_log(at, actor, action, target, detail_json)`

**Prechod bez výpadku:**
1. Pri prvom štarte novej verzie, ak je tabuľka `users` prázdna, server naimportuje `APP_ACCESS_CODES`. Pôvodný kód sa stane heslom (hash), `APP_OWNER_USERNAME` dostane rolu `admin`. Nikto si nič nemusí meniť, len k heslu pridá meno.
2. `APP_ACCESS_CODES` ostane ako **núdzový vstup pre admina** („break-glass“), keby sa databáza poškodila alebo by si zabudol heslo.
3. Záloha: Fly robí denné snapshoty volume (`fly volumes snapshots list`). Doplniť do `deployment.md` postup obnovy a ručný export `users` + `usage`.

**Bezpečnosť:**
- Admin API iba pre rolu `admin`, kontrola na serveri pri každej požiadavke, nie iba skryté tlačidlo v UI.
- Existujúca ochrana zostáva: `SameSite=Strict` cookie, kontrola `Origin` na POST, CSP.
- Login limit na IP aj na meno (proti skúšaniu hesiel bratovho účtu). Minimálna dĺžka hesla 12 znakov. Generované heslo: 4 slová alebo 16 náhodných znakov.
- Admin nemôže zablokovať ani zmazať sám seba ani zrušiť poslednú admin rolu.
- Zmena hesla alebo blokovanie okamžite zrušia relácie a ukončia bežiaci rozhovor (mechanizmus `destroy` už existuje).
- Limity sa kontrolujú na serveri v `UsageStore.reserve` (`limitsFor(user)` namiesto globálnych `limits`), takže ich klient neobíde.

**UI (v súčasnom tmavom štýle):** v Nastaveniach pod „Účet“ pribudne riadok **Správa používateľov** iba pre admina. Otvorí bottom sheet so zoznamom kariet. Ťuknutím na kartu sa otvorí detail (spotreba, graf, limity, akcie). Tlačidlo **+ Nový používateľ** je hore. Bežný používateľ uvidí v „Účet“ pruhy svojej dnešnej spotreby voči limitu namiesto dnešnej vety.

**Postup (3 PR, každý s testami a Codex revíziou):**
- **A1 – Účty a relácie v DB:** tabuľky `users` a `auth_sessions`, import z env, login meno + heslo, limity na osobu v `reserve`, migrácia `revoked_users` → `disabled_at`. M.
- **A2 – Admin API:** CRUD používateľov, heslá, limity, blokovanie, agregácie spotreby, `conversation_log`, audit, voliteľne Soniox usage-logs. M.
- **A3 – Admin UI:** sheet správy, detail používateľa, pozvánka, pruhy spotreby pre všetkých. M.

---

## 6. Dizajn a UX (vylepšenia, nie prerábka)

Prezreté na mock serveri pri 360, 390 a 768 px (prihlásenie, prázdny stav, rozhovor, režim oproti sebe, nastavenia). Tmavý dizajn je konzistentný a čistý; nižšie sú iba doplnky.

| ID | Návrh | Prečo | Kto | Náročnosť |
|---|---|---|---|---|
| U1 | **Režim oproti sebe: stav aj pre druhú osobu.** V otočenej polovici zobraziť v jej jazyku „Hovorte teraz“ / „Prekladám…“ / „Počkajte, hovorím“ | počas hlasu na reproduktore je mikrofón stlmený; druhá osoba to dnes nevidí a jej reč sa stratí | C | S |
| U2 | **PTT oproti sebe:** druhé tlačidlo PTT v hornej polovici otočené k druhej osobe | jeden telefón na stole medzi dvoma ľuďmi | C | M |
| U3 | **Veľkosť písma A−/A+** (prekladu aj režimu oproti sebe), uložená v zariadení | čítanie z diaľky, starší ľudia, úrad | C (my-translator) | S |
| U4 | **Tablet / 768 px:** feed obmedziť na ~680 px a zväčšiť preklad | pri 768 px je bublina malá vpravo a zvyšok obrazovky je prázdny | C | S |
| U5 | **„Zastaviť hlas“ iba počas prehrávania** (dnes je stále viditeľné, iba zašednuté) | menej šumu v doku | C (už v predch. analýze) | S |
| U6 | **Zvýraznenie práve čítaného slova** cez TTS `return_timestamps` | druhá osoba vidí, čo počuje | C | M |
| U7 | **Čip prostredia** na hlavnej obrazovke, keď nie je „Bežný rozhovor“ (napr. „Lekár“) | dnes nevidno, že je zapnutý odborný slovník | C | S |
| U8 | **Spotreba ako pruhy** voči limitu v „Účet“ | veta s minútami nehovorí, koľko ešte ostáva | C | S (s A3) |
| U9 | Upozornenie 2 min pred 30-min limitom rozhovoru + automatické pokračovanie s rovnakým prepisom | dlhšie stretnutie na úrade sa dnes utne | C | S |
| U10 | Kontrast a `aria-live` (R9) | prístupnosť | C | S |
| U11 | **„Zastaviť hlas“ a „Oproti sebe“ aj v PTT.** Dnes sú v `autoControls`, ktoré sa pri aktívnom PTT celé skryjú | pri zlom preklade na úrade treba okamžité ticho bez začatia novej reči | X (F12) | S |
| U12 | **Oproti sebe drží poslednú dokončenú vetu**, kým nie je hotový preklad novej. Dnes nová veta s prázdnym prekladom okamžite zmaže predchádzajúci preklad. Dlhý text zarovnať zhora | druhá osoba nestihne dočítať | X (F13) | S |
| U13 | **Neistý originál podčiarknuť** podľa Soniox `confidence` (nie percento správnosti prekladu) | pri lekárovi vidno, ktorému slovu nerozumel | X | M |

---

## 7. Rozpory medzi modelmi a rozhodnutia

- **D1. Proxy vs. dočasné Soniox kľúče priamo v prehliadači.** Soniox uvádza, že priame spojenie má nižšiu latenciu. **Rozhodnutie: ostať pri proxy.** Server dnes drží limity, účtovanie na osobu, TTS frontu, stlmenie mikrofónu a budúci admin. Priame spojenie by vyžadovalo dva kľúče (STT a TTS sú oddelené), obnovu kľúčov a presun logiky do klienta. Proxy pridá iba jeden skok Frankfurt → Soniox EU, teda desiatky ms. Väčšiu úsporu prinesú L1 a L2.

- **D2. Čo je najvyššia priorita.** Codex: F01 (PTT flush) ako jediné P1, žiadne P0. Claude: R1 (reconnect `409`) ako P1, ktorý Codex nenašiel. **Rozhodnutie:** oboje P1, žiadne P0. R1 je overený reprodukciou a zasahuje práve situáciu „ulica, slabý signál“. R5/F01 má Codex reprodukovaný a je malý. Oba idú do prvej vlny.
- **D3. Ladiť endpoint hneď, alebo najprv merať?** Claude pôvodne navrhol L1 ako prvý krok bez kódu. Codex upozornil (F08), že dnešná metrika začína pri `<end>`. **Rozhodnutie: Codex má pravdu.** Bez L0 by sa zisk z L1 nedal preukázať a nevideli by sme ani cenu, teda predčasne useknuté vety. Poradie je L0 → L1.
- **D4. Latencia v režime Reproduktor.** Codex hlavné rezervy vidí v endpointingu, katalógu, REST fallbacku a SQLite. L2 (príprava hlasu počas reči) nenavrhol. **Rozhodnutie:** L2 ponechať, ale až po L0, aby sa jeho prínos (odhad 0,4–1,0 s) dal zmerať. Kód potvrdzuje, že v režime Reproduktor sa TTS stream dnes otvára až po `<end>`.
- **D5. Priority drobností.** Codex dáva F14 (klávesnica pri ukážke hlasu) P2. **Rozhodnutie: P3**, appka sa ovláda dotykom a nikto z rodiny nepoužíva klávesnicu ani čítačku. Oprava je však na jeden riadok, pôjde v `ux/polish`.
- **D6. Worklet 1024 → 512 vzoriek** (Codex, úspora ~16 ms v priemere). **Rozhodnutie:** neskôr, až po L6, lebo dvojnásobok rámcov by zdvojnásobil SQLite transakcie.

---

## 8. Samostatná Codex analýza: mapovanie

Codex (`task`, iba čítanie, 18 nálezov, online overenie Soniox docs). Jeho Soniox tabuľka a cenník sa zhodujú so subagentom Claude, rozpory neboli. Upozornil navyše, že preklad nemá príplatok za funkciu, ale zväčšuje objem účtovaného výstupného textu.

| Codex | Tu | Stav overenia (Claude) |
|---|---|---|
| F01 PTT flush | R5 | kód ✔ |
| F02 REST backpressure | R10 | kód ✔ |
| F03 prepnutie appky | R11 | kód ✔ |
| F04 životný cyklus capture | R12 | kód ✔ (chýbajúce handlery), fyzicky neoverené |
| F05 chyby Sonioxu | R13 | kód ✔ |
| F06 reconnect počítadlo | R2 | kód ✔ |
| F07 katalóg v horúcej ceste | L4 | kód ✔ |
| F08 meranie latencie | L0 | kód ✔ |
| F09 SQLite na rámec | L6 | kód ✔ |
| F10 ozvena konca hlasu | R14 | kód ✔, akusticky neoverené |
| F11 barge-in | R15 | kód ✔ |
| F12 stop hlasu v PTT | U11 | kód ✔ |
| F13 oproti sebe | U12 | kód ✔ |
| F14 klávesnica | R9 | kód ✔ |
| F15 začiatok vety | L7 | kód ✔ |
| F16 večne živý originál | R15 | kód ✔ |
| F17 testy/mocky | R15 | ✔ |
| F18 REST identita a rýchlosť | R15 | kód ✔ |

Codex nenašiel R1, R3, R7, R8, L2, ani admin návrh (nebol v jeho zadaní). Claude nenašiel F02–F05, F08–F18.

---

## 9. Testovanie na reálnych zariadeniach

- **T1 iPhone Safari:** hlasitosť a výstup (reproduktor vs. slúchadlo) pri aktívnom mikrofóne, `AudioContext` v stave `interrupted` (hovor, Siri), Bluetooth headset, návrat z pozadia.
- **T2 Android Chrome:** prepnutie Wi-Fi → LTE počas reči (overí R1+R2), zamknutá obrazovka, úsporný režim.
- **T3 Slabý signál:** Chrome DevTools throttling „Slow 4G“ + výpadok 5 s; sledovať latenciu v `/api/diagnostics`.

---

## 10. Prioritizovaný plán

Každý riadok = samostatná vetva a PR s testami, `npm run check`, `npm test` a Codex revíziou. Zlúčenie a `fly deploy` iba s tvojím súhlasom.

| Poradie | Balík | Obsah | Náročnosť |
|---|---|---|---|
| 1 | **fix/reconnect** | R1 takeover + heartbeat 10 s, R2 stabilný reset, R7 relácie pri reconnecte, R13 obnoviteľné chyby Sonioxu | S–M |
| 2 | **fix/audio-capture** | R5 PTT flush, L7 buffer začiatku vety, R11 prepnutie appky, R12 detekcia hluchého mikrofónu | M |
| 3 | **fix/voice-queue** | R6 pump, L4 katalóg na pozadí, R8 TTS rozpočet, R10 REST backpressure, R14 stlmenie až pri prvom audiu | M |
| 4 | **fix/sw-versioning** | R4 verzované assety | S |
| 5 | **perf/metrics + storage** | L0 meranie etáp, L6 SQLite kvantá | M |
| 6 | **Ladenie endpointu (env, bez kódu)** | L1 `level 2 / sensitivity 0.3`, porovnať L0 metriky | S |
| 7 | **feat/accounts (A1)** | používatelia a relácie v DB, login meno + heslo, limity na osobu (rieši R3) | M |
| 8 | **feat/admin-api (A2)** + R15 REST `client_reference_id` | správa, rozbor spotreby, audit, Soniox usage-logs | M |
| 9 | **feat/admin-ui (A3)** + U8 | správa v Nastaveniach, pruhy spotreby | M |
| 10 | **perf/speaker-tts (L2)** | prewarm a príprava hlasu počas reči v režime Reproduktor | M |
| 11 | **ux/face-to-face** | U1, U2, U3, U7, U9, U11, U12 | M |
| 12 | **ux/polish** | U4, U5, U10, R9, R15 (F16), L3 | S |
| 13 | Experimenty | L5 Opus, U6 zvýrazňovanie slov, U13 confidence, `reduce_silence`, adaptívny barge-in, worklet 512 | M |

Balíky 1–4 sú opravy, dajú sa nasadiť spolu ako **v3.2.1**. Balíky 5–6 = meranie a ladenie latencie. Admin (7–9) je **v3.3.0**. Pred každým vydaním prejsť maticu T1–T3 na reálnych telefónoch.

Ak chceš admin skôr, balíky 7–9 sa dajú presunúť hneď za v3.2.1. Opravy 1–4 sú v inej časti kódu, takže sa nebijú.
