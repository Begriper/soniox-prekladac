# Záverečná kontrola verzie 3.6.0

Dátum: 12. 11. 2026 · Kontroloval: Claude Fable 5.2 (effort high) · Druhý model: Codex `gpt-6.1-sol` (iba čítanie) · Zadanie: `docs/zadanie-kontrola-fable-2026-11.md`

## Verdikt

**Áno po opravách. Opravy sú už urobené a otestované, nič nie je commitnuté.**

V novom „hlase pripravenom vopred“ (Reproduktor) bolo šesť chýb, pri ktorých sa strácala reč alebo hlas. Dve z nich by si v bežnom rozhovore zbadal. Všetky sú opravené a každá má vlastný test.

Pred nasadením ostáva:

1. ~~Krátky test Reproduktora na telefóne so skutočným Sonioxom~~ **hotový 12. 11. 2026, prešiel** (pozri „Test na telefóne po opravách“).
2. Kroky z časti „Kroky pred nasadením“.

Dva limity (R1 a R2) si rozhodol 12. 11. 2026 („uprav oba“) a sú upravené. Verzia je zvýšená na **3.6.1**, aby telefón pri ďalšom teste načítal opravy klienta.

Odpovede na tri otázky zo zadania:

| Otázka | Odpoveď |
|---|---|
| Sú zmeny z auditu urobené správne a bez nových chýb? | Väčšinou áno. Výnimkou bol hlas pripravený vopred (N1–N5, N10) a tri drobnosti (N7–N9). Všetko je opravené. V ostatných balíkoch som nenašiel nič, čo by bránilo nasadeniu. |
| Sú správne tri opravy z testu na telefóne? | **L6** (Oproti sebe na šírku): áno. **L7** (limit TTS po kúskoch): áno, ale bola neúplná, doplnil som ju (N6). **L3** (hlas čakal 10 s): opravila pozorovaný prípad, ale otvorila inú chybu; nahradil som ju presnejším pravidlom (N3). |
| Je všade `stt-rt-v6` a `tts-rt-v2`, nikde `v5`? | Áno. Model je na jednom mieste (`runtime-models.js:3`) a berú ho odtiaľ server, katalóg aj testy. `v5` ostal iba v starých dokumentoch v `analysis/` a v README vo vete o jeho zrušení. Katalóg jazykov uložený pre v5 sa po nasadení sám zahodí (`catalog.js:27`). |

## Čo som spustil

| Kontrola | Výsledok |
|---|---|
| `npm run check` | OK (pred opravami aj po nich) |
| `npm test` pred mojimi zmenami | 221 z 221 |
| `npm test` po mojich zmenách | **237 z 237** (16 nových testov, 1 starý prepísaný); `npm audit --omit=dev` 0 nálezov |
| Pokusy na mock Sonioxe | N1 a N4 potvrdené pred opravou |
| Pokus na kópii `main` (3.5.0) | N2 sa deje aj v produkcii |
| Codex `review` (necommitnuté zmeny) | 2 nálezy |
| Codex `adversarial-review` (necommitnuté zmeny) | 2 nálezy |
| Codex `adversarial-review`, druhý prechod po opravách | 1 nález |
| Codex `adversarial-review`, tretí prechod nad konečným stavom | **approve, bez nálezov** |
| Codex `review` pred PR (po teste na telefóne, s R1, R2 a verziou 3.6.1) | 3 nálezy |
| Codex `review` po ich oprave | 2 nálezy (staršie balíky) |
| Codex `adversarial-review`, cielený prechod nad poslednými opravami | **approve, bez nálezov** |

Node na notebooku je 22.14 (projekt chce 24); varovanie k `node:sqlite` je v poriadku. CI na GitHube (Node 24) nebežalo, lebo nič nie je commitnuté.

**Neoverené:** čítačka obrazovky; tlačidlo „Pokračovať“ (R2) na telefóne (pokryté testom); Počúvanie a Slúchadlá po opravách. iPhone nie je v pláne.

## Test na telefóne po opravách

12. 11. 2026 večer · Samsung Galaxy S24 Ultra, Chrome 157 · lokálny server 3.6.1 (Node 22.14, `NODE_EXTRA_CA_CERTS` s certifikátom Kaspersky), `stt-rt-v6` + `tts-rt-v2`, región EU · Konverzácia, SK↔DE, Reproduktor, automatický mikrofón · USB, `adb reverse tcp:3000 tcp:3001` · správy stránky cez Chrome DevTools (iba karta `localhost:3000`).

