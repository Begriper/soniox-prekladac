# Soniox prekladač — 3.0.0

Súkromná rodinná webová aplikácia: obojsmerný hovorený preklad na jednom telefóne. Vanilla HTML/CSS/JavaScript, Express, Soniox STT v5 a TTS v2. Implementácia je pripravená na lokálne overenie; produkcia sa v tejto úlohe nenasadzovala.

## Spustenie

Použi **Node 24 LTS**. Skopíruj .env.example do vlastného .env a vyplň API kľúč, náhodný session secret a **odlišné náhodné prístupové kódy aspoň 16 znakov** pre každého používateľa. Staré šesťmiestne kódy už server neprijme. Skutočný .env táto implementácia nemení.

~~~sh
npm ci
npm run check
npm test
npm start
~~~

Predvolené lokálne adresy sú http://localhost:3000 a http://127.0.0.1:3000. Pri inej adrese uprav celý APP_ORIGINS vrátane portu. Na telefóne je pre mikrofón potrebné HTTPS.

Bez externých API môžeš spustiť node scripts/mock-app.cjs a otvoriť http://127.0.0.1:3210. Testovací kód je uvedený iba v testovacom helperi; tento server nie je súčasťou Docker image.

## Používanie

- Vyber svoj jazyk a jazyk druhej osoby. „Rozpoznať jazyk“ najprv potichu prepíše/preloží cudziu výpoveď a vyžiada potvrdenie. Potom otvorí obojsmernú konverzáciu.
- „Počúvať“ zapne mikrofón. „Zastaviť počúvanie“ odošle zvyšok audia a dokončí posledný preklad. „Zastaviť hlas“ okamžite ruší aj čakajúcu syntézu.
- Reproduktor je bezpečný predvolený režim. Slúchadlá vyber výslovne v nastaveniach. Dostupné sú samostatné hlasy oboch smerov, mužský/ženský filter, textový režim a zobrazenie oproti sebe.
- História sa ukladá výhradne tlačidlom „Uložiť rozhovor“ do IndexedDB aktuálneho zariadenia a používateľa. Podporuje otvorenie, kopírovanie, textový export a vymazanie. Audio zostáva iba v obmedzenej pamäťovej cache.
- Nový rozhovor upozorní na neuložený obsah. Po prerušení internetu zostane prepis v otvorenej karte; obnovenie nespúšťa staré audio znova.
- Po zamknutí alebo opustení stránky obnov počúvanie. PWA neposkytuje offline preklad ani garantovaný beh na pozadí.

## Prevádzka a bezpečnosť

SQLite ukladá iba denné rezervácie spotreby a katalógy modelov, žiadny rozhovor. Lokálne používa .local-data/usage.sqlite, v produkcii /data/usage.sqlite. Pri chybe účtovania nové platené operácie zlyhajú bezpečne. Rezervácie sú konzervatívne: aj neúspešný pokus/fallback môže stáť kredit, preto sa nevracia. STT sa rezervuje po 10 sekundách pripojenia, TTS podľa počtu pokusov a znakov; ide o limity aplikácie, nie faktúru Sonioxu. Denný reset je o polnoci UTC.

API kľúč zostáva na serveri. Session cookie je podpísaná, HttpOnly, SameSite=Strict a v produkcii Secure. Odhlásenie/expirácia rušia príslušné WebSockety a syntézu. Origin sa overuje presne. X-Forwarded-For sa nepoužíva; TRUST_FLY_PROXY=true je určené iba pre Fly Proxy bez priameho verejného prístupu na aplikačný port.

Katalógy sa pri používaní obnovujú najviac raz za 10 minút pre presný STT/TTS model; pri výpadku zostáva posledný úspešný katalóg vrátane stavu zastarania. Technické nastavenia latencie sú na serveri. Skriptové obmedzenia hlasu sa zobrazujú pri výbere jazyka.

## Nasadenie

**Pred nasadením treba pripraviť jeden Fly Volume translator_data v regióne fra, pripojený na /data, s právom zápisu pre UID/GID 1000 (používateľ node).** Samotné chown v Docker image neprepíše vlastníctvo nového pripojeného volume. Server beží ako neprivilegovaný node; nepridávaj automatické obchádzanie tejto ochrany.

Použi **jednu aplikačnú Machine**: nezávislé volumes na viacerých Machines nezdieľajú kvóty. Over existujúcu topológiu pred deployom. Pri nasadzovaní nevytváraj automaticky druhú HA Machine. Podrobný postup a návrat k pôvodnej verzii: [nasadenie](deployment.md).

## Dokumentácia

- [Implementácia a overenie](docs/modernization.md)
- [Pôvodná dokumentácia pred modernizáciou — historický stav](docs/README-before-modernization.md)

Staré nastavenia MAX_TTS_QUEUE, MAX_TTS_CHARS, MAX_TEXT_CHARS, MAX_WS_MESSAGE_KB, TTS_PLAYBACK_TIMEOUT_SECONDS a pomocné timeout premenné už nemenia pevné bezpečnostné limity. Aktuálne podporované hodnoty sú v .env.example. Zmena modelu je centrálne v runtime-models.js.

## Modernizácia 3.1 (pripravená na staging)

- Nastav `APP_OWNER_USERNAME` na presné používateľské meno vlastníka z `APP_ACCESS_CODES`. Voliteľné `APP_OWNER_VOICE_NAME` je predvolene `my voice`. Aplikácia ukáže klon iba po zistení platného UUID a stavu `ready` pre `tts-rt-v2` v projekte priradenom k `SONIOX_API_KEY`.
- `/api/voices` načíta všetky stránky `/v1/shared-voices` a zoznam vlastných hlasov. Pri nedostupnom API zostanú vstavané hlasy z posledného modelového katalógu; klon sa zamietne.
- Profil sa vyberá pred začiatkom relácie. Kontextové výrazy sú orientačné pomôcky pre Soniox; pri medicíne a úradoch vždy over výsledný text. Len jednoznačné skratky CNC/CAD/CAM majú pevné `translation_terms`.
- AUTO je predvolený režim. PTT drží audio otvorené, pri pustení pošle približne 200 ms ticha a `finalize`; relácia pokračuje po `<fin>`. Pri slúchadlách lokálna detekcia hlasnej novej reči preruší práve prehrávaný hlas. Pri reproduktore zostáva striedanie počúvania a prehrávania.
- Vlastník môže cez Nastavenia zrušiť prístup ďalšieho účtu. Zrušenie sa uloží do SQLite a uzavrie jeho aktívne relácie. Pre nový prístup treba vymeniť jeho kód v konfigurácii a zaviesť samostatnú obnovu revokácie; aplikácia zámerne neobnovuje starý kód automaticky.

### Staging kontrola pred produkciou

Spusti `npm run check`, `npm test`, `npm audit --omit=dev` a Docker build. So skutočným Soniox projektom over `my voice` v SK/DE/PL, oba smery, Android Chrome, iPhone Safari, slúchadlá a hlasný reproduktor, hlučnú miestnosť a prerušenie siete. Zmeraj medián a P95 času po prvý počuteľný preklad. Pred nasadením zvlášť over návrat na predchádzajúci obraz Dockeru a použiteľnosť existujúceho volume. Reproduktorový barge-in ostáva vypnutý do fyzických testov ozveny.
