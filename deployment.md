# Verzia 3.5.0 — release 53, 2026-10-26

Na výslovné schválenie používateľa zlúčený PR #14 a nasadený `main` (merge commit `faa768f`): režim Počúvanie (prepínač Konverzácia | Počúvanie, zdroj zvolený alebo Auto, jednosmerný preklad do jazyka A, samostatné prepínače Titulky a Hlas, plný duplex, plynulé pokračovanie po 30-min limite, nečinnosť 5 min). Fly remote builder, iba existujúca Machine `8e2135b77993d8` vo `fra`; volume `vol_rnzld90dqg7mypkr` zostal pripojený, secrets sa nemenili.

- Snapshot volume pred deployom: `vs_QJ4KaVNKAenhBKk9G7Ob5` (retencia 5 dní).
- Aktuálny image: `registry.fly.io/soniox-prekladac:deployment-01M5WRZGX0GBDF5Y00ZMQW31ZR`
- Predchádzajúci image na rollback: `registry.fly.io/soniox-prekladac:deployment-01M5WQ68XXD5YNZV46K0DZX12V` (v52)
- Pred deployom: CI (Node 24) zelené, lokálne `npm run check` a 164/164 testov (Node 22.14), Codex revízia opravená, overenie v prehliadači na mock serveri pri 360 px.
- Po deployi: release v53, health check `1 passing`, log `Translator 3.5.0 listening on 8080`; `/api/config` 3.5.0; cache `translator-shell-3.5.0`; HTML má prepínač Počúvanie, Titulky, Hlas, tlačidlo passkey a podpis autora; `?v=3.5.0` súbory 200; `/api/session` a `/api/passkeys` 401, `/api/admin/users` 403; POST `/api/login` s cudzím Origin 403; WebSocket bez cookie 401.
- Neoverené: skutočné Počúvanie na telefóne (slúchadlá, reproduktor, výstup pri zapnutom mikrofóne) a dlhšie počúvanie cez 30 min. Overí používateľ.
- Rollback na v52 je bezpečný: server nemá nové tabuľky, stará verzia ignoruje `mode` a `listen_source`.

```powershell
fly deploy --app soniox-prekladac --image registry.fly.io/soniox-prekladac:deployment-01M5WQ68XXD5YNZV46K0DZX12V --only-machines 8e2135b77993d8 --update-only --strategy immediate --yes
```

---

# Verzia 3.4.0 — release 52, 2026-10-26

Na výslovné schválenie používateľa zlúčený PR #13 a nasadený `main` (merge commit `341a745`): prihlásenie odtlačkom prsta, tvárou alebo Face ID (passkey, WebAuthn) a podpis „Vytvoril František Stolár“ na úvodnej obrazovke. Fly remote builder, iba existujúca Machine `8e2135b77993d8` vo `fra`; volume `vol_rnzld90dqg7mypkr` zostal pripojený, secrets sa nemenili.

- Snapshot volume pred deployom: `vs_e79ozPQoYjkhXKZ4q0YzG5K` (24 MiB, retencia 5 dní).
- Aktuálny image: `registry.fly.io/soniox-prekladac:deployment-01M5WQ68XXD5YNZV46K0DZX12V`
- Predchádzajúci image na rollback: `registry.fly.io/soniox-prekladac:deployment-01M5WKA9EE4MDCG033WYESH1QV` (v51)
- Pred deployom: CI (Node 24) zelené, lokálne `npm run check` a 147/147 testov (Node 22.14), Codex adversarial review opravený.
- Po deployi: release v52, health check `1 passing`; `/api/config` 3.4.0; cache `translator-shell-3.4.0`; HTML má podpis autora a tlačidlo passkey; `?v=3.4.0` súbory 200; `/api/passkeys` bez cookie 401; `/api/passkeys/login/options` 200 s `rpId` `soniox-prekladac.fly.dev`, cudzí Origin 403; neplatné prihlásenie passkey 400; `/api/session` 401, `/api/admin/users` 403.
- Neoverené: skutočný odtlačok alebo Face ID na telefónoch (iPhone appka z plochy, Android). Overí používateľ.
- Rollback na v51 je bezpečný: tabuľka `passkeys` a stĺpec `webauthn_user_id` stará verzia ignoruje; prihlásenie heslom funguje ďalej.

```powershell
fly deploy --app soniox-prekladac --image registry.fly.io/soniox-prekladac:deployment-01M5WKA9EE4MDCG033WYESH1QV --only-machines 8e2135b77993d8 --update-only --strategy immediate --yes
```

---

# Verzia 3.3.0 — release 51, 2026-10-26