**Výsledok: prešiel.** Relácia `86d5b2c1…`, `end_code: finished`, `provider_error: null`, žiadny `tts_fallback`, žiadna chyba v konzole. Trvanie 125 s (~2,1 min Sonioxu).

| Test | Čo sa stalo | Výsledok |
|---|---|---|
| Aktualizácia | Telefón mal uloženú 3.6.0. Po obnovení stránky načítal 3.6.1, stará cache sa zmazala, klient poslal `client_version` 3.6.1. | ✔ |
| Bežná veta | „Dobrý deň, potrebujem 2 lístky do Viedne.“ → „Guten Tag, ich brauche 2 Fahrkarten nach Wien.“ Hlas 60 ms po konci vety (`tts_stream_start`), počuť 0,26 s po konci vety. Kým František hovoril, mikrofón bol otvorený (stav „Prekladám“). | ✔ |
| Veta dlhšia než 20 s (N1) | Súvislá reč 18:20:01 → 18:20:20,5 (~19,5 s, 6 viet bez dlhšej pauzy). **Počas reči nezačal žiadny hlas.** Hlas a stlmenie mikrofónu až 20 ms po konci vety. Preklad celý, prehraný celý (~30 s hlasu). | ✔ |
| Veta s nemeckým slovom (N2, N3, L3), 2× | Soniox ju rozdelil na tri bubliny: „Musím ešte vybaviť“ · „Anmeldung“ · „na úrade.“ **Kým František hovoril, nič nehralo** (v 3.5.0 by hlas začal pri slove „Anmeldung“). Po konci vety zazneli všetky tri časti za sebou, v poradí, bez čakania (medzi časťami ~0,25 s). | ✔ |
| Latencia (koniec vety → hlas) | Medián 273 ms (7 vzoriek). | ✔ |

Poznámky:

- **p95 latencie 4 716 ms nie je oneskorenie.** Dlhú vetu poslal server do TTS ako dva streamy (po pauze dlhšej než 2 s v preklade sa stream uzavrie, `TTS_PAUSE_MS`). Druhý stream zahral hneď po prvom, ale meranie ho ráta od konca vety. Na zváženie neskôr: merať latenciu iba pre prvý stream vety, inak `fly logs` budú ukazovať skreslené p95.
- **A10 ostáva:** slovo „Anmeldung“ dostalo vlastnú bublinu, preložilo sa do slovenčiny („jedno hlásenie“) a prečítal ho slovenský hlas. Nemecký poslucháč počuje nemecký začiatok, slovenské slovo a nemecký koniec. Je to známe (úloha 5.3) a opravy N2–N4 to neriešia, iba zabránia strate reči a čakaniu.
- Prvé dve vety („Dobrý deň.“ · „Potrebujem.“) sa ukončili pri pauze a preložili samostatne; celú vetu František zopakoval. Správanie konca vety pri predvolenom nastavení, nie chyba.
- Netestované: tlačidlo „Pokračovať“ (R2), Počúvanie, Slúchadlá, PTT. R2 kryje test v kóde; ostatné sa opravami takmer nemenia (pripravený hlas sa drží iba v Reproduktore).

## Nálezy podľa závažnosti

Čísla riadkov platia pre stav po opravách.

### Opravené v tejto kontrole

**N1 · vysoké · opravené** — Pri vete dlhšej než ~15 s sa hlas spustil uprostred reči
- Kde: `speech-session.js:110` (`releaseStaleHeld`), volané z 10-sekundového časovača.
- Čo sa dialo: poistka „hlas bez konca vety pusti po 15 s“ rátala čas od prvých preložených slov. Kto v Reproduktore hovoril súvisle 15–25 s, tomu začal hrať preklad ešte počas reči. Pri hlase sa stlmí mikrofón, takže zvyšok vety sa stratil. V 3.5.0 sa to nedialo.
- Dôkaz: pokus na mock Sonioxe pred opravou.
- Oprava: poistka sa spustí, iba keď 15 s neprišlo žiadne nové rozpoznané slovo. Kým človek hovorí, hlas čaká.
- Test: `test/speaker-latency.test.js`, „a long sentence keeps its prepared voice held while the speaker is still talking“.

