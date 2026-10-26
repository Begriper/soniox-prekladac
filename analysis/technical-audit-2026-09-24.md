# Technický audit Soniox prekladača — 24. 9. 2026

## Rozsah a stav

Audit vychádza z **aktuálneho pracovného stromu** na vetve `codex/dynamic-soniox-capabilities`, nie zo starého nasadenia. V strome je rozpracovaná verzia 3.0.0 s mnohými necommitnutými zmenami; historický stav je v `docs/README-before-modernization.md`. Produkciu ani skutočné API kľúče som nečítal a neposielal som platené Soniox požiadavky. `npm run check` a `npm test` prešli (52 testov, 0 zlyhaní); testy používajú mock API. Reálne mobilné zariadenia, echo a skutočná latencia neboli overené.

## 1. Súčasná architektúra

```
Mobilný prehliadač / PWA
  getUserMedia → AudioWorklet (fallback ScriptProcessor) → mono PCM 16 kHz
  → vlastný WebSocket / na Express serveri
  → SpeechSession → Soniox STT WebSocket stt-rt-v5
  → Soniox native one_way / two_way translation tokeny
  → serverová final-token fronta → Soniox TTS WebSocket tts-rt-v2
      (pri vybraných transportných zlyhaniach REST fallback)
  → PCM 24 kHz cez vlastný WebSocket → Web Audio API
```

`server.js` poskytuje login, session, jazyky, hlasy, ukážky, replay, usage a diagnostiku. `security.js` validuje vlastné WS správy a origin. `usage-store.js` drží denné rezervácie v SQLite. `catalog.js` číta modelové katalógy a cache. `speech-session.js` riadi STT, preklad, TTS, queue, keepalive a ukončenie. `tts-transport.js` drží multiplexovaný TTS socket, prewarming a cancel. `public/app.js` zachytáva PCM a prehráva ho; `public/history.js` ukladá iba výslovne zvolený text do IndexedDB. Fly/Docker nasadenie je pripravené, ale tento audit ho nemení.

## 2–4. Používané, problematické a nevyužité funkcie

