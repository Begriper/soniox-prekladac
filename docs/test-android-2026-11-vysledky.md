# Výsledky: lokálny test 3.6.0 so skutočným Sonioxom na Androide

Dátum: 12. 11. 2026 · Telefón: Samsung Galaxy S24 Ultra (SM-S928B), Chrome 157 · Server: notebook, Node 22.14, `stt-rt-v6` + `tts-rt-v2`, región EU · Spojenie: USB, `adb reverse tcp:3000` · Viedol: Claude Opus 5.5

## Zhrnutie

**Verzia 3.6.0 so skutočným Sonioxom na Androide funguje.** Konverzácia (Reproduktor, Slúchadlá, Podržať), Počúvanie, výpadok spojenia, asistent počas hlasu, „Oproti sebe“ a „Ukončiť hneď“ prešli. Počas testu sa našli a **opravili 3 chyby** (L3, L6, L7, každá s testom). Ďalej je zapísaných 6 návrhov a jedno dôležité zistenie k Počúvaniu (L2).

| Test | Výsledok |
|---|---|
| 1 Reproduktor SK↔DE, hlas pripravený vopred | ✔ hlas 0,25–0,3 s po konci vety |
| 2 Slúchadlá, prerušenie rečou | ✔ (prerušená veta sa nedohrá) |
| 3 PTT, rýchle pustenie a stlačenie | ✔ text; hlas prvej vety sa zruší (návrh) |
| 4 Počúvanie titulky + hlas z reproduktora | ⚠ stratí sa ~½ reči (L2) |
| 4b Počúvanie iba titulky | ✔ takmer doslovný prepis |
| 4c Počúvanie, hlas do slúchadla pri uchu (pokus) | ✔/⚠ stratí sa ~¼ reči, sľubné |
| 5 Čísla, ceny, dátumy | ✔ (chyby rozpoznania Sonioxu pri nemčine) |
| 6 Slovo z iného jazyka | ⚠ rozdelenie na 3 bubliny (A10); 10 s čakanie **opravené (L3)** |
| 7 Výpadok (USB) | ✔ 3 pokusy za ~10 s, potom „Pokračovať“ (návrh L4) |
| 8 Asistent počas hlasu | ✔ hlas pokračuje |
| 9a Oproti sebe, Najväčšie písmo | ⚠ vidno ~⅓ dlhej vety (L5) |
| 9b Oproti sebe na šírku | ✘ → **opravené (L6)** |
| 9c „Ukončiť hneď“ | ✔ (druhý pokus so sledovaním); prechod na REST pri dlhej vete **opravený (L7)** |
| 10 Ladenie konca vety | predvolené nechať; agresívne nastavenie stráca slová |

**Latencia** (koniec vety → prvý zvuk hlasu na telefóne, websocket): medián **~0,29 s**, bežne 0,22–0,33 s, p95 v reláciách 0,31–0,34 s. Najhoršie prípady: 12,6 s (L3, opravené) a 4–5 s pri zaostávaní hlasu v Počúvaní pri rýchlej reči.
**Od posledného slova po koniec vety** (odhad z prepisu): medián ~1,7 s pri predvolenom nastavení.
**Soniox spolu:** ~12 min rozhovoru (pozri tabuľku na konci).

**Opravy v kóde (necommitnuté, `npm run check` OK, `npm test` 221/221):**
- `speech-session.js:529–530`: hlas sa nepodrží, keď už začala ďalšia bublina (L3); test v `test/speaker-latency.test.js`.
- `tts-transport.js:128–136`: limit prvého zvuku sa pri posielaní kúskov počíta od posledného textu (L7); test v `test/tts-transport.test.js`.
- `public/app.js:142` + `public/style.css:207`: Oproti sebe na šírku skryje hlavičku (L6); test v `test/listen-ui.test.js`.

## Prostredie: Kaspersky na notebooku (nie chyba appky)

- Prvý rozhovor prešiel. Všetky ďalšie skončili po ~0,8 s kódom `stt_connection` (`fatal: true`).
- Príčina: Kaspersky Anti-Virus na notebooku robí TLS inšpekciu a podvrhuje certifikát `Kaspersky Anti-Virus Personal Root Certificate`. Node 22.14 nečíta úložisko certifikátov Windows, preto `SELF_SIGNED_CERT_IN_CHAIN` pri `stt-rt.eu.soniox.com` aj `tts-rt.eu.soniox.com`.
- Riešenie iba pre test: server spustený s `NODE_EXTRA_CA_CERTS` (koreňový certifikát Kaspersky exportovaný z Windows). Kaspersky ani Windows sa nemenili. Produkcie na Fly sa to netýka.
- **Nález L1 (diagnostika):** `speech-session.js:307` zahodí objekt chyby (`socket.on("error", () => …)`), takže v logu `session_end` je `provider_error: null` a príčina nebola vidieť. Návrh: zapísať `err.code` (napr. `SELF_SIGNED_CERT_IN_CHAIN`, `ECONNRESET`) do `provider_error` alebo samostatného logu.
- Klient sa po zlyhaní správal rozumne: najviac 3 automatické pokusy s rastúcim odstupom (`public/app.js:1030–1033`). Z 22 neúspešných relácií sa do denného limitu započítalo 11 (ručné spustenia); automatické s `?resume=1` nie. Funguje podľa zámeru.
- Pre test zvýšený `MAX_USER_SESSIONS_PER_DAY=100` v lokálnom `.env`.