**N2 · vysoké · opravené · našiel Codex (adversarial)** — Cudzie slovo vo vete spustilo hlas a odrezalo zvyšok vety
- Kde: `speech-session.js:363–367` (spracovanie prekladu v `tokens`).
- Čo sa dialo: keď sa uprostred vety objavila bublina v druhom jazyku (cudzie slovo, alebo druhá osoba skočí do reči), pripravený hlas prvej časti sa hneď pustil. Mikrofón sa stlmil a to, čo človek hovoril ďalej, sa stratilo. Je to dôsledok nálezu A10 z auditu.
- Nie je to nová chyba: na kópii `main` som overil, že 3.5.0 sa správa rovnako. Vo verzii 3.6 sa však dá opraviť čisto.
- Oprava: pripravený hlas pustí iba koniec vety (alebo stop, obnova spojenia a poistka z N1). Časti vety potom zaznejú v poradí, v akom boli povedané.
- Test: „words in the other language before an endpoint keep the voice prepared and the microphone open“ (nahrádza starší test, ktorý pôvodné správanie vyžadoval).

**N3 · stredné · opravené** — Oprava L3 mohla pustiť hlas uprostred vety
- Kde: `speech-session.js:544` (rozhodnutie `op.held` v `pump`).
- Čo sa dialo: oprava L3 brala ako znak „veta sa ešte hovorí“ to, že jej bublina je posledná. Keď Soniox na chvíľu označí slovo ako druhý jazyk, vznikne za vetou prázdna bublina. Veta už nebola posledná, hlas sa nepodržal a spustil sa hneď.
- Oprava: server si počíta konce viet (`this.utterance`). Hlas sa podrží, kým od jeho prvých slov neprišiel koniec vety. Prípad L3 („Anmeldung“) funguje ďalej a jeho test prechádza.
- Test: „a word briefly taken for the other language does not start the voice in the middle of the sentence“.

**N4 · stredné · opravené** — Koniec vety priradený inej bubline nechal hlas čakať 15–25 s
- Kde: `speech-session.js:347` (značka `<end>`), `:398` (obnova STT).
- Čo sa dialo: hlas sa uvoľnil, iba keď koniec vety dostala presne jeho bublina. Pri vete rozdelenej cudzím slovom ho dostane posledná bublina. Ak tá nemala preklad, hlas čakal na poistku. Rovnaká trieda chyby ako L3.
- Oprava: každý koniec vety uvoľní pripravený hlas.
- Test: „an endpoint releases the prepared voice also when it is attributed to another item“.

**N5 · stredné · opravené · našiel Codex (adversarial)** — Výpadok TTS pri držanom hlase nechal vetu bez hlasu
- Kde: `speech-session.js:580–589`.
- Čo sa dialo: ak spojenie s TTS spadlo, keď už Soniox poslal kus zvuku, server to bral ako „hlas už hrá“ a náhradnú cestu (REST) nepoužil. Zvuk bol však iba podržaný na serveri a telefón nedostal nič. Veta ostala bez hlasu.
- Oprava: kým je zvuk iba podržaný, výpadok ide na REST a veta zaznie celá. Zaplatený zvuk ostáva započítaný.
- Test: „a failed stream whose audio was only held back is spoken again over REST“.

**N10 · stredné · opravené · našiel Codex (záverečný prechod)** — Náhradná cesta hlasu čakala na koniec vety, ktorý neprišiel
- Kde: `speech-session.js:110–116`, `:592–596`.
- Čo sa dialo: keď spojenie s TTS spadlo uprostred vety, náhradná cesta (REST) čaká na celý text. Ak potom neprišiel koniec vety, čakala donekonečna a blokovala frontu hlasu až do ďalšej vety alebo zastavenia. Poistka z N1 uvoľnila iba podržaný zvuk, nie toto čakanie.
- Treba na to súbeh dvoch vecí (výpadok TTS a chýbajúci koniec vety), preto je to zriedkavé.
- Oprava: po 15 s bez nového slova sa text považuje za hotový a hlas zaznie. Slová rozpoznané neskôr dostanú nový hlas, nestratia sa.
- Test: „a fallback that waits for the end of a sentence which never comes is spoken after 15 s of silence“.

