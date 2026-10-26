# Soniox prekladač — pravidlá pre AI agentov

Platí pre Claude Code aj Codex. Dopĺňa `D:\Codex\AGENTS.md` (komunikácia po slovensky, commit iba so súhlasom).

## Projekt v skratke

- Súkromná mobilná PWA na živý hlasový preklad tvárou v tvár. Stack: Node 24 + Express + ws, vanilla HTML/CSS/JS, bez frameworku a bez build kroku. Ostáva PWA; natívna appka ani React/Next.js sa neplánujú.
- Server: `server.js`, `speech-session.js` (STT, preklad, TTS fronta), `tts-transport.js`, `tts-rest.js`, `catalog.js`, `security.js`, `usage-store.js`. Klient: `public/`.
- Soniox: `stt-rt-v5` s natívnym `two_way` prekladom a `tts-rt-v2`. Kľúč posielať iba v hlavičke `Authorization` (od 15. 1. 2027 povinné). API kľúč nikdy do prehliadača.
- `main` = produkcia na Fly (`soniox-prekladac`, jedna Machine, jeden volume). Postup nasadenia a rollbacku je v `deployment.md`.
- Kontext a rozhodnutia: `README.md`, `analysis/deep-analysis-2026-10-26.md`.

## Spolupráca Claude + Codex

- **Claude (Opus) riadi prácu**: plán, implementácia, testy, PR. Ľahké a rozsiahle čítanie (hľadanie v kóde, prehľad súborov) deleguje na subagentov (`Explore`, lacnejší model), aby šetril kontext.
- **Codex (`gpt-6.1-sol`, effort `high`) je druhý model.** Claude ho volá sám, bez čakania na používateľa:
  - Revízia pred každým PR: `node "<plugin>/scripts/codex-companion.mjs" review --wait --base main` (iba čítanie). Pri veľkých zmenách aj `adversarial-review`. `<plugin>` = `C:\Users\feros\.claude\plugins\cache\openai-codex\codex\<verzia>`.
  - Samostatná, jasne ohraničená úloha (druhá implementácia, hlbšia diagnostika): subagent `codex:codex-rescue`. Ten predvolene zapisuje (`--write`), preto ho púšťaj na vlastnej vetve alebo v worktree, nie súčasne s Claude na tých istých súboroch.
  - Nálezy Codexu Claude overí v kóde a testoch, nepreberá ich naslepo. V PR uvedie, čo z Codex revízie opravil a čo nie a prečo.
- Používateľ môže kedykoľvek ručne spustiť `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`.

## Overenie a nasadenie

- Pred PR: `npm run check`, `npm test`. CI na GitHube (Node 24) musí byť zelené.
- Lokálny test UI bez Sonioxu: `node scripts/mock-app.cjs` → http://127.0.0.1:3210 (testovací kód v `test/helpers/mock-runtime.cjs`). `.claude/launch.json` má konfiguráciu `mock-app`.
- Zlúčenie PR a `fly deploy` iba s výslovným súhlasom používateľa. Po nasadení smoke test a zápis do `deployment.md`.

## Nástroje na tomto počítači

- GitHub CLI: `C:\Program Files\GitHub CLI\gh.exe` (repo `Begriper/soniox-prekladac`, privátne).
- Fly CLI: `C:\Users\feros\.fly\bin\flyctl.exe`.
- Codex CLI 0.164+: `[windows] sandbox = "unelevated"` v `C:\Users\feros\.codex\config.toml` obchádza chybu `helper_sandbox_lock_failed` ([openai/codex#46380](https://github.com/openai/codex/issues/46380)). Po oprave chyby v Codexe sa dá vrátiť na `elevated`.