## Test 1: Reproduktor SK↔DE — PREŠIEL

Relácie `fc1f9cbf…` (36 s) a `7c0a178b…` (63 s), `end_code: finished`, `provider_error: null`.

| Veta | Prepis → preklad |
|---|---|
| DE „Guten Tag, wie geht es Ihnen?“ | „Dobrý deň, ako sa máte?“ |
| DE „Wo ist der Bahnhof, bitte?“ | „Kde je stanica, prosím?“ |
| SK „Zajtra ráno pôjdem autom do Mníchova a cestou sa zastavíme na obed.“ | „Morgen früh fahre ich mit dem Auto nach München, und unterwegs halten wir zum Mittagessen an.“ |
| SK „A večer sa vrátime domov.“ | „Und abends fahren wir nach Hause zurück.“ |

- **Hlas pripravený vopred funguje.** `tts_stream_start` prichádza v tej istej milisekunde ako finálny token; `playback_started` na telefóne 0,25–0,3 s po konci vety. Server: medián 291 ms, websocket medián 303 ms, p95 329 ms (8 vzoriek). František: „hlas začínal hneď po vete“.
- Mikrofón je počas reči otvorený (stav `translating`, `microphone_muted: false`), stlmí sa ~170 ms po `tts_stream_start` a otvorí hneď po `playback_done`.
- **Veta povedaná cez hlas sa nezachytí** (dvakrát skúšané). Je to zámer režimu Reproduktor (stlmenie proti ozvene); František musel vetu zopakovať. Pre skúsenosť používateľa: zvážiť krátku nápovedu „počkaj, kým dohovorím“ alebo pri Reproduktore ukázať, že mikrofón je počas hlasu vypnutý. Prerušenie hlasom sa overí v režime Slúchadlá.
- Konzola telefónu: bez chýb (iba upozornenie na zastaraný `apple-mobile-web-app-capable`).

## Test 2: Slúchadlá — PREŠIEL (s poznámkami)

Relácia `d95feb17…` (21 s), `end_code: finished`, latencia medián 316 ms (websocket 327 ms, 2 vzorky).

- Hlas bol počuť v slúchadlách celý čas.
- **„Priebežný“ hlas v praxi začne až na konci vety.** `tts_stream_start` prišiel už pri čiastočnom texte („Heute ist schönes Wetter,“, 10:54:50.9), ale prvé bajty zvuku prišli až 0,11 s po finálnom tokene (10:54:53.3). Soniox TTS zrejme pri krátkom kúsku textu čaká na pokračovanie. Pri dlhších vetách môže začať skôr; neoverené.
- **Prerušenie hlasom funguje:** klientsky VAD (`public/app.js:903`) po 4 zásahoch pošle `stop_audio`, hlas prvej vety sa zastaví (`audio_status: interrupted`) a druhá veta sa preloží a zaznie (0,31 s po konci vety).
- **UX poznámka:** prerušená veta sa už nedohrá ani nezopakuje automaticky, takže poslucháč z nej počul iba začiatok (~1,4 s z „Heute ist schönes Wetter, wir gehen spazieren in den Park und danach essen wir Eis.“). Františkovi to vyhovuje; na zváženie je, či pri prerušení vlastnou rečou (rovnaký smer prekladu) nedohrať frontu.
- Kvalita prekladu: „Ty si daj čokoládovú.“ → „Du nimm dir eine Schokoladentorte.“ (model si domyslel „Torte“, „Du nimm“ je negramatické). Vec modelu, nie appky.
- DE „Ich möchte gern ein Bier, bitte.“ → „Prosím, dáte mi jedno pivo?“

## Test 3: PTT (Podržať) v Reproduktore — PREŠIEL (s UX poznámkou)

Relácia `182461fe…` (62 s), `end_code: finished`, latencia medián 331 ms (websocket p95 340 ms, 3 vzorky).

- „Kde je najbližšia lekáreň?“ → „Wo ist die nächste Apotheke?“; „Die Apotheke ist gleich um die Ecke.“ → „Lekáreň je hneď za rohom.“ Obe zazneli.
- Endpoint prišiel ešte počas držania tlačidla (`ptt_end` až 0,5 s po `playback_started`), hlas teda začal skôr, než František pustil. Funguje dobre.
- **Rýchle pustenie a nové stlačenie (A15): rozpoznanie funguje.** „Ďakujem.“ (turn-3) aj „Prajem pekný deň.“ (turn-4) sa prepísali a preložili, nič sa nestratilo v texte.
- **Hlas prvej vety sa ale zruší.** Nové stlačenie 25 ms po `tts_stream_start` pre „Danke.“ poslalo `stop_audio` (`public/app.js:655`, volané pri `ptt_start` / `public/app.js:1170`), stav `interrupted`. Druhá osoba teda „Danke“ nepočuje. Logické pri Reproduktore (mikrofón musí byť otvorený), ale pre používateľa prekvapivé („napísalo prerušené“). Návrh na zváženie (nie oprava naslepo): pri novom stlačení v tom istom smere do ~1 s hlas krátkej predchádzajúcej vety nezrušiť, ale dohrať po pustení; alebo aspoň ponúknuť ťuknutím „prehrať znova“ pri prerušenej bubline.

## Test 4: Počúvanie (titulky + hlas), DE → SK — PREŠIEL (s poznámkami)