**N6 · nízke · opravené** — Oprava L7 nepokrývala koniec textu
- Kde: `tts-transport.js:128–142`.
- Čo sa dialo: limit „prvý zvuk do 3 s“ sa po L7 ráta od posledného kúsku textu. Po 2 s pauze server stream uzavrie, ale limit sa pri tom neobnovil. Hlasu ostala 1 s; pri pomalšej odpovedi Sonioxu by veta znova prepadla na REST.
- Oprava: aj uzavretie textu dostane celý limit.
- Test: `test/tts-transport.test.js`, „the end of a streamed sentence gets the full first-audio deadline“.

**N7 · nízke · opravené · našiel Codex (review)** — Dve spojenia so Sonioxom po obnove
- Kde: `speech-session.js:399–401`.
- Čo sa dialo: obnova rozpoznávania otvára nové spojenie o 300 ms neskôr. Ak v tom okne používateľ potvrdil rozpoznaný jazyk, otvorili sa dve a jedno ostalo visieť.
- Oprava: odložený pokus sa vykoná, iba ak medzitým nevzniklo iné spojenie.
- Test: `test/server-resilience.test.js`, „a language confirmed during a stream recovery does not open a second Soniox stream“.

**N8 · nízke · opravené · našiel Codex (review)** — Heslo v poli pre pridanie odtlačku prežilo odhlásenie
- Kde: `public/app.js:594`, `:1220`.
- Čo sa dialo: pole sa mazalo iba po úspešnom overení. Po zlom hesle alebo zatvorení panela v ňom heslo ostalo aj pre ďalší účet na tom istom zariadení.
- Oprava: pole sa vymaže pri odhlásení aj pri otvorení panela.
- Test: `test/client-resilience.test.js`, „a password typed to confirm a passkey is cleared at sign-out“.

**N9 · nízke · opravené** — Druhá odpoveď 401 mohla zmazať zachovaný prepis
- Kde: `public/app.js:582`.
- Čo sa dialo: po vypršaní prihlásenia sa prepis zachová. Ak tesne potom prišla ešte jedna odpoveď 401 (napr. rozbehnuté prehratie hlasu), odhlásenie bežalo druhýkrát už bez používateľa a prepis z obrazovky zmazalo. V histórii zariadenia by ostal.
- Oprava: druhé nedobrovoľné odhlásenie sa ignoruje.
- Test: „a second expired answer after the sign-out does not clear the kept transcript“.

**N11 · nízke · opravené · našiel Codex (review pred PR)** — Stop počas žiadosti o mikrofón nechal mikrofón zapnutý
- Kde: `public/app.js:915` (`startCapture`), `:1023` (`start`).
- Čo sa dialo: od 3.6 sa spojenie otvára súčasne so žiadosťou o mikrofón. Keď používateľ ťukol na Stop skôr, než povolil mikrofón, neskoršie povolenie mikrofón aj tak zaplo. Do Sonioxu nič nešlo, ale telefón ukazoval zapnutý mikrofón až do konca dokončovania.
- Oprava: povolenie, ktoré príde po Stop, mikrofón hneď uvoľní.
- Test: `test/client-resilience.test.js`, „Stop while the microphone permission is pending never opens the microphone afterwards“.

**N12 · nízke · opravené · našiel Codex (review pred PR)** — Service worker by pri 3.6.10 prevzal cudzie HTML
- Kde: `public/sw.js:11`, `:39`.
- Čo sa dialo: kontrola „HTML patrí mojej verzii“ hľadala text `?v=3.6.1`, ktorý je aj začiatkom `?v=3.6.10`. Pri takom prechode by sa offline kópia appky mohla pokaziť.
- Oprava: musí sedieť celé číslo verzie.
- Test: `test/sw-versioning.test.js`, „the offline HTML is kept only for exactly this version, not for a longer one that starts the same“.

**N13 · nízke · opravené · našiel Codex (review pred PR)** — Mesačný limit hlásil obnovu o polnoci
- Kde: `usage-store.js:43–68` (`lastRefusal`), `speech-session.js:91`.
- Čo sa dialo: po vyčerpaní nového predvoleného mesačného limitu (30 h rozpoznávania) hláška sľubovala obnovu o polnoci UTC. Limit však platí do konca mesiaca.
- Oprava: hláška rozlišuje denný limit účtu, mesačný limit účtu a denný strop celej domácnosti. Tým je opravená aj drobnosť P4.
- Test: `test/security-ops.test.js`, „a refused conversation says which limit ran out and when it resets“.

