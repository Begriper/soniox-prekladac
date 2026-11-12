# Zadanie: záverečná kontrola verzie 3.6.0 (Fable 5.2 + Codex)

Pre novú session: model **Fable 5.2**, effort **high**. Pracovný priečinok: `D:\Codex\projects\soniox-prekladac\.claude\worktrees\v6-quick-wins` (vetva `fix/v6-and-quick-wins`). Komunikuj s Františkom po slovensky a jednoducho.

## Cieľ

Rozhodnúť, či je verzia 3.6.0 pripravená na nasadenie na Fly a reálne použiteľná na Androide. Konkrétne:

1. Sú zmeny z auditu urobené správne a bez nových chýb?
2. Sú správne tri opravy, ktoré vznikli počas testu na telefóne?
3. Používa appka všade `stt-rt-v6` a `tts-rt-v2` a nezostal nikde `v5`?

Na konci jasne povedz **áno / nie / áno po týchto opravách**.

## Čo si prečítať (v tomto poradí, iba potrebné časti)

1. `AGENTS.md`: pravidlá projektu a spolupráca s Codexom.
2. `D:\Codex\projects\soniox-prekladac\docs\audit-2026-11-fable.md`: tvoj pôvodný audit. Je v hlavnom priečinku, necommitnutý.
3. `docs/implementacia-2026-11.md`: čo sa z auditu urobilo (balíky 1–6) a čo nie.
4. `docs/test-android-2026-11-vysledky.md`: výsledky skutočného testu so Sonioxom na Samsungu S24 Ultra. Hore je zhrnutie, nálezy L1–L7 a tabuľka návrhov.

Zmeny: `git diff main` plus necommitnuté nové súbory (`git status`). **Nič nie je commitnuté.**

## Postup

1. **Overenie:** spusti `npm run check` a `npm test` (očakávané 221/221). Na notebooku je Node 22.14, projekt chce 24; varovanie k `node:sqlite` je v poriadku.
2. **Vlastná revízia diffu** proti `main`. Zameraj sa na:
   - fronta hlasu a hlas pripravený vopred: `speech-session.js` (`op.held`, `stillSpoken`, `releaseHeld`, `pump`) — oprava L3;
   - limity TTS pri posielaní po kúskoch: `tts-transport.js` (`parts`, `waitTimer`) — oprava L7;
   - obnova STT v relácii (`recoverStt`);
   - odhlásenie a súkromie prepisu (`public/app.js`: `signOut`, `showApp`);
   - počítanie rozhovorov `?resume=1`;
   - Oproti sebe na šírku: `face-on`, oprava L6.
3. **Codex ako druhý model** (`gpt-6.1-sol`, effort high). Iba čítanie, nič nezapisuje:
   - `node "C:\Users\feros\.claude\plugins\cache\openai-codex\codex\1.0.2\scripts\codex-companion.mjs" review --wait --base main`
   - pri takom veľkom diffe aj `adversarial-review`.
   - Nálezy Codexu over v kóde a testoch, nepreberaj ich naslepo.
4. **Návrhy z testu** (tabuľka „Návrhy“ vo výsledkoch): ku každému krátko odporuč „urobiť pred nasadením“, „neskôr“ alebo „nerobiť“. Najdôležitejší je L2: Počúvanie s hlasom z reproduktora stráca reč; voľba „Hlas do ucha“ to zlepšila.
5. **Malé jasné chyby** môžeš opraviť hneď. Ku každej pridaj test a spusti `npm run check` a `npm test`. Väčšie veci iba zapíš.

## Výstup

Súbor `docs/kontrola-fable-2026-11.md`:

- verdikt na nasadenie (áno / nie / áno po opravách);
- nálezy zoradené podľa závažnosti, so `súbor:riadok` a návrhom opravy;
- čo z revízie Codexu si prevzal a čo nie, a prečo;
- odporúčania k návrhom z testu;
- kroky pred nasadením: zvýšenie verzie (service worker drží verzované súbory 3.6.0 ako nemenné), záloha databázy podľa `deployment.md`.

## Pravidlá

- Nič necommituj, nenasadzuj a nemeň Fly secrets bez výslovného súhlasu Františka.
- `.env` vo worktree nečítaj ani nevypisuj. Je v ňom testovací Soniox kľúč a `MAX_USER_SESSIONS_PER_DAY=100` iba pre lokálny test.
- Platené testy so Sonioxom iba so súhlasom Františka a s rozpočtom.
- František používa **iba Android** (Samsung Galaxy S24 Ultra, Chrome). iPhone sa netestuje.
- Lokálny server so skutočným Sonioxom na tomto notebooku potrebuje `NODE_EXTRA_CA_CERTS` s koreňovým certifikátom Kaspersky (TLS inšpekcia), inak `SELF_SIGNED_CERT_IN_CHAIN`. Postup je vo výsledkoch testu v časti „Prostredie“. Produkcie na Fly sa to netýka.
- Telefón môže byť pripojený cez USB: `adb` je v `C:\Users\feros\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe`. Presmerovanie portov je momentálne zrušené.