Relácia `4d2a2b69…` (65 s), `end_code: finished`. Zdroj: YouTube „Tagesschau in 100 Sekunden“ (10. 11. 2026) z reproduktora notebooku, rýchla hlásateľka. `listen_source: de`, výstup reproduktor.

- **Titulky:** plynulé (František). Prvý text 2,3 s po štarte, finálny text 1–2 s po začiatku vety. Mikrofón v Počúvaní nie je nikdy stlmený (`fullDuplex`), zvuk z mikrofónu tiekol nepretržite.
- **Hlas:** všetkých 12 viet zaznelo, nič sa nezahodilo. Latencia medián 319 ms, ale **p95 5 120 ms**: pri rýchlej reči hlas zaostáva za titulkami, najviac ~5–6 s (napr. turn-9 finálny 11:05:22.9, hlas až 11:05:27.7). Po pauze v reči sa dobehne. Očakávané pri jednom hlase; ak to bude prekážať, pomôže rýchlosť hlasu 1,1–1,2× v Počúvaní.
- **Rozdelenie viet:** koniec vety sa niekedy určí uprostred vety, keď hlásateľka spraví pauzu: „Heute spreche ich nach mehr als 8.“ | „Monaten Verhandlungen mit der US-Familie.“ | „Erneut über.“ | „Vorgestellt.“ Preklad úlomkov je horší („Dnes hovorím po viac ako 8.“). Dlhé vety (turn-6, 7, 10) sa preložili dobre. Súvisí s ladením `ENDPOINT_*` (úloha 4.2): pre Počúvanie by mohol pomôcť dlhší `max_endpoint_delay_ms` ako pre Konverzáciu.
- **Porovnanie so skutočným textom** (text hlásateľky je v popise videa):

| Hlásateľka | Appka (prepis) |
|---|---|
| Guten Tag, ich begrüße Sie zur Tagesschau. | Guten Tag, ich begrüße Sie zur Tagesschau. ✔ |
| Ukraine-Gespräche in Abu Dhabi haben begonnen. | **chýba celé** |
| Nach mehr als acht Monaten verhandeln Russland und die Ukraine unter US-Vermittlung erneut über eine mögliche Beendigung des Krieges. | „Heute spreche ich nach mehr als 8.“ · „Monaten Verhandlungen mit der US-Familie.“ · „Erneut über.“ · „Vorgestellt.“ (**väčšina chýba**) |
| In den Vorgesprächen vor dem Dreiertreffen waren auch Vertreter Europas unter NATO beteiligt. US-Präsident Trump hatte zuletzt Hoffnungen auf ein baldiges Friedensabkommen gemacht. | „In 3 Treffen waren auch Vertreter Europas und der NATO beteiligt, wo Präsident Trump hatte zuletzt Hoffnungen auf ein baldiges Frieden.“ (takmer celé) |
| Auch die G7-Außenminister beraten über den Ukraine-Krieg. Es geht dabei um die Unterstützung des Landes im Winter. Auch die Militärhilfe dürfte besprochen werden. | „Jetzt eben Außenminister beraten über den Ukraine-Krieg. Es geht darum, um die Unterstützung des Landes im Winter. Auch die Militärhilfe dürfte besprochen werden.“ ✔ |
| Zuletzt hatten die USA ihre Unterstützung reduziert. Bei den Beratungen ist auch der ukrainische Außenminister anwesend. | „Die Unterstützung akzeptiert. Bei den Beratungen.“ · „Ukrainischer Außenminister.“ (časť chýba) |
| Amtsenthebungsverfahren gegen US-Verteidigungsminister Hexeth beantragt. Ein Kongressabgeordneter der Republikaner präsentierte hierfür Anklagepunkte. | „Amtsenthebung gegen US-Verteidigungsminister Hegseth beantragt. Ein Abgeordneter der Republikaner präsentierte hierfür Anklagen gegen Hegseth.“ ✔ |
| Hexeth wird vorgeworfen, ohne Zustimmung des Kongresses … Macht missbraucht zu haben. Sollte es zu einem Verfahren kommen, … | „Die Zustimmung des Kongresses.“ · „Verfahren kommen.“ (**väčšina chýba**) |

- **Nález L2 (dôležitý): v Počúvaní s hlasom z reproduktora telefónu sa stráca veľká časť reči.** Výpadky sedia s časmi, keď telefón hral slovenský hlas. Napríklad „Ukraine-Gespräche in Abu Dhabi…“ zaznelo počas hlasu prvej vety (11:04:44,1–47,3) a nezachytilo sa vôbec. Dlhé vety, ktoré prišli, keď hlas mlčal, sú takmer bezchybné. Zvuk z mikrofónu pritom tiekol nepretržite (server mikrofón v Počúvaní nestlmuje). Najpravdepodobnejšia príčina: potlačenie ozveny v Androide (`echoCancellation: true`, `public/app.js:909`) počas prehrávania stlmí aj vzdialený zvuk z notebooku. Ostatné rozpoznávacie chyby („US-Familie“ namiesto „US-Vermittlung“) sú drobnosti. Overenie: krátky beh Počúvania iba s titulkami, pozri test 4b.

### Test 4b: Počúvanie iba s titulkami (hlas vypnutý) — potvrdzuje L2

Relácia `72a3c51f…` (69 s), to isté video od začiatku, rovnaké umiestnenie telefónu.