**N14 · nízke · opravené · našiel Codex** — Pridanie odtlačku mohlo nechať požiadavku visieť
- Kde: `passkeys.js:62–81` (`/api/passkeys/register/options`).
- Čo sa dialo: handler je od 3.6 asynchrónny (kvôli overeniu hesla). Chybu databázy po overení hesla Express 4 nezachytí, takže telefón nedostal odpoveď, kým požiadavku sám nezrušil.
- Oprava: celý handler je v `try/catch`; pri chybe príde odpoveď 503.
- Test: `test/passkeys.test.js`, „a database failure after the password check answers instead of leaving the request hanging“.

**N15 · nízke · opravené · našiel Codex** — Stránka otvorená pred prvým service workerom ignorovala ďalšie aktualizácie
- Kde: `public/app.js:1334–1343`.
- Čo sa dialo: prvé prevzatie stránky service workerom sa správne nepovažuje za novú verziu, ale príznak sa potom už nezmenil. Každá ďalšia aktualizácia počas toho otvorenia sa ignorovala, kým sa stránka ručne neobnovila. Server by starého klienta pri štarte rozhovoru aj tak odmietol (`client_outdated`), takže to nie je vážne.
- Oprava: po prvom prevzatí sa príznak nastaví.
- Test: `test/client-resilience.test.js`, „a page opened before its first service worker still reloads for a later update“.

Drobnosť: `README.md:1` uvádzal 3.5.x, opravené na 3.6.x.

Dve vety v starších dokumentoch už neplatia: v `docs/implementacia-2026-11.md` („uvoľní sa pri zmene vety a najneskôr po 15 s“) a v `docs/test-android-2026-11-vysledky.md` (opis opravy L3 cez `stillSpoken`). Platí opis v N1–N4.

### Limity (rozhodnuté a upravené 12. 11. 2026)

**R1 · stredné · upravené** — Denný limit 600 hlasových požiadaviek ukončil Počúvanie s hlasom asi po hodine
- Kde: `server.js:77` (`MAX_USER_TTS_REQUESTS_PER_DAY`), `.env.example:50`.
- Čo sa dialo: každá vyslovená veta je aspoň jedna hlasová požiadavka. V teste Počúvania to bolo ~11 viet za minútu, čiže 600 za necelú hodinu. Potom sa rozhovor ukončil hláškou „Denný limit tohto účtu je vyčerpaný“ a hlas nešiel do polnoci UTC.
- Limit bol aj v 3.5.0, ale skôr zasiahol limit 120 na reláciu. Ten je teraz 300 viet, takže na denný limit sa už dostaneš.
- Náklady stráži limit znakov (200 000 denne) a limit zvuku, nie počet požiadaviek.
- Úprava: predvolená hodnota je 3000 (asi 4–5 hodín Počúvania s hlasom). Limit znakov ani zvuku sa nemenil. Ak je na Fly nastavená premenná `MAX_USER_TTS_REQUESTS_PER_DAY`, platí tá; v `fly.toml` nie je, secrets som nečítal.
- Test: `test/quick-wins.test.js`, „the default daily voice request limit leaves room for hours of listening with voice“.

**R2 · stredné · upravené** — Tlačidlo „Pokračovať“ sa počítalo ako nový rozhovor, limit je 20 denne
- Kde: `public/app.js:1225` (`resumeBtn`), `:993` a `:1008` (`?resume=1`); `server.js:73`, `:396–408`.
- Čo sa dialo: ako pokračovanie sa rátalo iba automatické pripojenie. Ručné „Pokračovať v rozhovore“ (po prepnutí do inej appky, po výpadku dlhšom než ~10 s, po strate mikrofónu) bolo nový rozhovor. Pri teste sa pri chybe spojenia započítalo 11 ručných štartov a limit bolo treba lokálne zvýšiť na 100.
- Úprava (variant a): tlačidlo „Pokračovať“ posiela `?resume=1`. Server ho ako pokračovanie uzná iba do 5 minút od konca rozhovoru toho istého prihlásenia; neskôr sa ráta ako nový. Server sa nemenil (okrem komentára).
- Čo ostáva rovnaké: nový štart mikrofónom sa ráta vždy, aj po 2 minútach ticha. Limit 20 denne ostal; ako admin si ho vieš zvýšiť v správe účtu.
- Test: `test/client-resilience.test.js`, „the Continue button resumes the interrupted conversation instead of starting a counted new one“. Serverovú stranu kryje existujúci test v `test/reconnect.test.js`.

