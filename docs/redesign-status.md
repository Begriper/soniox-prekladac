# Redizajn PWA — stav 24. 9. 2026

- Implementovaný tmavý technologický dizajn prihlasovania a aplikácie v `public/index.html` a `public/style.css`; Manrope je uložený lokálne s OFL licenciou.
- Hlavná mobilná obrazovka drží prepis a ovládanie mikrofónu na dosah; rozloženie pokrýva AUTO/PTT, potvrdenie jazyka, zobrazenie oproti sebe, nastavenia, hlasy, históriu, chybu a offline stav.
- Návrhový brief je v `docs/design-brief.md`. Figma súbor: https://www.figma.com/design/Z1R5aHr5jN78JQJxn12Oet — tokeny, štýly, základy a dve sady variantných komponentov.
- Klikateľné obrazovky vo Figme sú odložené podľa rozhodnutia používateľa; Figma Starter vyčerpala MCP limit. Druhý prázdny súbor `VZamjWpyznVerpLHuOML2C` vznikol iba na diagnostiku konektora.
- Codex Security Standard scan našiel dva súbehy v TTS a WebSocket admission; oprava je v `server.js`, regresné testy v `test/admission-race.test.js`.
- `npm run check`, 60 testov, `npm audit --omit=dev` (0 zraniteľností) a `git diff --check` prešli. Lokálny browser preveril mobilný a široký layout, focus, obmedzený pohyb a bez horizontálneho pretekania.
- PWA bola nasadená na https://soniox-prekladac.fly.dev/ ako Fly release 48; jedna Machine a pôvodný volume zostali zachované.
- Na finálne prijatie PWA chýba celý rozhovor na fyzickom Android Chrome a iPhone Safari.
- Next prompt: „Otestuj celý rozhovor na fyzických telefónoch a porovnaj prerobenú PWA s nasadenou verziou. Figmu rieš až na osobitnú požiadavku.“