- Prepis je takmer doslovný: „Ukrainegespräche in Abu Dhabi haben begonnen. Nach mehr als 8 Monaten verhandeln Russland und die Ukraine unter US-Vermittlung erneut über eine mögliche Beendigung des Krieges…“, „Zuletzt hatten die USA ihre Unterstützung reduziert. Bei den Beratungen ist auch der ukrainische Außenminister anwesend.“ Vety, ktoré v teste 4 chýbali, sú tu celé.
- Bez hlasu sa vety ani nerozsekávajú na úlomky; Soniox drží dlhé súvislé bubliny.
- **Záver L2:** stratu reči v teste 4 spôsobuje hlas z reproduktora toho istého telefónu (potlačenie ozveny v Androide), nie Soniox ani nastavenie konca vety. Návrhy (rozhodnutie pre Františka, neopravené):
  1. V Počúvaní s hlasom a bez slúchadiel ukázať nápovedu „Pre hlas použi slúchadlá, inak sa časť reči nezachytí.“
  2. Alebo v Počúvaní predvolene zapínať hlas iba so slúchadlami.
  3. Vypnúť `echoCancellation` v Počúvaní neodporúčam: mikrofón by zachytával vlastný slovenský hlas a ten by sa prepisoval.
- Poznámka k nástroju: pri veľmi dlhých bublinách logger skrátil správy a posledné vety z bubliny sa do záznamu nedostali. Pre test 4 to neplatí, tam skrátená nebola žiadna.

### Pokus: hlas do horného reproduktora (slúchadlo pri uchu), nápad Františka

- Chrome 157 na S24 Ultra nemá výber výstupu zvuku: `enumerateDevices` vracia iba `audiooutput: default`, `HTMLMediaElement.setSinkId` ani `selectAudioOutput` nie sú. `AudioContext.setSinkId` existuje, ale nie je čo vybrať.
- Ponúka však dva **vstupy**: `Speakerphone` a `Headset earpiece`.
- Pokus cez DevTools, bez Sonioxu: `getUserMedia({ audio: { deviceId: <Headset earpiece> } })` a k tomu tón cez `AudioContext`. **Tón išiel z horného reproduktora pri uchu.** Druhý tón po prepnutí na `Speakerphone` išiel tiež hore; prepnutie späť sa v tom istom pokuse neprejavilo.
- Záver: v PWA sa dá hlas presmerovať do slúchadla pri uchu výberom vstupu „Headset earpiece“. Je to sľubná náhrada slúchadiel pre Počúvanie (rieši L2). Overenie s rozpoznávaním: test 4c.

### Test 4c: Počúvanie s hlasom do slúchadla pri uchu (pokus)

Relácia `015cac85…` (76 s). Na stránke dočasne cez DevTools podvrhnutý `getUserMedia` s `deviceId` = „Headset earpiece“; v kóde appky žiadna zmena, po obnovení stránky zrušené. Latencia medián 296 ms, p95 4 140 ms (zaostávanie hlasu pri rýchlej reči, ako v teste 4).

- František: hlas išiel celý čas z horného reproduktora pri uchu, s malým oneskorením, „všetko som rozumel, som spokojný“.
- Prepis oproti textu hlásateľky:
  - celé alebo takmer celé: „Ukrainegespräche in Abu Dhabi haben begonnen. Nach mehr als 8 Monaten verhandeln Russland und die Ukraine unter Bundesvermittlung [US-Vermittlung] erneut über eine mögliche Beendigung des Krieges.“; „Vor dem Dreiertreffen waren auch Vertreter Europas und der NATO beteiligt. Präsident Trump hatte zuletzt Hoffnungen auf ein baldiges Friedensabkommen.“; Hegseth (dve vety);
  - stratené: „Auch die Militärhilfe dürfte besprochen werden. Zuletzt hatten die USA ihre Unterstützung reduziert. Bei den Beratungen ist auch der ukrainische Außenminister anwesend.“ a väčšina vety „Hexeth wird vorgeworfen…“ (ostalo „Des Kongresses.“).
- **Porovnanie** (ten istý úsek videa): reproduktor dole (test 4) ≈ polovica reči stratená · slúchadlo pri uchu (4c) ≈ štvrtina · bez hlasu (4b) takmer nič. Slúchadlo pri uchu je výrazné zlepšenie, ale potlačenie ozveny stále berie časť reči počas hlasu.
- **Návrh funkcie (na rozhodnutie):** v Počúvaní voľba výstupu „Do ucha (horný reproduktor)“, ktorá v `startCapture` (`public/app.js:909`) zvolí vstup s menom obsahujúcim „earpiece“. Iba Android Chrome; na iPhone Safari to treba overiť zvlášť. Pred zavedením overiť, či sa po prepnutí späť na Reproduktor zvuk naozaj vráti dole (v pokuse s tónmi sa nevrátil v rámci tej istej stránky).

## Test 5 + 6: čísla, mená a slovo z iného jazyka (Reproduktor) — čísla OK, opravená chyba fronty

Relácia `c1902630…` (133 s), `end_code: finished`, latencia medián 294 ms, ale **p95 12 598 ms** (pozri nález L3).