Tieto dve úpravy sú malé a Codex ich už nevidel; prejde ich revízia pred PR.

### Nízke, neopravené (netreba pred nasadením)

- **P1** — Po obnove rozpoznávania počas otvoreného potvrdenia jazyka server znova prijíma zvuk (`speech-session.js:299`). Môže prísť druhý návrh jazyka. Oprava: nechať `acceptAudio` vypnuté, kým je návrh otvorený.
- **P2** — Otvorená appka 3.5.0 nie je po nasadení odmietnutá, lebo neposiela verziu (`speech-session.js:191`). Beží ďalej so starým kódom a každé jej opätovné pripojenie sa ráta ako nový rozhovor. Po zatvorení a otvorení appky sa načíta nová verzia. Stačí o tom vedieť.
- **P3** — Súvislá reč dlhšia než 2 minúty bez pauzy: TTS stream má strop 120 s (`tts-transport.js:121`) a hlas tej vety zlyhá hláškou „Hlas sa nepodarilo dokončiť“. Text ostane. Zriedkavé.
- ~~**P4**~~ — opravené spolu s N13.
- **P5** — Prihlásenie odtlačkom má spoločný limit 100 pokusov za 10 minút, ktorý ráta aj úspešné a cudzie pokusy (`passkeys.js:16`, `:22`). Prihlásenie heslom tým nie je dotknuté.
- **P6** — Veta rozdelená na viac než 6 bublín (veľa jazykových preskokov bez pauzy) prekročí frontu hlasu a posledné časti ostanú iba v texte (`speech-session.js:441`). Pri teste vznikli najviac 3 bubliny.

### Čo som prešiel a je v poriadku

- **Fronta hlasu:** zrušenie, stop, PTT, poradie viet, limity znakov a zvuku, prechod na REST bez dvojitého účtovania. Dvojitý `tts_stream_start` pri prechode na REST klient znáša rovnako ako v 3.5.0.
- **Obnova STT v relácii:** najviac 2× za minútu, prerušená veta sa dokončí, odmietnutý handshake (402) je konečná chyba, staré spojenie sa ignoruje.
- **Odhlásenie a súkromie prepisu:** zachovaný prepis dostane späť iba ten istý účet. Iný účet neuvidí text, zvuk v cache ani text pre čítačku. Do histórie sa ukladá pod menom vlastníka.
- **Počítanie rozhovorov:** `?resume=1` uzná server iba do 5 minút od konca rozhovoru toho istého prihlásenia; iné parametre odmietne.
- **Oproti sebe na šírku (L6):** trieda `face-on` sa nastavuje správne; skrytie platí iba na šírku pri výške do 520 px.
- **Limity prihlásenia, kvóty, dávkový zápis zvuku, SIGTERM, service worker, zálohovací skript.**

## Codex: čo som prevzal a čo nie

Všetky nálezy som overil v kóde a testom. Naslepo som neprevzal nič.