Na výslovné schválenie používateľa zlúčené PR #5–#12 a nasadený `main` (merge commit `b11262e`): opravy v3.2.1 (obnova spojenia, PTT a začiatok reči, strážca mikrofónu, fronta hlasu so spätným tlakom, rozpočet TTS streamov, verzované PWA assety) a admin v3.3.0 (účty v SQLite, meno + heslo, prihlásenie na 30 dní, limity na osobu, admin API, rozbor spotreby, admin obrazovky). Fly remote builder, iba existujúca Machine `8e2135b77993d8` vo `fra`; volume `vol_rnzld90dqg7mypkr` zostal pripojený, secrets sa nemenili.

- Snapshot volume pred deployom: `vs_K6LKXRmKDlbUZ1VpKv93RgY` (22 MiB, retencia 5 dní).
- Aktuálny image: `registry.fly.io/soniox-prekladac:deployment-01M5WKA9EE4MDCG033WYESH1QV`
- Predchádzajúci image na rollback: `registry.fly.io/soniox-prekladac:deployment-01M5W97PS3G8X2KNEHZ6G7VT31` (v50)
- Pred deployom: GitHub Actions CI (Node 24) zelené pre všetky PR, lokálne `npm run check` a 120/120 testov (Node 22.14).
- Po deployi: release v51, Machine `started`, health check `1 passing` (jedno zlyhanie počas štartu pred `Translator 3.3.0 listening on 8080`). `/health` 200; `/api/config` 3.3.0; HTML má pole „Meno“ a admin sheet; všetky `?v=3.3.0` súbory, `sw.js` a font HTTP 200; cache `translator-shell-3.3.0`; neprihlásené `/api/session` a WebSocket 401, `/api/admin/users` 403; POST `/api/login` s cudzím Origin 403.
- Pri prvom štarte sa `APP_ACCESS_CODES` naimportovali ako účty (kód = heslo, `APP_OWNER_USERNAME` = admin). Runtime databáza sa pri overení nečítala.
- Neoverené: skutočné prihlásenie menom a heslom, admin obrazovky a `/api/admin/soniox-usage` proti živému Sonioxu, ozvena na reproduktore a fyzické telefóny (iPhone, Android, Bluetooth). Overí používateľ.
- Rollback na v50 je bezpečný na rovnakom volume: stará verzia nové tabuľky ignoruje, blokovania sa zrkadlia do `revoked_users` a prihlasuje sa env kódom. Prihlásenia z v3.3.0 po rollbacku neplatia (v50 ich drží iba v pamäti).

```powershell
fly deploy --app soniox-prekladac --image registry.fly.io/soniox-prekladac:deployment-01M5W97PS3G8X2KNEHZ6G7VT31 --only-machines 8e2135b77993d8 --update-only --strategy immediate --yes
```

---

# Verzia 3.2.0 — release 50, 2026-10-26

Na výslovné schválenie používateľa nasadený `main` po zlúčení PR #3 (merge commit `eda0759`, obsahuje aj PR #2): Soniox autentifikácia v hlavičke, PTT keepalive, TTS lifecycle, rozdielový prepis, auto-reconnect, nové mobilné UI a HTTP health check. Fly remote builder, iba existujúca Machine `8e2135b77993d8` vo `fra`; volume `vol_rnzld90dqg7mypkr` zostal pripojený, secrets sa nemenili.

- Aktuálny image: `registry.fly.io/soniox-prekladac:deployment-01M5W97PS3G8X2KNEHZ6G7VT31`
- Predchádzajúci image na rollback: `registry.fly.io/soniox-prekladac:deployment-01M5W2WR0W5BMNNDMWGNHJYCTW` (v49)
- Pred deployom: GitHub Actions CI (Node 24) zelené, lokálne `npm run check` a 56/56 testov, `fly config validate`.
- Po deployi: release v50 `complete`, Machine `started`, health check `1 passing` (jedno zlyhanie počas štartu pred `Translator 3.2.0 listening on 8080`). `/health`, `/`, statické súbory, PNG ikony a font HTTP 200; nové UI v HTML; `/api/config` 3.2.0; neprihlásené API 401; POST `/api/login` s cudzím Origin 403.
- Neoverené: skutočný Soniox s autentifikáciou v hlavičke (lokálne iba mock) a fyzické telefóny. Ak preklad nefunguje, okamžite rollback na v49.

```powershell
fly deploy --app soniox-prekladac --image registry.fly.io/soniox-prekladac:deployment-01M5W2WR0W5BMNNDMWGNHJYCTW --only-machines 8e2135b77993d8 --update-only --strategy immediate --yes
```

---

# Bezpečnostná oprava závislostí — release 49, 2026-10-26