| Povedané | Prepis | Preklad (a hlas) |
|---|---|---|
| dvadsaťtri eur a päťdesiat centov | „23 eur 50 centov“ | „23 Euro 50 Cent“ |
| štvrtého decembra o pol tretej popoludní | „4. decembra o pol 3 popoludní“ | „am 4. Dezember um halb 3 nachmittags“ |
| nula deväť nula päť, sto dvadsaťtri, štyristo päťdesiat šesť | „0905 123 456“ | „0905 123 456“ |
| Hlavnej ulici číslo sedemnásť v Banskej Bystrici | „Hlavnej ulici, číslo 70, 17“ (prvý pokus), „číslo 17“ (druhý) | „Hlavná-Straße, Hausnummer 17 in Banská Bystrica“ |
| DE „um 14 Uhr 35 von Gleis 7 ab“ | „14 Uhr, 35 Wohn-Gleis, 7 ab“ | „o 14 hodine, 35 obytný nástupište, 7 z“ ✘ |

- Čísla sa prepisujú číslicami a hlas ich podľa Františka číta väčšinou dobre („niektoré čísla boli v pohode“). Telefónne číslo hlas dostane ako „0905 123 456“; ako ho presne prečítal, sa z logu nedá zistiť.
- Nemecký čas a nástupište: „von“ rozpoznané ako „Wohn-“ a preklad je zlý. Vec rozpoznávania Sonioxu, nie appky.
- **Slovo z iného jazyka (A10 / úloha 5.3):**
  - „Včera som bol na Weihnachtsmarkt a kúpil som Glühwein.“ zostala **jedna bublina** (sk), preklad „Gestern war ich auf dem Weihnachtsmarkt und habe Glühwein gekauft.“ ✔
  - „Musím ešte vybaviť Anmeldung na úrade.“ sa rozdelila na **tri bubliny**: „Musím ešte vybaviť“ (sk → de „Ich muss noch erledigen“) · „Anmeldung“ (**de → sk „registráciu“, prečítané slovenským hlasom**) · „na úrade.“ (sk → de „bei der Behörde.“). Nemecký poslucháč počuje nemecký začiatok, slovenské slovo a nemecký koniec. Potvrdzuje A10: krátke cudzie slovo uprostred vety by sa malo prilepiť k vete okolo, nie otočiť smer prekladu. Na rozhodnutie v 5.3 treba zaznamenať surové tokeny Sonioxu (server ich zatiaľ nelogi).
- **Nález L3 (chyba, opravené):** po rozdelení vety na tri bubliny čakal hlas slova „Anmeldung“ **10 s** (11:27:53,8 → 11:28:03,2) a stav ostal „Prekladám“, kým František nezačal hovoriť ďalšiu vetu. Príčina: `speech-session.js` pri štarte hlasu nastavil `op.held`, lebo bublina „Anmeldung“ nikdy nedostala vlastný koniec vety (endpoint pripadol nasledujúcej bubline „na úrade.“). Uvoľnenie prichádzalo až s ďalšou rečou alebo po 15 s. **Oprava:** hlas sa podrží iba vtedy, keď je jeho bublina posledná v rozhovore (`stillSpoken`). Pridaný test `test/speaker-latency.test.js` („a voice queued behind another plays without waiting…“), pred opravou padal, po nej prechádza. `npm run check` OK, `npm test` 219/219.

## Test 7: výpadok spojenia (vytiahnutý USB kábel) — PREŠIEL s obmedzením

Relácie `3cedd24d…` (`end_code: client_closed`) a `cc6c478d…` (nový rozhovor po „Pokračovať“, `finished`).

- Simulácia: kábel vonku 11:53:55,1 – 11:54:05,9 (~11 s). Pozor, nie je to skutočný výpadok siete: `localhost` hneď vráti `ERR_CONNECTION_REFUSED` a `navigator.onLine` ostáva `true`, takže sa nespustí čakanie na udalosť `online`.
- Klient sa pokúsil 3× automaticky obnoviť spojenie (`/?resume=1`, odstup 1,5 s, 3 s, 6 s; `public/app.js:1030–1033`). Všetky tri pokusy padli ešte počas výpadku, posledný ~0,5 s pred zasunutím kábla. Potom appka zastala a ukázala „Pokračovať v rozhovore“; po ťuknutí nový rozhovor prešiel bez chyby (hlas 0,29 s). Prepis ostal zachovaný.
- Na telefóne sa po zasunutí kábla zobrazila voľba režimu USB; zmena režimu spôsobila druhý krátky výpadok (11:54:23). Iba vlastnosť testovacieho zapojenia.
- Konzola: „The AudioContext encountered an error from the audio device or the WebAudio renderer.“ po pripojení kábla (Android zrejme zmenil zvukovú trasu). Ďalší hlas však zaznel normálne, nahlas zo spodného reproduktora.
- **Návrh L4:** automatické obnovenie sa vzdá po ~10,5 s. Pri skutočnom telefóne (tunel, výťah, prechod Wi-Fi → dáta) je to krátko a používateľ musí ťukať. Kým je stránka viditeľná a rozhovor nezastavil používateľ, by mohlo skúšať ďalej pomalšie, napr. každých 10–15 s až 2 min. Neúspešný pokus nestojí Soniox nič. Skutočný výpadok siete (režim lietadlo, `online`/`offline`) treba overiť na iPhone po nasadení.

## Test 8: asistent počas hlasu — PREŠIEL

Relácia `96628312…` (~14 s). Počas hlasu František podržal bočné tlačidlo (Gemini). Gemini hlásil, že mikrofón používa iná aplikácia, a hlas sa dohral celý (`playback_done: played`). Skutočný prichádzajúci hovor sa netestoval; overiť na iPhone (Siri / hovor / budík, nález A3).