| Beh | Nález | Rozhodnutie |
|---|---|---|
| `review` | Dve spojenia STT po obnove počas potvrdenia jazyka | Prevzaté, opravené (N7). Prvý test, ktorý som napísal, chybu nezachytil; opravený test bez opravy padá. |
| `review` | Heslo pre odtlačok ostáva v poli po odhlásení | Prevzaté, opravené (N8). |
| `adversarial-review` s `--base main` | Žiadny nález | **Neplatný beh.** Vetva a `main` sú ten istý commit, takže Codex videl prázdny rozdiel. Zopakoval som ho s `--scope working-tree`. Príkaz v `AGENTS.md` a v zadaní necommitnuté zmeny nevidí. |
| `adversarial-review` (necommitnuté zmeny) | Cudzie slovo uvoľní hlas a odreže vetu (vysoké) | Prevzaté, opravené (N2). Nesúhlasím iba s označením „regresia“: 3.5.0 sa správa rovnako, overil som to pokusom. |
| `adversarial-review` (necommitnuté zmeny) | Výpadok TTS zahodí držaný zvuk (stredné) | Prevzaté, opravené (N5). |
| `adversarial-review`, druhý prechod po opravách | Náhradná cesta (REST) čaká na koniec vety aj po 15 s (Codex: vysoké) | Prevzaté, opravené (N10). Závažnosť som znížil na strednú: treba na to výpadok TTS a zároveň chýbajúci koniec vety, a samo sa to uvoľní pri ďalšej vete. |
| `adversarial-review`, tretí prechod nad konečným stavom | Žiadny nález, verdikt „approve“ | Codex si overil obe posledné opravy vlastnými pokusmi (pokračovanie textu počas REST, zrušenie hlasu, zastavenie). Pripomína spustiť celé testy na Node 24; to urobí CI. |
| `review` pred PR | Stop počas žiadosti o mikrofón (P2) | Prevzaté, opravené (N11). |
| `review` pred PR | Kontrola verzie HTML v service workeri pri 3.6.10 (P2) | Prevzaté, opravené (N12). Dnes sa neprejaví, až pri dvojcifernom čísle opravy. |
| `review` pred PR | Mesačný limit hlási obnovu o polnoci (P2) | Prevzaté, opravené (N13), spolu s P4. |
| `review` po ich oprave | Async handler pridania odtlačku nechá požiadavku visieť pri chybe databázy (P2) | Prevzaté, opravené (N14). |
| `review` po ich oprave | Aktualizácia sa nenačíta, ak sa stránka otvorila pred prvým service workerom (P3) | Prevzaté, opravené (N15). |
| cielený `adversarial-review` | Žiadny nález, verdikt „approve“. Codex overil aj dva ďalšie scenáre Stop počas zapínania mikrofónu. | |

Codex nenašiel N1, N3, N4, N6, N9 ani limity R1 a R2. Ja som nenašiel N5, N7, N8 a N10; N2 som videl, ale mylne som ho najprv nechal ako známe správanie z 3.5.0.

## Odporúčania k návrhom z testu

| # | Návrh | Odporúčanie | Prečo |
|---|---|---|---|
| L2 | Počúvanie s hlasom z reproduktora stráca reč | **Nápoveda: urobiť pred nasadením.** **„Hlas do ucha“: neskôr**, ako samostatná úloha. | Príčina je potlačenie ozveny v Androide, nie appka ani Soniox. V 3.5.0 je to rovnaké, nie je to nová chyba. Nápoveda („Pre hlas použi slúchadlá, inak sa časť reči nezachytí“) je pár riadkov bez rizika. „Hlas do ucha“ stále stráca ~¼ reči, funguje iba v Android Chrome a v pokuse sa zvuk nevrátil na spodný reproduktor; to treba najprv overiť. Vypnúť potlačenie ozveny neodporúčam. |
| L1 | Logovať kód chyby spojenia STT | Urobiť pred nasadením alebo hneď po | Malé a bez rizika. Bez toho v `fly logs` neuvidíš, prečo spojenie padlo. |
| L4 | Automatickú obnovu skúšať dlhšie (~2 min) | Neskôr, prvá malá verzia po nasadení | Užitočné v tuneli alebo výťahu. Mení správanie pri výpadku a chce test so skutočnou sieťou. Súvisí s R2: dnes po ~10 s ostáva ručné „Pokračovať“, ktoré sa ráta. |
| L5 | Oproti sebe: písmo podľa dĺžky textu, skryť hlavičku aj na výšku | Neskôr | UX práca stredného rozsahu, treba ju vidieť na telefóne. |
| — | Oproti sebe na šírku: menšie tlačidlá | Neskôr, spolu s L5 | Iba CSS. |
| — | PTT: nové stlačenie zruší hlas predošlej krátkej vety | Neskôr, po skúsenostiach | Nie je jasné, čo je správne; v Reproduktore musí byť mikrofón pri stlačení voľný. |
| — | Slúchadlá: prerušená veta sa nedohrá | Nerobiť | Vyhovuje ti to a je to predvídateľné. |
| — | „Ukončiť hneď“ výraznejšie | Neskôr, spolu s L5 | Iba vzhľad; funkcia je overená. |
| A10 / 5.3 | Cudzie slovo otočí smer prekladu a rozdelí bublinu | Neskôr; najprv zaznamenať surové tokeny (platený test) | Bez skutočných dát by sa opravovalo naslepo. Najhorší dôsledok (stratená reč a čakanie hlasu) riešia N2–N4. Ostáva vzhľad: tri bubliny a cudzie slovo prečítané druhým hlasom. |
| — | Dvojitý `tts_stream_start` pri prechode na REST | Nerobiť | Klient to rieši od 3.5.0, používateľ nič nezbadá. |
| Test 10 | Ladenie konca vety | Nechať predvolené | Súhlasím so záverom testu: zisk ~0,1 s nestojí za stratené slová. |
| — | Zvýšiť verziu | Áno, pozri kroky | |

