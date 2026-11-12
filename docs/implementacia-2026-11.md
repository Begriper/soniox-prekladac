# Implementácia auditu — balíky 1 až 6 (verzia 3.6.0)

Dátum: 12. 11. 2026 · Implementoval: Claude Opus 5.5 (Balík 1 Sonnet 5.5) · Druhý pohľad: Codex `gpt-6.1-sol` · Podklad: `docs/audit-2026-11-fable.md` (v hlavnom priečinku repozitára, necommitnutý)

## Kde to je

- Pracovný strom: `D:\Codex\projects\soniox-prekladac\.claude\worktrees\v6-quick-wins`, vetva `fix/v6-and-quick-wins`, založená z `main` (v3.5.0).
- **Nič nie je commitnuté ani nasadené.** Celá zmena: `git diff main` v tomto priečinku plus nové súbory (`git status`).
- Rozsah: 27 upravených súborov (+747 / −231 riadkov bez `package-lock.json`), 6 nových súborov: `backup-db.js` a päť testových súborov.
- Overenie: `npm run check` OK; `npm test` 218 testov; `npm audit --omit=dev` 0 nálezov. Mock aplikácia prezretá pri 375 px a 320 px.

**Neoverené:** skutočný Soniox, fyzický iPhone / Android, čítačka obrazovky.

Občasné zlyhanie staršieho testu (`security-usage.test.js`) bolo upratovanie dočasného priečinka na Windows (`ENOTEMPTY` pri záťaži). Test teraz pri mazaní skúša znova; 8 súbežných behov prešlo.

## Čo je hotové, podľa balíkov

ID v zátvorkách odkazujú na nálezy v audite.

### Balík 1 — termín a rýchle výhry

1. Model `stt-rt-v6` (B1).
2. Limit hlasu počíta vyslovené vety, nie streamy, a predvolene ich je 300; po vyčerpaní sa hláška ukáže raz (A2).
3. Počúvanie si drží posledných 400 viet / 30 000 znakov namiesto zastavenia (A4).
4. Zdieľané a vlastné hlasy majú oddelenú platnosť; výpadok neodstráni klon (A9, X6).
5. Jeden JSON riadok do logu na koniec rozhovoru (A14).
6. express 4.22.3, ws 8.22.2, `qs` ^6.17.1 (D9).

### Balík 2 — odolnosť klienta (`public/app.js`, `public/sw.js`, `server.js`)

1. **Prepis pri odhlásení (A1).** Pri vypršaní alebo zrušení prihlásenia zostane prepis zachovaný a uloží sa do zariadenia. Vráti sa iba tomu istému účtu, iný účet ho nikdy neuvidí.
2. **Obnova zvuku (A3).** Pozastavený prehrávací zvuk (iOS: hovor, Siri, zmena výstupu) sa sám obnoví, alebo sa obnoví pri najbližšom ťuknutí. Hlas sa už neruší. Server dostane `playback_started` až keď zvuk naozaj hrá a dovtedy čaká dlhšie.
3. **Stop (A6, X1).** Stop sa nedá vrátiť neskorou správou zo servera. Starý časovač neukončí ďalší rozhovor. `stopCapture` uvoľní iba vlastné zdroje. Rámce z workletu sa počas dokončovania odošlú.
4. **Dôvod odmietnutia (A8).** Server namiesto holého HTTP 409/429 pošle čitateľnú chybu: `busy_elsewhere`, `server_busy`, `preview_running`. Pred automatickým opätovným pripojením klient overí prihlásenie.
5. **Aktualizácie (A7, X7).** Verzia 3.6.0 a klient posiela `client_version`. Klient inej verzie dostane `client_outdated`: uloží prepis a stránku načíta znova; ak sa uložiť nedá, stránku nenačíta. Po výmene service workera sa stránka načíta znova iba vtedy, keď sa nič nestratí. Starý service worker si neuloží HTML novej verzie.
6. **Drobnosti (A15, X8):**
   - PTT stlačenie počas uvoľňovania sa zaradí aj s rečou, ktorá medzitým zaznela.
   - Strata mikrofónu dokončí poslednú vetu.
   - Udalosť `online` nespustí rozhovor, ktorý zastavil používateľ.
   - Náhrada za `AbortSignal.any` (iOS < 17.4).
   - Tiché prihlásenie odtlačkom neukazuje falošnú chybu.
   - Rýchlosť hlasu je súčasťou kľúča cache aj opakovania.