## Test 9a: Oproti sebe + Veľkosť textu Najväčšie — funguje, UX nález

Snímka obrazovky z telefónu (411 × 798 CSS px, na výšku): horná polovica otočená o 180° pre druhú osobu (nemčina), dolná pre Františka. Farebné bodky stavu sú na mieste.

- **Nález L5 (UX):** pri dlhšej vete a veľkosti Najväčšie (`.face-text` = `clamp(1.5rem, 6.5vw, 2.3rem) × 1.5` ≈ 55 px, `public/style.css:198`) sa do polovice zmestí iba ~⅓ textu. Horná polovica: viditeľných 247 px z 765 px, dolná 247 z 515. Zobrazí sa **začiatok** vety a zvyšok treba posúvať prstom. Druhá osoba by to musela robiť na otočenom texte. K tomu hlavička s jazykmi a prepínač Konverzácia/Počúvanie zaberajú ~25 % výšky aj v režime Oproti sebe.
  - Návrhy: v režime Oproti sebe skryť hlavičku a prepínač režimu; písmo v polovici zmenšovať podľa dĺžky textu (fit-to-box), aby sa celá posledná veta zmestila bez posúvania; Veľkosť textu brať ako hornú hranicu, nie pevnú veľkosť.

## Test 9b: Oproti sebe na šírku — CHYBA, opravené

- **Nález L6 (chyba):** na šírku má telefón iba 325 CSS px výšky (855 × 325). Hlavička s jazykmi, prepínač Konverzácia/Počúvanie, stav a ovládanie zabrali skoro všetko a **každá polovica mala 36 px**, takže text nebolo vidno vôbec (vidno iba nápisy „NEMČINA“ / „SLOVENČINA“). Polovice boli vedľa seba správne (`@media (orientation: landscape) and (max-height: 520px)`), ale bez miesta.
- **Oprava:** `public/app.js` v `controls()` pridá na `#appShell` triedu `face-on`, keď je zapnuté Oproti sebe (a nie Počúvanie). `public/style.css` v tej istej media query pri `.app.face-on` skryje `.topbar`, `.session-mode` a `.dock-status`. Tlačidlo Oproti sebe ostáva v spodnom ovládaní, takže sa dá vrátiť. Na výšku sa nič nemení.
- Overené na telefóne po vyčistení cache service workera: polovice majú **202 px** (predtým 36). Test v `test/listen-ui.test.js` („face-to-face marks the app shell…“). `npm run check` OK, `npm test` 220/220.
- Poznámka pre nasadenie: verzované súbory (`?v=3.6.0`) sú v service workeri nemenné. Táto oprava aj oprava L3 sa na zariadenia s už uloženou 3.6.0 nedostanú bez zvýšenia verzie. Pred nasadením zvýšiť na 3.6.1 alebo nechať 3.6.0, ak sa ešte nikde nenasadila (zatiaľ nie je nasadená).

- František k šírke: ikony v spodnom ovládaní (mikrofón ~100 px, bočné 64 px) sú na šírku zbytočne veľké. Návrh: v tej istej media query ich zmenšiť, aby text mal ešte viac miesta.

## Test 9c: stop počas dokončovania („Ukončiť hneď“) + nález v hlase

Relácie `c882c2f3…` (9a, 22 s) a `ea6339d6…` (9c, 28 s). Dlhá veta (~7 s reči), stop 3 s po začiatku hlasu. Dokončovanie trvalo 11,2 s (12:27:53,9 → 12:28:05,1).

- **„Ukončiť hneď“ sa podľa Františka neukázalo**, hoci dokončovanie trvalo dlhšie ako 8 s. Kód (`public/app.js:1060`, `:105`) vyzerá správne. Keď sa stav nastaví ručne cez DevTools, tlačidlo sa na telefóne ukáže (top 640 px z 798). Príčinu sa nepodarilo určiť z logov → zopakované so sledovaním stavu stránky (test 9c-2).
- **Nález L7 (chyba, opravené): dlhá veta v Reproduktore vždy prepadla z WebSocketu na REST.** V oboch reláciách prišlo `tts_fallback` presne 3,0 s po prvom kúsku prekladu (12:19:49,55 → 52,55; 12:27:40,48 → 43,52). Hlas pripravený vopred posiela preklad do TTS po kúskoch počas reči. Soniox pri neúplnej vete čaká na ďalší text a nepošle zvuk, takže vypršal limit „prvý zvuk do 3 s“ (`tts-transport.js`, `firstAudioMs`). Dôsledky:
  - REST dostane celý text znova (znaky sa môžu účtovať dvakrát, `speech-session.js` to konzervatívne rezervuje);
  - po 2 takých zlyhaniach sa na 60 s vypne WebSocket TTS pre celý rozhovor (`restUntil`);
  - klient dostal `tts_stream_start` dvakrát s tým istým `playback_id` (držaný štart z WebSocketu a štart z RESTu).
  
  Pri krátkych vetách (testy 1–8) sa to nestalo, lebo veta skončila do 3 s.
  **Oprava:** počas posielania kúskov sa limit prvého zvuku (a po začiatku zvuku limit zaseknutia) počíta od posledného odoslaného kúsku textu, nie od začiatku. Test v `test/tts-transport.test.js` („first audio deadline waits while a long sentence is still being streamed in parts“): pred opravou padal na `Audio timeout`, po nej prechádza. `npm test` 221/221. Dvojitý `tts_stream_start` pri prechode na REST ostáva ako drobnosť (klient ho zvládol).