Na výslovné schválenie používateľa nasadená vetva `fix/npm-audit-2026-10` (commit `2fa32ed`): `body-parser` 1.20.9 (GHSA-27r3-jxmh-p828) a `proxy-addr` 2.0.8 (GHSA-jqcg-44mw-7w3h), zmena iba v `package-lock.json`. Fly remote builder, iba existujúca Machine `8e2135b77993d8` vo `fra`; volume `vol_rnzld90dqg7mypkr` zostal pripojený, secrets sa nemenili.

- Aktuálny image: `registry.fly.io/soniox-prekladac:deployment-01M5W2WR0W5BMNNDMWGNHJYCTW`
- Predchádzajúci image na rollback: `registry.fly.io/soniox-prekladac:deployment-01M3AMZT466003KERDR2Y4DC5K`
- Pred deployom: `fly config validate`, `npm run check`, 60 úspešných testov (lokálne Node 22.14), `npm audit --omit=dev` 0 zraniteľností.
- Po deployi: release v49 `complete`, Machine `started` a `good state`, log `Translator 3.1.0 listening on 8080`. `/health`, `/`, `/app.js`, `/style.css`, `/sw.js`, `/manifest.webmanifest` HTTP 200; `/api/config` 3.1.0; neprihlásené `/api/session` a `/api/voices` 401; POST `/api/login` s cudzím Origin 403; CSP aj HSTS prítomné.
- Prihlásený rozhovor na telefóne overuje používateľ. Machine nemá v `fly.toml` health check — doplniť samostatne.

```powershell
fly deploy --app soniox-prekladac --image registry.fly.io/soniox-prekladac:deployment-01M3AMZT466003KERDR2Y4DC5K --only-machines 8e2135b77993d8 --update-only --strategy immediate --yes
```

---

# Produkčné nasadenie redizajnu — release 48, 2026-09-24

Na výslovnú žiadosť používateľa bol aktuálny pracovný strom nasadený na Fly.io cez remote builder. Aktualizovaná bola iba existujúca Machine `8e2135b77993d8` v `fra`; šifrovaný volume `vol_rnzld90dqg7mypkr` zostal pripojený na `/data`. Secrets ani obsah volume sa nemenili.

- Aktuálny image: `registry.fly.io/soniox-prekladac:deployment-01M3AMZT466003KERDR2Y4DC5K`
- Predchádzajúci image na rollback: `registry.fly.io/soniox-prekladac:deployment-01M3AG39BT3ZYZ1HM5GWVABWP4`
- Pred deployom: `fly config validate`, `npm run check`, 60 úspešných testov. Posledný `npm audit --omit=dev` mal 0 zraniteľností.
- Po deployi: release 48 `deployed`, Machine `started` a `good state`; `/health`, `/`, `/style.css`, `/app.js`, `/sw.js`, `/icon.svg` a lokálny font vracajú HTTP 200. Verejná HTML stránka obsahuje nové prvky dizajnu.
- Produkčný Chrome pri 390 px zobrazuje prihlasovanie bez horizontálneho pretekania. Neprihlásený `/api/session` vracia očakávané 401.
- Živý prihlásený rozhovor a audio na fyzických telefónoch musí overiť používateľ. Po nasadení je potrebné znovu sa prihlásiť, pretože session mapy sú v pamäti procesu.

Návrat na predchádzajúci image pri regresii (zachová Machine aj volume):

```powershell
fly deploy --app soniox-prekladac --image registry.fly.io/soniox-prekladac:deployment-01M3AG39BT3ZYZ1HM5GWVABWP4 --only-machines 8e2135b77993d8 --update-only --strategy immediate --yes
```

---

# Predchádzajúce nasadenie 3.1.0 — release 47, 2026-09-24

Používateľ schválil okamžité nasadenie aj bez fyzických staging testov na telefónoch. Nasadenie cez Fly remote builder skončilo úspešne; release 47 bežal na jedinej Machine `8e2135b77993d8` v `fra` s pôvodným volume `vol_rnzld90dqg7mypkr` na `/data`. Vlastník hlasu je nastavený cez `APP_OWNER_USERNAME=fero` vo Fly secrets. Žiadne tajné hodnoty nie sú uložené v repozitári.

- Vtedajší image: `registry.fly.io/soniox-prekladac:deployment-01M3AG39BT3ZYZ1HM5GWVABWP4`
- Predchádzajúci image na rollback: `registry.fly.io/soniox-prekladac:deployment-01M1X8C8XE7CVGD4EYKD9JFCWV`
- Smoke test: `/`, `/app.js`, `/sw.js` HTTP 200; `/health` OK; `/api/config` vracia 3.1.0; neprihlásené `/api/voices` vracia 401; produkčné prihlásenie účtu `fero` a `/api/voices` vracia 200, 200 vstavaných hlasov a jeden pripravený vlastný hlas s UUID.
- Pred nasadením: `npm run check`, `npm test` (57 úspešných), `npm audit --omit=dev` (0 nálezov), Fly remote Docker build.