7. **Zámok obrazovky (A12).** Upozornenie v Počúvaní, keď ho telefón nedokáže udržať.
8. **Prihlásenie (X4, X5).** Appka sa ukáže až po načítaní jazykov a hlasov. Tlačidlo odtlačku je dostupné vždy, keď ho zariadenie podporuje; hlavné je iba na zariadení, kde sa pridalo. Surové „Failed to fetch“ nahradila slovenská hláška.

### Balík 3 — bezpečnosť a prevádzka

1. **Limity prihlásenia (D1, D2).**
   - Globálny limit (200 / 10 min) a limit na účet (10 / 10 min) počítajú iba neúspešné pokusy.
   - Núdzový kód vlastníka sa nedá zablokovať.
   - Prihlásenie iba kódom má jeden spoločný malý limit. Nezrušil som ho, čaká na tvoju odpoveď (otázka 2 v audite).
2. **Pridanie odtlačku (D3).** Treba znova zadať heslo; počítajú sa iba nesprávne heslá. Načítanie výzvy na prihlásenie odtlačkom má vlastný voľnejší limit (D8).
3. **Logy (D4).** `login_failed`, `login_limited`, `passkey_confirm_failed`, `request_error`, `shutdown_error`, `unhandled_rejection`. Meno ani IP v nich nie sú čitateľné, iba krátky kľúčovaný hash.
4. **Stropy a kvóty (D5, D6, X3 z Codexu).**
   - Predvolený mesačný strop 30 h rozpoznávania na účet.
   - Strop pre celú domácnosť: 10 h rozpoznávania a 600 000 znakov hlasu denne.
   - Opakovanie a ukážka hlasu skontrolujú kvótu zvuku **pred** zaplatením; zaplatený zvuk sa vždy zapíše.
   - Nový rozhovor sa počíta do denného limitu; pokračovaním je iba automatické opätovné pripojenie (`/?resume=1`).
5. **Zápis do databázy (B5).** Bajty z mikrofónu sa rezervujú po 64 KB a nie pri každom rámci; zvyšok sa zapíše na konci. Pridané `PRAGMA synchronous=NORMAL`.
6. **Prevádzka a zálohy (D7).**
   - Chybné JSON dostane 400, príliš veľká požiadavka 413 (predtým 503).
   - Pri SIGTERM server pošle telefónom `server_restart` (klient sa pripojí znova) a skončí aj vtedy, keď zatváranie zlyhá.
   - `fly.toml`: `kill_timeout = 30`.
   - `backup-db.js` (`VACUUM INTO`, posledných 7 kópií) a postup v `deployment.md`.

### Balík 4 — rýchlosť hlasu

1. **Hlas pripravený vopred v Reproduktore (B2 krok 3, 4.4).** Preklad sa posiela do TTS už počas reči. Zvuk server podrží a pustí hneď po konci vety alebo po zastavení. Mikrofón ostáva otvorený a stav ukazuje „Prekladám“, kým hlas nezačne naozaj hrať.
2. **Plynulejšie prehrávanie (B3).** Pri štarte a po výpadku má prehrávanie rezervu 120 ms.
3. **Rýchlejší štart (B4).** WebSocket sa otvára súbežne so žiadosťou o mikrofón; zásobník pred spojením má 5 s. Ak rozhovor skončí počas nastavovania mikrofónu, uvoľní sa.
4. **Prewarm v Reproduktore (4.3)** sa samostatne nerobí: pri príprave hlasu vopred nemá zmysel.