### Test 9c-2: zopakované so sledovaním stavu stránky — PREŠIEL

Relácia `027a201c…` (~27 s), server už s opravou L7. Stav stránky sa čítal cez DevTools každých 200 ms.

- Stop 12:33:35,7 → po 8,0 s (12:33:43,7) `finishSlow: true` a tlačidlo „Ukončiť hneď“ viditeľné → František naň ťukol 12:33:47,7 → hlas hneď stíchol a rozhovor sa ukončil. Funguje.
- Prvý neúspech sa nepodarilo zopakovať. Najpravdepodobnejšie bolo tlačidlo viditeľné iba ~3 s pred koncom hlasu a prehliadlo sa. Súvis s prechodom na REST (L7) sa nedá vylúčiť.
- **`tts_fallback` sa už neobjavil** (dlhá veta, rovnaký text) → oprava L7 overená so skutočným Sonioxom.
- František: najprv videl ikonu stlmenia hlasu (vpravo dole) a až neskôr „Ukončiť hneď“. Návrh: počas dokončovania dať „Ukončiť hneď“ výraznejšie (nie ghost) a prípadne skôr ako po 8 s, keď sa už iba dohráva hlas.

## Test 10: ladenie konca vety (`ENDPOINT_*`, úloha 4.2)

Metrika „slová ustálené → koniec vety“: čas od chvíle, keď sa slová v prepise prestali meniť (bez interpunkcie), po finálny token. Hrubý odhad oneskorenia konca vety, vrátane oneskorenia rozpoznávania. „Koniec vety → hlas“ je čas od finálneho tokenu po `playback_started` na telefóne.

### Beh A: `ENDPOINT_DELAY_MS=1000`, `ENDPOINT_LATENCY_LEVEL=2`, `ENDPOINT_SENSITIVITY=0.3`

Relácia `30545577…` (48 s), Reproduktor. Server overil nastavenie cez `/api/diagnostics`.

| Veta (čo František povedal) | Prepis | Ustálené → koniec | Koniec → hlas |
|---|---|---|---|
| Dobrý deň, chcel by som si objednať kávu s mliekom. | celé | 1 616 ms | 234 ms |
| Koľko stojí lístok do Viedne? | celé | 908 ms | 272 ms |
| Chcel by som… [pauza] …dve kávy a jeden koláč. | „Chcel by som 2 kávy.“ · „A 1.“ — **rozdelené, „koláč“ chýba** | 1 649 ms | 250 ms |
| Moja adresa je… [pauza] …Hlavná ulica dvanásť. (2×) | „Moja adresa je Hlavná ulica.“ — **„dvanásť“ chýba v oboch pokusoch** | 1 980 / 1 998 ms | 298 / 275 ms |
| Wo ist der Bahnhof, bitte? | celé | 901 ms | 220 ms |

- Medián „ustálené → koniec“: **~1 630 ms** (6 viet). Predvolené nastavenie 1500/0/0 z testov 1 a 5: **~1 700 ms** (12 viet, rozptyl 640–2 700 ms). Zrýchlenie je malé a v rozptyle merania.
- **Pauza po „Chcel by som…“ a „Moja adresa je…“ vetu nerozdelila.** Rozdelilo ju však skoršie ukončenie na krátkom zaváhaní pred číslom alebo spojkou („2 kávy | a jeden“, „Hlavná ulica | dvanásť“).
- **V Reproduktore je predčasný koniec vety drahý:** hneď začne hlas, mikrofón sa stlmí a koniec vety sa stratí („koláč“, „dvanásť“). S predvoleným nastavením sa v testoch 1–6 nič také nestalo; pri dlhých číslach (test 5) sa slová nestratili.
- Záver behu A: agresívne nastavenie **neodporúčam pre Reproduktor**. Zisk ~0,1 s nestojí za stratené slová.

### Beh B: `ENDPOINT_DELAY_MS=1500`, `ENDPOINT_LATENCY_LEVEL=2`, `ENDPOINT_SENSITIVITY=0`

Relácia `b1a92ae5…` (35 s), rovnaké vety aj pauzy.

| Veta | Prepis | Ustálené → koniec | Koniec → hlas |
|---|---|---|---|
| Dobrý deň, chcel by som si objednať kávu s mliekom. | celé | 1 780 ms | 318 ms |
| Koľko stojí lístok do Viedne? | celé | 907 ms | 278 ms |
| Chcel by som… [pauza] …dve kávy a jeden koláč. | „Chcel by som 2 kávy a 1 koláč.“ ✔ | 2 125 ms | 268 ms |
| Moja adresa je… [pauza] …Hlavná ulica dvanásť. | „Moja adresa je Hlavná ulica 12.“ ✔ | 2 825 ms | 284 ms |
| Wo ist der Bahnhof, bitte? | celé | 1 024 ms | 281 ms |

- Nič sa nerozdelilo a nič sa nestratilo. Medián ~1 780 ms, teda rovnako ako predvolené nastavenie, žiadne merateľné zrýchlenie.

### Odporúčanie `ENDPOINT_*`

