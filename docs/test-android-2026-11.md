# Zadanie: lokálny test so skutočným Sonioxom na Android telefóne

Pre nový chat (Claude Opus 5.5, effort high). Komunikuj s Františkom po slovensky, jednoducho, krok za krokom.

## Kontext (neobjavuj znova)

- Pracovný priečinok: `D:\Codex\projects\soniox-prekladac\.claude\worktrees\v6-quick-wins`, vetva `fix/v6-and-quick-wins`, verzia 3.6.0. Všetky zmeny sú **necommitnuté**.
- Najprv si prečítaj `AGENTS.md`. Potom `docs/implementacia-2026-11.md`: čo sa zmenilo a čo overiť.
- Audit, z ktorého zmeny vychádzajú, je v `D:\Codex\projects\soniox-prekladac\docs\audit-2026-11-fable.md`. Prečítaj iba časti, ktoré potrebuješ.
- Stav: `npm run check` je OK a 218 testov prechádza. Mock aplikácia bola prezretá. **Skutočný Soniox a telefón ešte neboli skúšané.**
- Na notebooku je Node 22.14. Projekt chce Node 24, ale testy aj appka na 22 bežia (iba varovanie k `node:sqlite`).

## Cieľ

Overiť verziu 3.6.0 so skutočným Sonioxom na Android telefóne pripojenom k notebooku cez USB. **Produkcia na Fly sa nemení.** Zistené problémy zapísať, aby sa dali neskôr skontrolovať a opraviť.

## Pravidlá

- Nič nenasadzuj, nič necommituj, nemeň Fly secrets.
- **Rozpočet Sonioxu: najviac ~15 minút rozhovoru spolu** (rádovo desiatky centov). Po každom bloku testov povedz, koľko minút sa minulo; čísla sú v logu `session_end`.
- **`.env`:**
  - Nikdy ho nečítaj ani nevypisuj.
  - Podľa `D:\Codex\AGENTS.md` ho nevytváraj ty; vytvorí ho František.
  - Ty mu povieš presne, čo doň dať. Hodnotu `SONIOX_API_KEY` vloží sám.
  - Odporuč mu vytvoriť v Soniox konzole **samostatný testovací kľúč**, ktorý po teste zmaže.
- Inštalácia: František súhlasil s Android platform-tools (`winget install Google.PlatformTools`). Nič iné bez opýtania neinštaluj.

## Postup

### 1. Príprava (s Františkom)

1. Nainštalovať `adb` a overiť `adb version`.
2. Na telefóne zapnúť Možnosti pre vývojárov a Ladenie cez USB. Postup vysvetli jednoducho; líši sa podľa výrobcu, tak sa opýtaj na model.
3. Pripojiť kábel, potvrdiť na telefóne a overiť `adb devices`.
4. `.env` v pracovnom priečinku vytvorí František skopírovaním `.env.example`. Povedz mu, čo nastaviť:
   - `SONIOX_API_KEY` = jeho testovací kľúč;
   - `SESSION_SECRET` = náhodný reťazec (daj mu príkaz, ktorý ho vygeneruje);
   - `APP_ACCESS_CODES=tester:<heslo s aspoň 16 znakmi>` a `APP_OWNER_USERNAME=tester`;
   - `APP_ORIGINS=http://localhost:3000` a `PORT=3000`;
   - `LOG_EVENTS=true`; ostatné môžu zostať z príkladu.
5. Spustiť server cez preview (konfigurácia v `.claude/launch.json` v **hlavnom** priečinku sa načítava odtiaľ). Ak nejde, opýtaj sa, ako ho spustiť; nespúšťaj server cez Bash. Pozor: `.claude/launch.json` v hlavnom priečinku nemeň natrvalo.
6. `adb reverse tcp:3000 tcp:3000`. Na telefóne otvoriť v Chrome `http://localhost:3000`; mikrofón funguje, lebo `localhost` je bezpečný kontext.
7. Ladenie stránky v telefóne:
   - `adb forward tcp:9222 localabstract:chrome_devtools_remote`;
   - potom Chrome DevTools Protocol na `http://localhost:9222/json`: konzola, sieť, kliknutia.
   - Ak to nepôjde, stačia logy servera a Františkove popisy.

### 2. Testy (František hovorí, ty sleduješ logy a stránku)

Po každom bode zapíš výsledok: prepis, preklad, či zaznel hlas a za koľko, chyby z konzoly a servera, a riadok `session_end` (latencia, `end_code`, `provider_error`).

1. Prihlásenie, prvý rozhovor SK→DE a DE→SK v režime **Reproduktor**. Overiť, že hlas začne hneď po konci vety (hlas pripravený vopred) a mikrofón nie je stlmený, kým osoba hovorí.
2. **Slúchadlá** (ak má): priebežný hlas.
3. **PTT (Podržať)**: rýchle pustenie a nové stlačenie.
4. **Počúvanie**: titulky aj hlas.
5. Čísla, mená, ceny a dátumy: model v6 ich píše inak. Ako to prečíta hlas?
6. Veta so slovom v inom jazyku (napr. slovenská veta s nemeckým slovom). Zaznamenať, ako sa rozdelili bubliny (nález A10 / úloha 5.3).
7. Výpadok: vypnúť Wi-Fi / dáta na pár sekúnd počas rozhovoru a znova zapnúť.
8. Prerušenie: zavolať na telefón alebo spustiť asistenta počas hlasu.
9. „Oproti sebe“, Veľkosť textu Najväčšie, stop počas dokončovania („Ukončiť hneď“).
10. Ak zostane rozpočet, 2–3 krátke behy s iným nastavením konca vety. Napríklad `ENDPOINT_LATENCY_LEVEL=2`, `ENDPOINT_SENSITIVITY=0.3` a `ENDPOINT_DELAY_MS` 1000 oproti 1500 (úloha 4.2). Porovnať latenciu a počet predčasne rozdelených viet. Nastavenie mení František v `.env`, potom treba reštartovať server.

### 3. Výstup

- Súbor `docs/test-android-2026-11-vysledky.md` v pracovnom priečinku:
  - čo prešlo a čo nie,
  - namerané latencie (medián, najhorší prípad),
  - minúty Sonioxu,
  - nájdené chyby so `súbor:riadok`, ak sa dajú dohľadať, a návrhom opravy,
  - odporúčané hodnoty `ENDPOINT_*`,
  - zoznam vecí, ktoré treba ešte overiť na iPhone po nasadení.
- Jasné, malé chyby môžeš opraviť hneď. Ku každej oprave pridaj test a spusti `npm run check` a `npm test`. Väčšie veci iba zapíš.
- Na konci Františkovi pripomeň:
  - zastaviť server a vypnúť `adb reverse`;
  - zmazať testovací kľúč v Soniox konzole;
  - `.env` v pracovnom priečinku nechať alebo zmazať podľa toho, či ešte bude testovať.