| Oblasť | Terajší stav | Záver |
|---|---|---|
| Modely/endpointy | `runtime-models.js`: `stt-rt-v5`, `tts-rt-v2`; regionálne STT/TTS WS, TTS REST, `/v1/models`, `/v1/tts-models` | Aktívne modely a aktuálne endpointy. Soniox [STT modely](https://soniox.com/docs/stt/models), [TTS modely](https://soniox.com/docs/tts/models), [regióny](https://soniox.com/docs/data-residency). |
| Natívny preklad | `speech-session.js` posiela `translation.two_way`; pri automatickom výbere jazyka dočasne `one_way` | Správny základ pre SK↔DE, SK↔PL, DE↔PL. Tretí jazyk v `two_way` môže byť prepísaný bez prekladu; UI to musí vysvetliť. [Režimy a tokeny](https://soniox.com/docs/translation/stt-translation), [jazyky](https://soniox.com/docs/translation/supported-languages). |
| Jazyk a endpoint | Language identification, `language_hints`, semantic endpoint, `<end>` a final/non-final text | Funkčné. Predvolený `max_endpoint_delay_ms=1500`, level 0, sensitivity 0. Parametre sú platné, no treba ich ladiť meraním; agresívnejšie endpointy môžu zhoršiť presnosť. [Endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection). |
| TTS stream | Prewarm oboch smerov, keepalive, PCM stream, cancel, chyby a REST fallback | Robustný transport. Zásadné obmedzenie je **vkladanie celého textového chunku s `text_end:true`** až po flush; nejde o priebežné posielanie tokenov do jedného TTS streamu. |
| Speaker diarization | `enable_speaker_diarization` chýba; `speaker` sa neukladá | Voliteľný experiment, nie primárny určovač smeru. Nízka latencia endpointingu znižuje presnosť diarizácie. [Diarization](https://soniox.com/docs/stt/concepts/speaker-diarization). |
| Context | `context.general`, `text`, `terms`, `translation_terms` sa neposielajú | Najväčšia medzera pre úrad, pohovor, lekára, CNC. [Soniox Context](https://soniox.com/docs/stt/concepts/context). |
| Voice Library | UI číta vstavané hlasy z `/v1/tts-models`, filtruje len pohlavie; vlastné hlasy nečíta | Doplniť metadáta age/accent/use_case/style cez paginované `/v1/shared-voices?model=tts-rt-v2` a osobitne `GET /v1/voices`. [Hlasy](https://soniox.com/docs/tts/concepts/voices), [shared voices](https://soniox.com/docs/api-reference/tts/get_shared_voices). |
| Auto conversation / push-to-talk | Prepínač reproduktor/slúchadlá; režim PTT nie je implementovaný | Reproduktor počas TTS stlmí posielanie mikrofónu. Skákanie do reči teda nefunguje. Slúchadlá nechávajú mikrofón zapnutý, ale nemajú VAD ani barge-in. |
| GPT/LLM | V aktuálnom runtime nie je OpenAI/GPT/LLM ani Twilio/Telnyx | Niet čo vyberať z hlavného toku. AI vysvetlenie či návrh odpovede môže byť neskôr samostatná explicitná akcia. |

Zdroje v kóde: `speech-session.js` (konfigurácia STT približne 147–168, tokeny 187–223, syntéza 250–312), `tts-transport.js` (prewarm 74–84, text 86–108, PCM/cancel 122–159), `server.js` (API 124–190, WS 195–214), `public/app.js` (PCM 331–385, prehrávanie 113–181), `catalog.js` (modelový katalóg).

## 5–7. Ponechať, odstrániť, nahradiť

- **Ponechať:** Express a vanilla frontend, regionálne endpointy, serverový hlavný kľúč, súčasný login a limity ako prvú vrstvu, Soniox `two_way`, textový režim, streaming PCM, prewarming, explicitné zastavenie audia, lokálnu históriu a PWA shell.
- **Odstrániť pri zmene toku:** pravidlo, že reproduktor vždy ignoruje mikrofón počas celého TTS; nahradiť riadeným barge-in. Nepresúvať automaticky každú vetu cez LLM. `ScriptProcessor` ponechať len ako kompatibilitný fallback, ak sa potvrdí potreba.
- **Nahradiť natívnou funkciou:** žiadnu existujúcu LLM prekladovú vrstvu, pretože už neexistuje. Vlastnú heuristiku smeru nezamieňať za diarizáciu; smer určuje natívny `two_way` token `language`/`source_language`. Pre terminológiu použiť Soniox `context` namiesto ďalšieho prekladového modelu.

## 8. Speech-to-Speech demo: čo prevziať

Oficiálny [popis](https://soniox.com/docs/demo-apps/soniox-speech-to-speech-translation), [backend `main.py`](https://github.com/soniox/soniox_examples/blob/master/apps/soniox-speech-to-speech-translation-demo/main.py) a [frontend `app.js`](https://github.com/soniox/soniox_examples/blob/master/apps/soniox-speech-to-speech-translation-demo/frontend/app.js) ukazujú STT reader → async queue → TTS sender. Každý prekladový token sa pošle ako `text_end:false`, `<end>` uzavrie výpoveď cez prázdny chunk s `text_end:true`. Paralelný TTS reader dekóduje base64 na PCM, čaká na `terminated`, keepalive posiela každých 20 s. Prewarm otvára stream pred prvým tokenom. Frontend používa `MediaRecorder` 100 ms a Web Audio scheduling; file mode znižuje hlasitosť pôvodného audia pri preklade.

**Prevziať:** oddeliť produkciu tokenov od spotreby cez obmedzenú queue, odosielať *stabilné final translation* tokeny priebežne do streamu prislúchajúceho jednému `utterance_id` a smeru, `<end>` alebo zmena smeru uzavrie stream; ukončenie klienta potvrdiť až po dobehnutí posledného TTS `terminated` a prehrávania. Zachovať súčasné bezpečné ID, limity a zrušenie prehrávania. **Neprevziať:** demo `tts-rt-v1`, jeho neobmedzenú queue, samotné jednokanálové smerovanie ani file-mode ducking do konverzácie cez jeden reproduktor. V aktuálnej [TTS dokumentácii](https://soniox.com/docs/tts/models) je v2 aktívna a v1 deprecated. Demonštrovaných 0,5–1,5 s a prínos prewarm ~400 ms sú výsledok dema, nie namerané čísla pre tento projekt.

## 9. Voice Agent: čo prevziať

[Voice Agent dokumentácia](https://soniox.com/docs/demo-apps/soniox-voice-agent) a [serverový zdroj](https://github.com/soniox/soniox_examples/tree/master/apps/soniox-voice-bot-demo/server) používajú VAD → speech-start event → prerušenie TTS, oddelené STT/LLM/TTS procesory a message queue. Pre tlmočníka je vhodný **VAD signál, rušenie TTS a jasný lifecycle operácií**. LLM processor, persona, nástroje a generovanie vlastnej odpovede nie sú súčasťou tlmočenia. Voľba **A**: ponechať Soniox native translation a pridať audio orchestration.

## 10. Soniox Live a priame streamovanie

[Soniox Live](https://soniox.com/docs/demo-apps/soniox-live) ukazuje browser/React a React Native → Soniox STT cez temporary key, ktorý vydáva server. [Temporary keys](https://soniox.com/docs/guides/temporary-api-keys) vznikajú serverovým `POST /v1/auth/temporary-api-key`; `usage_type` je `transcribe_websocket` alebo `tts_rt`, kľúč môže mať `expires_in_seconds`, `single_use`, `max_session_duration_seconds`, `client_reference_id`. Expirácia limituje otvorenie nových streamov, sama neukončí bežiaci stream; `single_use` pri TTS multi-stream socketoch vyžaduje návrh po streamoch.

**Odporúčanie teraz:** nechať vlastný proxy tok. Práve tam sú session limity, počítanie PCM bajtov, TTS fronta, mapping dvoch hlasov a cancel. Priamy STT stream vyskúšať ako druhú fázu len ak meranie ukáže významnú proxy latenciu; potrebuje oddelený dočasný STT kľúč na každé pripojenie, serverom obmedzené vydávanie, CSP `connect-src` pre regionálny Soniox host a nové sledovanie spotreby cez usage logs. Priamy TTS by preniesol orchestration a vystavené tokeny do klienta a nie je prvá voľba. Hlavný kľúč **nikdy** neposielať do browsera. [Direct stream guide](https://soniox.com/docs/guides/direct-stream).

## 11. Cieľová architektúra

```
AUTO (slúchadlá alebo po dôkladnom echo teste reproduktor)
mic PCM + browser AEC → server WS → Soniox stt-rt-v5 two_way + context
                    ↘ lokálny/browser VAD speech-start → cancel TTS + flush prehrávača
final origin + translation tokeny → UI
final translation tokeny → bounded utterance/direction queue
→ Soniox tts-rt-v2: prewarm, text_end:false po tokenoch, <end> → text_end:true
→ PCM 24 kHz → Web Audio; samostatný hlas pre cieľový jazyk

PUSH-TO-TALK (spoľahlivý fallback)
účastník A/B podrží alebo stlačí svoj jazyk → posiela sa len jeho reč
→ na uvoľnenie flush/finalize → rovnaký Soniox two_way + TTS tok
```

Na jednom telefóne s reproduktorom nemožno sľúbiť robustný full duplex len pomocou `echoCancellation:true`. VAD musí rozlíšiť človeka od vlastného TTS; inak slučka preloží prehratý preklad späť. V AUTO režime: začiatok pravdepodobne ľudskej reči počas TTS → okamžite zastaviť naplánované `AudioBufferSourceNode`, zrušiť serverový TTS stream a queue, zachovať text, pokračovať STT. Použiť krátky hysteresis/debounce, odlišný prah pri TTS a testovať na fyzických telefónoch s hlasným reproduktorom, Bluetooth aj tichou miestnosťou. Ak je echo neisté, aplikácia má ponúknuť PTT alebo slúchadlá. Endpoint detection určuje koniec výpovede, nenahrádza VAD pre rýchly speech-start.

`two_way` pre `sk/de`, `sk/pl`, `de/pl` má zostať jeden STT stream na rozhovor. `language_hints` pomáhajú identifikácii, ale nezaručujú vylúčenie tretieho jazyka. UI má zobraziť originál, priebežný a final preklad a hlasový stav; voliteľný `speaker` len s upozornením na neistotu.

## Voice Library a vlastný hlas

[Voice Library](https://soniox.com/blog/soniox-voice-library) od 9. 9. 2026 uvádza viac ako 200 vstavaných hlasov; každý môže hovoriť vo všetkých 60+ podporovaných jazykoch a zachovať charakter/akcent. [Cloning](https://soniox.com/docs/tts/concepts/voice-cloning): čistá nahrávka **do 2 minút a 35 MB**, jeden hovoriaci; slovenský 1–2 min záznam možno použiť pre nemecký, poľský či anglický TTS, kvalitu výslovnosti treba vyskúšať. `POST /v1/voices` prijíma multipart `name`+`file`, vracia UUID; po stave `ready` pre `tts-rt-v2` sa UUID vloží do `voice` WS/REST konfigurácie. [Create voice API](https://soniox.com/docs/api-reference/tts/voices/create_voice). Soniox uvádza max. 20 custom hlasov na organizáciu; nové modely môžu vyžadovať recompute. Preferovaný prvý krok je vytvoriť vlastný hlas v Soniox Console a do aplikácie doplniť serverový zoznam ready custom hlasov. Nahrávací formulár v aplikácii až po overení súhlasu, prístupu a správy záznamu. Každému app používateľovi prideliť explicitný whitelist custom voice IDs; brat nemá automaticky používať tvoj klon.

## 12. Latencia

Terajší reproduktorový tok čaká na final tokeny, `<end>` a flush, potom posiela celý text s `text_end:true`; predvolené endpoint maximum je 1500 ms. Cieľové odosielanie final translation tokenov do TTS pred koncom vety môže odstrániť čakanie na endpoint a časť bufferovania, teda **rádovo stovky ms až približne 1,5 s** v konkrétnych výpovediach. Je to architektonický odhad, **nie namerané zlepšenie**. TTS time-to-first-audio, jazyk, dĺžka výpovede a reproduktorové echo výsledok zmenia. Zmerať na zariadení: koniec fyzickej reči → prvý počuteľný preklad (median/P95), prvé translation tokeny, `<end>`, TTS first byte, audio schedule/start, počet false endpointov a echo slučiek. Existujúce `/api/diagnostics` meria len serverové proxy časovania, nie skutočný akustický výstup.

## 13. Náklady — ilustračný výpočet v USD

Oficiálny [Soniox cenník](https://soniox.com/pricing): real-time STT $2/M vstupných audio tokenov, $4/M vstupných textových a $4/M výstupných textových tokenov; TTS $4/M vstupných textových a $21,50/M výstupných audio tokenov. Hodinové orientačné hodnoty sú 30 000 audio a 15 000 text tokenov pri súvislej reči. Soniox uvádza preklad ako súčasť STT volania bez samostatného prekladového príplatku; extra vygenerovaný prekladový text však vstupuje do počtu **výstupných textových tokenov**, preto treba finálnu faktúru kontrolovať v usage logs. Príklad B/C používa [GPT-6 Sol API](https://developers.openai.com/api/docs/models/gpt-6-sol) $2/M input a $10/M output; nejde o tvrdenie, že tento model je kvalitou vhodný pre medicínske/úradné tlmočenie.

Predpoklad výpočtu: stream beží celý rozhovor; polovicu času sa hovorí; dĺžka TTS je rovnaká ako súčet ľudskej reči; preklad má približne toľko tokenov ako originál; LLM dostane 1× originálny text a vytvorí 1× výstupný text, bez veľkej histórie či reasoning tokenov. Napr. 10 min = 5 000 STT audio tokenov, 1 250 pôvodných textových, 1 250 prekladových, 1 250 TTS input textových a 2 500 TTS output audio tokenov. Context, opakované prompty, dlhšie odpovede, znovusyntéza a server nie sú zahrnuté.

| Variant | 10 min | 30 min | 60 min | Čo sa účtuje |
|---|---:|---:|---:|---|
| A Soniox STT + native translation + TTS | $0,079 | $0,236 | $0,473 | celé streamované vstupné audio, originál + preklad text tokeny, TTS vstupný text a generované audio |
| B Soniox STT + GPT preklad + Soniox TTS | $0,089 | $0,266 | $0,533 | STT audio + originál, LLM input/output, TTS text/audio |
| C Voice Agent STT + GPT + TTS | **od** $0,089 | **od** $0,266 | **od** $0,533 | rovnaká spodná ilustratívna hranica pri rovnako dlhých odpovediach; história, tool calls a dlhšie odpovede zvyšujú cenu |
| D Soniox STT + native translation, iba text | $0,020 | $0,060 | $0,120 | STT audio + originál + preklad text, bez TTS |

Skutočná cena pri tichu, odlišnej dĺžke reči a inom tokene/počte requestov sa zmení. TTS dominuje A–C. Pri lacnejšom LLM môže B vyjsť nominálne podobne alebo lacnejšie než A; výhoda A je kratší a jednoduchší dátový tok, nie zaručene najnižšia suma. Dlhý kontext v B/C a ďalšie LLM volania môžu náklady výrazne zvýšiť.

## 14. Bezpečnosť a prístup pre brata

Existujúci prístupový kód → podpísaná HttpOnly/SameSite session → WS origin/session kontrola → denné/session limity je rozumný jednoduchý základ. Brat môže dostať **vlastný** dlhý kód a vlastný username v serverovej konfigurácii; nedostane Soniox kľúč. Staré kódy nemožno deaktivovať bez aktualizácie konfigurácie a reštartu. Session sú len v RAM; po reštarte sa stratia. Kódy sú v serverovej konfigurácii v čitateľnej podobe, preto chrániť správu nasadzovacieho prostredia. SQLite rezervácie sú limity aplikácie, nie presná Soniox faktúra; priama klientská STT cesta by obišla dnešné priebežné limity bajtov. Lokálna IndexedDB história je oddelená v UI podľa username, nie šifrovaná proti inému používateľovi toho istého zariadenia. Súčasný `catalog.hasVoice` prepúšťa iba vstavané hlasy z TTS modelu, preto bezpečne blokuje klon, kým sa nepridá vlastníctvo/whitelist.

Ak bude potrebný jednorazový prístup do **aplikácie**, spraviť vlastnú serverovú pozvánku s expiráciou a jednorazovým použitím; Soniox `single_use` temporary key rieši len stream u Sonioxu, nie login do aplikácie. Rozhovory a citlivé údaje z úradu/lekára neposielať do voliteľného LLM bez samostatnej explicitnej akcie a primeraného vysvetlenia používateľovi.

## 15–17. Migračný plán a konkrétne zmeny kódu

1. **Baseline a meranie.** Zachovať aktuálny stav, doplniť staging test so skutočným účtom a účtovacím usage logom. Na telefónoch merať SK↔DE, SK↔PL, DE↔PL, režim reproduktor/slúchadlá, zlé pripojenie, iPhone/Android, echo, čísla a termíny. Bez tohto nevyhlasovať cieľovú latenciu.
2. **Context profily.** Nový dátový súbor `context-profiles.js` s verzovanými profilmi `general`, `terms`, `translation_terms` a voliteľným krátkym `text`. Profily: bežný, úrad/Arbeitsamt, pohovor, lekár, hotel, CNC/výroba, administratíva. Úradné názvy `Arbeitslosengeld`, `Agentur für Arbeit`, `Arbeitsbescheinigung`, `Kündigung`, `Sperrzeit`, `PD U1/U2`, `Arbeitslosmeldung`, `Arbeitsuchendmeldung` dať do `terms`; presný dvojjazyčný cieľ určiť až po overení kvality a potom do `translation_terms` ako `source`/`target`. `server.js` vystaví povolené profily; `security.js` prijme iba ID profilu; `speech-session.js` vloží vybraný context do STT konfigurácie. Pri zmene profilu treba nový STT stream a nepretrhnúť výpoveď.
3. **Priebežné TTS.** V `speech-session.js` naviazať final translation tokeny na `utterance_id` + target language, bounded queue a `<end>`; v `tts-transport.js` pridať `open/write/finish/cancel` k jednému TTS streamu. Zachovať prewarming/keepalive, stream-scoped chyby, `audio_end`/`terminated` lifecycle, kvóty pred otvorením streamu a jasnú politiku REST fallbacku len pred prvým audiom. `server-utils.js` má udržať stabilné párovanie originálu, prekladu a smeru. Testy musia pokrývať prerušovaný final/non-final tok, prepnutie smeru, prázdny `<end>`, race so stop a preťaženie.
4. **Režimy rozhovoru.** `public/index.html`, `public/app.js`, `public/style.css` doplniť AUTO/PTT, dva veľké jazykové PTT ovládače a jasný stav mikrofónu. V AUTO najprv slúchadlá; speaker barge-in uviesť až po spoľahlivom VAD/AEC teste. V `speech-session.js` a klientovi zaviesť `speech_start`/`interrupt` s ID generácie, okamžité zastavenie naplánovaného PCM a zrušenie čakajúcich TTS chunkov bez zmazania textu. PTT nesmie posielať audio mimo stlačeného účastníka.
5. **Hlasy.** `catalog.js`/`server.js` doplniť paginované shared voices metadata a vlastné `GET /v1/voices` s `ready` pre v2; `security.js`/`speech-session.js` validovať ID proti per-user whitelistu; `public/app.js` zobraziť vstavané + povolené klony s ukážkou. `POST /v1/voices` a upload do app pridať až keď je potvrdený súhlas, proces správy klonov a limity.
6. **Voliteľné funkcie.** Diarization len ako experiment s metrikou presnosti oproti jazyku/PTT; explicitné AI akcie mimo audio pipeline. Soniox Live direct STT len ako A/B experiment po meraní a návrhu temp key/usage limitov.
7. **Nasadenie.** Po stagingu aktualizovať README/.env.example/deployment.md a testy; pred produkciou overiť jedinú Fly Machine/volume, nové prístupové kódy, regionálny projekt a rollback. Produkciu tento audit nemení.

Súbory na úpravu: `speech-session.js`, `tts-transport.js`, `server-utils.js`, `catalog.js`, `security.js`, `server.js`, `public/app.js`, `public/index.html`, `public/style.css`, `public/audio-capture-worklet.js`, nový `context-profiles.js`, integračné/audio/security testy, `README.md`, `.env.example`, `deployment.md`. `usage-store.js` len ak sa mení účtovanie per-stream, direct mode alebo limity; `tts-rest.js` len ak sa mení fallback/hlasová validácia. Žiadny kompletný rewrite nie je potrebný.