## Kroky pred nasadením

1. **Verzia: hotové, 3.6.1** (12. 11. 2026, na tvoj pokyn). Tvoj telefón mal z testu uloženú 3.6.0 pre adresu `localhost` a bez zmeny čísla by pri ďalšom lokálnom teste nenačítal dnešné opravy klienta. Zmenené sú všetky miesta: `package.json`, `package-lock.json` (2×), `server.js:18`, `public/app.js:18` a `:928` (adresa workletu), `public/sw.js` (názov cache a zoznam súborov), `public/index.html` (6×), `public/manifest.webmanifest` (4×). Zhodu stráži `test/sw-versioning.test.js`; `npm test` 232/232. Nadpis „od 3.6.0“ v `deployment.md` ostal, lebo hovorí, odkedy existuje zálohovací skript. Do `deployment.md` treba pri nasadení zapísať release ako 3.6.1.
2. **Krátky skutočný test na telefóne: hotový, prešiel** (12. 11. 2026, ~2,1 min Sonioxu). Podrobnosti v časti „Test na telefóne po opravách“.
3. **Commit, PR, CI.** Lokálne `npm run check`, `npm test` (237/237) a `npm audit --omit=dev` (0); CI na Node 24 musí byť zelené. Revízia Codexu pred PR je hotová (pozri časť Codex).
4. **Záloha databázy.** Pozor: `backup-db.js` na serveri ešte nie je, príde až s 3.6. Pred týmto nasadením urob snapshot volume ako doteraz (`fly volumes snapshots create <id volume>`). Kópiu mimo Fly podľa `deployment.md` urob hneď po nasadení: `fly ssh console -C "node /app/backup-db.js"` a potom `fly ssh sftp get`. Súbor obsahuje hashe hesiel, ulož ho šifrovane.
5. **Nasadenie** iba s tvojím výslovným súhlasom, na existujúcu Machine ako doteraz.
6. **Kontrola po nasadení:** `/api/config` ukáže novú verziu; `/api/diagnostics` ukáže `stt-rt-v6` a `tts-rt-v2`; `fly logs` obsahuje riadok `session_end` po prvom rozhovore; krátky rozhovor na telefóne v Reproduktore a Počúvaní. Výsledok zapísať do `deployment.md`.
7. **Návrat späť:** rollback na v53 (3.5.0) je bezpečný. Databáza nemá nové tabuľky a starý server katalóg uložený pre v6 ignoruje. Po 15. 12. 2026 však aj 3.5.0 pobeží na v6, lebo Soniox v5 presmeruje.

## Zmeny, ktoré som urobil

| Súbor | Zmena |
|---|---|
| `speech-session.js` | N1, N2, N3, N4, N5, N7, N10, N13 |
| `usage-store.js` | N13 |
| `public/sw.js` | N12 |
| `server.js`, `.env.example` | R1; komentár k R2 |
| `tts-transport.js` | N6 |
| `public/app.js` | N8, N9, N11, N15, R2 |
| `passkeys.js` | N14 |
| `README.md` | číslo verzie v nadpise |
| `test/speaker-latency.test.js` | 5 nových testov, 1 prepísaný |
| `test/tts-transport.test.js` | 1 nový test |
| `test/server-resilience.test.js` | 1 nový test |
| `test/client-resilience.test.js` | 5 nových testov |
| `test/passkeys.test.js` | 1 nový test |
| `test/sw-versioning.test.js` | 1 nový test |
| `test/security-ops.test.js` | 1 nový test |
| `test/quick-wins.test.js` | 1 nový test |

Nič som necommitol, nenasadil a nemenil som Fly ani `.env`. Soniox sa volal iba pri teste na telefóne s tvojím súhlasom (~2,1 min). Dočasná konfigurácia servera v `.claude/launch.json` (worktree aj hlavný priečinok) je po teste vrátená a presmerovania `adb` sú zrušené.