### Balík 5 — odolnosť servera

1. **Obnova rozpoznávania (A5).** Výpadok alebo chyba 408/429/5xx otvorí iba nové spojenie so Sonioxom v tom istom rozhovore, najviac 2× za minútu. Prepis, fronta aj práve hrajúci hlas pokračujú; prerušená veta sa dokončí z finálneho textu.
2. **Odmietnutý handshake (A15).** Ak Soniox odmietne spojenie už pri pripájaní (napr. 402 bez kreditu), je to konečná chyba, nie nekonečné pripájanie.
3. **Reproduktor (A11).** Pred stlmením mikrofónu sa finalizuje to, čo druhá osoba už začala hovoriť.
4. **PTT (A15).** Rýchle druhé pustenie sa finalizuje o chvíľu neskôr namiesto nikdy.
5. **Nápoveda jazyka (B6).** „Rozpoznať jazyk“ posiela nápovedu vlastného jazyka.
6. **Lokálne opakovanie (X2).** Nikdy sa neprekryje so serverovým hlasom.
7. **Prechod na REST (A15).**
   - Znaky sa pri prechode z WebSocketu na REST už neúčtujú dvakrát.
   - REST TTS má 15 s na začiatok a medzi kúskami zvuku a najviac 2 min spolu (predtým 15 s spolu).
8. **Dlhý rozhovor (A13).** Konverzácia aj Počúvanie po 30-minútovom limite plynulo pokračujú v novej relácii.

### Balík 6 — UX a prístupnosť

1. **Stavy a hlášky:**
   - Lišta „Si offline“ je súčasťou appky (neposúva mikrofón pod okraj, overené pri 375 px) a má pravdivý text (C1).
   - Chyby sú viditeľné aj pri otvorenom paneli (C2).
   - Admin panely s jednorazovým heslom sa nezatvoria ťuknutím vedľa (C3).
   - Hlášky k mikrofónu podľa príčiny, s postupom pre iPhone a Android (C5).
   - Limity hovoria, kedy sa obnovia (C5).
   - Pri prepnutí režimu chyba zmizne (C5).
   - Po 8 s dokončovania sa objaví „Ukončiť hneď“ (C6).
   - Tlačidlo „Pokračovať“ sa ukáže aj pri prázdnom prepise a má text podľa režimu.
2. **Čitateľnosť:**
   - Preklad má predvolene 24 px a nastavenie Veľkosť textu ponúka 1×, 1,25× a 1,5× (C4).
   - Pomocný text má kontrast aspoň 4,5 : 1, sivý text v políčkach je výraznejší (C4).
   - Dotykové plochy majú aspoň 44 px (C9).
   - Pri tlačidlách sa už nedá dvojitým ťuknutím priblížiť.
3. **Oproti sebe (C7):** dlhý text sa neoreže, ale posúva sa. Každá polovica má farebné svetielko stavu, ktoré pochopí aj druhá osoba: zelené počúva, oranžové prekladá, modré hovorí. Na šírku sú polovice vedľa seba.
4. **Čítačka obrazovky (C8):** hlási iba dokončené preklady, každý raz a v správnom jazyku. Tlačidlá jazykov majú v názve jazyk; stav v spodnej lište už nehlási každú zmenu.
5. **Posúvanie (C10):** prepis neskáče na koniec, keď používateľ číta staršie vety, a ponúkne „↓ Najnovšie“.
6. **Prvé spustenie (C11):** na iPhone sa raz ukáže tip „Pridať na plochu“.

## Codex revízie

**1. revízia (balíky 1 a 2) — 7 nálezov, všetky opravené a pokryté testom:**
1. Reload mohol zahodiť prepis, ktorý sa nepodarilo uložiť.
2. Stará kontrola prihlásenia mohla znova spustiť zastavený rozhovor.
3. Strata mikrofónu odsekla poslednú vetu po 1,5 s.
4. Pozastavený zvuk na serveri vypršal.
5. Klonovaný hlas sa odmietol pred obnovou zoznamu.
6. Reč počas zaradeného PTT stlačenia sa zahodila.
7. Kľúč cache mal nesprávnu rýchlosť.