- **Ponechať predvolené `ENDPOINT_DELAY_MS=1500`, `ENDPOINT_LATENCY_LEVEL=0`, `ENDPOINT_SENSITIVITY=0`.** `LEVEL=2` ani neuškodil, ani nepomohol. `DELAY=1000` so `SENSITIVITY=0.3` v Reproduktore strácal slová.
- Ak sa niekedy bude skracovať, tak iba pre Slúchadlá alebo Počúvanie (mikrofón sa tam nestlmuje, predčasný koniec vety nestojí slová). Pre Počúvanie by naopak mohol pomôcť dlhší koniec vety (úlomky v teste 4).
- Vzorka je malá (6 + 5 viet, jeden hovoriaci). Pre istotu zopakovať na produkcii s logmi `session_end` (úloha 4.1).

## Na overenie na iPhone po nasadení

> **Nie je v pláne.** František appku používa iba na Androide a iPhone na testovanie nemá (rozhodnutie 12. 11. 2026). Zoznam ostáva len pre prípad, že by sa to zmenilo. Body 1, 3, 4, 5 a 8 sa dajú overiť aj na Androide po nasadení.

1. Siri, budík a prichádzajúci hovor počas hlasu: hlas pokračuje sám alebo po ťuknutí (A3).
2. Zamknutá obrazovka v Počúvaní: upozornenie (A12).
3. Skutočný výpadok siete (režim lietadlo, prechod Wi-Fi → dáta): čakanie na `online` a obnova `?resume=1`.
4. Odhlásenie počas rozhovoru: prepis ostane a vráti sa iba tomu istému účtu (A1).
5. Nasadenie novej verzie s otvorenou appkou: `client_outdated`, uloženie prepisu, reload (A7).
6. Oproti sebe na šírku na iPhone (oprava L6) a Veľkosť textu Najväčšie.
7. Počúvanie s hlasom z reproduktora: či iOS potláča okolitú reč podobne ako Android (L2). Či Safari dovolí hlas do slúchadla pri uchu (pokus 4c).
8. Pridanie odtlačku s heslom a prihlásenie odtlačkom na novom zariadení.
9. Dlhá veta v Reproduktore: v logu nesmie byť `tts_fallback` (oprava L7).

## Návrhy (neopravené, na rozhodnutie)

| # | Čo | Kde |
|---|---|---|
| L1 | Logovať kód chyby STT spojenia (`err.code`) do `provider_error` | `speech-session.js:307` |
| L2 | Počúvanie + hlas z reproduktora stráca reč → nápoveda „použi slúchadlá“, prípadne voľba „Hlas do ucha“ (4c) | `public/app.js:909` (`startCapture`) |
| L4 | Automatická obnova spojenia skúšať dlhšie (do ~2 min), nie iba ~10 s | `public/app.js:1030–1033` |
| L5 | Oproti sebe: písmo prispôsobiť dĺžke textu, skryť hlavičku aj na výšku | `public/style.css:198` |
| — | Oproti sebe na šírku: menšie tlačidlá dole | `public/style.css` (media query landscape) |
| — | PTT: nové stlačenie zruší hlas predchádzajúcej krátkej vety | `public/app.js:1170` |
| — | Slúchadlá: prerušenie vlastnou rečou nedohrá zvyšok predchádzajúceho prekladu | `public/app.js:903` |
| — | „Ukončiť hneď“ výraznejšie (nie ghost) | `public/index.html:106` |
| A10 / 5.3 | Krátke cudzie slovo vo vete otočí smer prekladu a vytvorí bublinu; treba logovať surové tokeny Sonioxu | `speech-session.js` (`tokens`) |
| — | Dvojitý `tts_stream_start` pri prechode WebSocket → REST | `speech-session.js` (`begin`) |
| — | Pred nasadením zvýšiť verziu (verzované súbory sú v SW nemenné) | `package.json`, `public/sw.js` |

## Testovacie nástroje (iba lokálne, mimo repozitára)

- Server spúšťaný cez dočasnú konfiguráciu `real-server-test` v `.claude/launch.json` hlavného priečinka (po teste vrátená) a spúšťač s `NODE_EXTRA_CA_CERTS`.
- Konzola a WebSocket správy telefónu cez Chrome DevTools Protocol (`adb forward tcp:9222`). Sledovala sa iba karta `localhost:3000`.
- Snímky obrazovky telefónu cez `Page.captureScreenshot`.

## Minúty Sonioxu

| Blok | Skutočná dĺžka rozhovoru | Spolu |
|---|---|---|
| Test 1 | 36 s + 63 s | ~1,7 min |
| Test 2 | 21 s | ~2,0 min |
| Test 3 | 62 s | ~3,0 min |
| Test 4 | 65 s | ~4,1 min |
| Test 5 + 6 | 133 s | ~6,3 min |
| Test 4b | 69 s | ~7,4 min |
| Test 4c | 76 s | ~8,7 min |
| Test 7 | 7 s + 5 s | ~8,9 min |
| Test 8 | 14 s | ~9,2 min |
| Test 9a, 9c | 22 s + 28 s | ~10,0 min |
| Test 9c-2 | 27 s | ~10,5 min |
| Test 10 A | 48 s | ~11,3 min |
| Test 10 B | 35 s | **~11,9 min** |

Súčet je skutočná dĺžka rozhovorov podľa `duration_ms`. Server si rezervuje po 10 s, preto je jeho `stt_seconds` vyšší. Neúspešné pokusy pri chybe s Kasperským sa k Sonioxu nedostali. Presnú sumu treba overiť v Soniox konzole pri testovacom kľúči.