Rollback pri regresii aplikácie (zachová Machine aj volume):

```powershell
fly deploy --app soniox-prekladac --image registry.fly.io/soniox-prekladac:deployment-01M1X8C8XE7CVGD4EYKD9JFCWV --only-machines 8e2135b77993d8 --update-only --strategy immediate --yes
```

Po rollbacku overiť `/health`, `/api/config`, prihlásenie a pripojenie volume. SQLite na volume sa rollbackom image nevracia. Stále treba na skutočných zariadeniach overiť SK/DE/PL rozhovor, slúchadlá a reproduktor, ozvenu, prerušenie siete a čas po prvý počuteľný preklad.

## Starší plán pre verziu 3.0.0
# Nasadenie verzie 3.0.0

Tento postup je pripravený na schválenie. V rámci implementácie sa nevykonával žiadny produkčný deploy, škálovanie ani zmena secrets.

## Predpoklady

1. Zaznamenať identifikátor aktuálne nasadeného image a konfiguráciu Machine. Pôvodné rozpracované súbory sú aj v lokálnej zálohe pred modernizáciou; do repozitára sa tajné hodnoty nepridávajú.
2. Overiť jednu aplikačnú Machine v regióne fra. Aktuálny návrh používa lokálnu SQLite na jednom volume; horizontálne škálovanie s nezávislými kvótami nie je podporované.
3. Pripraviť volume translator_data pripojený na /data. Ešte pred prechodom na neprivilegovaný image inicializovať vlastníctvo adresára pre UID/GID 1000 a skontrolovať zápis. Mount prekryje vlastníctvo adresára z image. Volume aj jeho dáta musia zostať zachované počas aktualizácií a rollbacku.
4. Nastaviť individuálne náhodné APP_ACCESS_CODES (minimálne 16 znakov), SESSION_SECRET (minimálne 32 znakov), SONIOX_API_KEY a presné HTTPS APP_ORIGINS. Skutočné hodnoty sa pri tejto práci nečítali ani nemenili.
5. USAGE_DB_PATH musí smerovať na /data/usage.sqlite. TRUST_FLY_PROXY sa zapína iba vo Fly Proxy topológii. Aplikačný port nesmie byť prístupný priamo mimo proxy.
6. Docker build treba vykonať v prostredí s Dockerom. Na tomto počítači Docker CLI nebol dostupný; image preto zatiaľ nemá overený build.

## Overenie pred schválením

- Node 24: npm ci, npm run check, npm test, npm audit --omit=dev.
- V izolovanej staging aplikácii overiť reálny Soniox a aspoň Android Chrome a iPhone Safari.
- Slovenčina ↔ nemčina, španielčina a angličtina: čísla, mená, negácie, dlhšie pauzy, zmena hovoriaceho. Vety pre návštevu lekára posúdiť aj podľa zachovania významu.
- Overiť TTS v2 hlasy, zh/sr/bs/kk obmedzenia písma, slúchadlá/reproduktor, echo, zamknutie displeja, odmietnutie mikrofónu a Wi-Fi ↔ mobilné dáta.
- Reštart staging Machine musí zachovať rezervácie kvót. Dočasná nedostupnosť volume nesmie povoliť platený request.
- Skontrolovať aktuálny počet jazykov priamo z reálneho modelového katalógu; testovací server zámerne ponúka len šesť jazykov.

## Uvoľnenie

Po schválení konkrétneho image, konfigurácie a staging výsledkov použiť existujúcu jednu Machine a pripojený volume. Nevytvárať automaticky druhú HA Machine. Najprv overiť /health, prihlásenie a katalógy, následne krátky obojsmerný rozhovor. Reštart ruší existujúce sessions, používatelia sa prihlásia znova.

## Návrat

- Pri probléme výhradne s TTS WebSocketom je pripravený TTS_TRANSPORT=rest; rozpoznávanie naďalej potrebuje STT WebSocket.
- Pri regresii celej aplikácie obnoviť zaznamenaný predchádzajúci image a jeho kompatibilnú konfiguráciu. Obnoviť aj verejné frontend súbory ako jeden celok.
- Volume nemaž. Starší server používal RAM kvóty a nemusí SQLite rezervácie rešpektovať: pri návrate dočasne obmedziť používanie/kredit poskytovateľa a počítať s týmto rozdielom.
- Nový service worker cacheuje iba verejný aplikačný obal. Pri návrate overiť aktualizáciu/odregistrovanie jeho verzie na otvorených klientoch; nikdy nemaž používateľskú IndexedDB históriu ako súčasť rollbacku.

Referencie: [Fly volumes](https://fly.io/docs/launch/volume-storage/), [Fly konfigurácia](https://fly.io/docs/reference/configuration/).