**2. revízia (balíky 3 až 6) — 7 nálezov, všetky opravené a pokryté testom:**
1. Hlas pripravený vopred mohol zablokovať frontu, keď druhá osoba začala hovoriť pred koncom vety. Teraz sa uvoľní pri zmene vety a najneskôr po 15 s.
2. Pri zamietnutej rezervácii sa stratili už odoslané bajty z mikrofónu. Teraz sa zapíšu na konci relácie.
3. Súbežné nesprávne heslá mohli obísť limit. Pokus sa teraz započíta pred overením hesla a pri úspechu sa vráti; to isté platí pre potvrdenie odtlačku.
4. Pri prechode na REST sa znaky rezervovali menej, než sa poslalo. REST teraz rezervuje celý text, rovnako konzervatívne ako inde.
5. Viac rýchlych PTT pustení poslalo `finalize` naraz. Teraz je najviac jeden časovač a odstup sa overí aj pri jeho spustení.
6. `playback_started` sa potvrdil aj vtedy, keď sa zvuk prerušil počas 120 ms rezervy. Teraz sa potvrdí, až keď zvuk znova beží.
7. Po vymazaní rozhovoru alebo odhlásení ostal posledný preklad v oblasti pre čítačku obrazovky. Teraz sa vymaže.

## Čo zostalo nespravené a prečo

- **4.1 a 4.2 — meranie latencie a ladenie konca vety.** Potrebujú logy z produkcie a krátky platený test so Sonioxom. Predvolené hodnoty `ENDPOINT_*` som nemenil.
- **5.3 — jazykový preskok v jednej vete.** Najprv treba zaznamenať skutočné tokeny zo Sonioxu (platené, so súhlasom).
- **Zrušenie prihlásenia iba kódom.** Čaká na tvoju odpoveď; zatiaľ má iba spoločný limit.
- **Ostatné:**
  - Panel potvrdenia jazyka nie je otočený v režime „oproti sebe“.
  - Natívne `confirm()` okná ostali.
  - Vlastné heslo si používateľ stále nevie zmeniť sám.
  - Šifrovanie záloh je iba odporúčanie v návode.

## Na čo sa pri kontrole zamerať

1. **Hlas pripravený vopred** (`speech-session.js`: `op.held`, `releaseHeld`, `armPlaybackTimer`, `pump`). Je to najväčší zásah do jadra fronty hlasu.
2. **Obnova rozpoznávania v relácii** (`recoverStt`) a jej súhra s držaným hlasom.
3. **Odhlásenie a súkromie prepisu** (`signOut`, `showApp`, `keptFor`).
4. **Zmena počítania rozhovorov** (`?resume=1`). Klient 3.5.0 bez tohto príznaku sa po nasadení pri každom pripojení počíta ako nový rozhovor; limit je 20 denne.

## Ručný test na telefóne pred nasadením

1. Krátky skutočný rozhovor SK↔DE na `stt-rt-v6`: Reproduktor aj Slúchadlá, PTT, Počúvanie.
2. iPhone: Siri alebo budík počas hlasu (hlas pokračuje po ťuknutí), zamknutie obrazovky v Počúvaní (upozornenie), odhlásenie počas rozhovoru (prepis zostane).
3. Výpadok siete počas rozhovoru a návrat; nasadenie novej verzie s otvorenou appkou.
4. Pridanie odtlačku s heslom; prihlásenie odtlačkom na novom zariadení.
5. Režim „oproti sebe“ s dlhou vetou a na šírku; Veľkosť textu Najväčšie.

## Otvorené

- Pred nasadením zvýšiť verziu v `deployment.md` a urobiť zálohu databázy podľa nového postupu.
