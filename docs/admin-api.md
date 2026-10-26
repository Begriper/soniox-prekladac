# Admin API (A2)

Všetky trasy `/api/admin/*` vyžadujú platné prihlásenie s aktuálnou rolou `admin`; inak vracajú JSON s HTTP 403. POST používa existujúcu kontrolu `Origin`. Bez zmien UI alebo nových závislostí.

| Metóda | Cesta | Vstup / výsledok |
| --- | --- | --- |
| GET | `/api/admin/users` | `{ users }`: stav účtov, dátumy, poznámka, limity, dnešná a mesačná spotreba, aktívny rozhovor, neexpirované prihlásenia bez identifikátorov |
| POST | `/api/admin/users` | `{ username, role, password?, limits?, note? }`; HTTP 201 a `{ ok, username, password }`, pri duplicite 409 |
| POST | `/api/admin/users/:username/password` | `{ password? }`; `{ ok, username, password }`, zruší všetky prihlásenia a živé operácie |
| POST | `/api/admin/users/:username/limits` | `{ limits }`, `null` obnoví predvolené limity |
| POST | `/api/admin/users/:username/role` | `{ role }`, `admin` alebo `user` |
| POST | `/api/admin/users/:username/disable` | `{}`, zablokuje účet a ukončí jeho prihlásenia a živé operácie; `/revoke` je alias |
| POST | `/api/admin/users/:username/enable` | `{}`, odblokuje účet |
| POST | `/api/admin/users/:username/logout` | `{}`, zruší všetky prihlásenia a živé operácie |
| POST | `/api/admin/users/:username/delete` | `{}`, zmaže účet a anonymizuje jeho historickú spotrebu |
| GET | `/api/admin/usage?username=…&days=30` | `{ from, to, days, totals, by_user, conversations }`; `username` je voliteľné, `days` 1–400 |
| GET | `/api/admin/audit?limit=100` | `{ audit }`, najnovšie záznamy prvé, limit 1–500 |
| GET | `/api/admin/soniox-usage` | `{ month, fetched_at, by_reference, total_usd }`; pri nedostupnosti HTTP 503 a `{ error }` |

Neplatné údaje a zakázané zmeny vracajú 400, chýbajúci cieľový účet 404. Nové mená musia zodpovedať `/^[a-z0-9][a-z0-9._-]{1,39}$/`; importované mená zostávajú použiteľné. Heslá majú 12–512 znakov, generované heslo 16. Heslo sa vracia iba pri vytvorení alebo resete. Poznámka je reťazec do 200 znakov. Limity sú `null` alebo objekt s konečnými číslami 0–1e12 pod kľúčmi `sessions`, `audioBytes`, `ttsRequests`, `ttsAudioBytes`, `ttsChars`, `sttSeconds`, `sttSecondsMonth`. Neznáme polia POST sú odmietnuté.

Mutácia a audit sú v jednej SQLite transakcii. Audit nikdy neobsahuje heslo ani hash. Nemožno deaktivovať alebo zmazať seba, ani demotovať vlastný admin účet; posledný povolený admin zostáva chránený aj v metódach úložiska. Pri zmazaní sa najprv ukončí živý rozhovor a následne sa jeho aj historické záznamy premenujú na `deleted-` + prvých 8 hex znakov SHA-256 z `username + created_at`. Súhrnné počty zostávajú zachované. Núdzový vstup vlastníka z A1 zostáva funkčný.

`conversation_log` obsahuje iba identifikátor, používateľa, začiatok, trvanie, rezervovanú spotrebu, jazyky, profil, medián latencie a dôvod konca. Text ani audio sa neukladajú. Retencia spotreby aj záznamov konverzácií je 400 dní. Bežný koniec má `finished`, odpojenie klienta `client_closed`, vynútený koniec kód z `end(message, code)`.

Rozbor používa UTC dni vrátane dneška. Spotreba zahŕňa konzervatívne rezervácie vrátane neúspešných pokusov a fallbackov. Jazykové páry zachovávajú poradie strán A/B. Súhrnná latencia je medián mediánov zaznamenaných konverzácií; pri chýbajúcich meraniach je `null`. Konverzácie sa do obdobia zaraďujú podľa začiatku. Priemer trvania je pri prázdnom období `null`.

Odhad ceny: `sttSeconds / 3600 * PRICE_STT_USD_PER_HOUR` + `ttsAudioBytes / 48000 / 3600 * PRICE_TTS_USD_PER_HOUR`, zaokrúhlený na centy. Predvolené ceny sú 0.12 a 0.70 USD/h. Obe premenné sú v `.env.example`.

Skutočná cena používa [Soniox Usage Logs API](https://soniox.com/docs/api-reference/other/get_usage_logs): `GET /v1/usage-logs`, Bearer autentifikácia, UTC interval od začiatku mesiaca po čas načítania, `limit=1000`, `sort=end_time_asc`, stránkovanie `cursor` / `next_page_cursor`, pole `usage_logs` a `cost_usd`. Regionálna doména vychádza zo `SONIOX_REGION` ([regionálne endpointy](https://soniox.com/docs/data-residency)); testy používajú `SONIOX_USAGE_LOGS_URL`. Na stránku je timeout 5 s, najviac 50 strán. Neúplný výsledok sa nevracia ani necachuje. Úspešný súhrn sa cachuje hodinu, nový UTC mesiac cache zneplatní. Chýbajúce `client_reference_id` sa zoskupia pod prázdnym reťazcom; zachováva sa presnosť ceny poskytovateľa.

[Dokumentácia atribúcie](https://soniox.com/docs/guides/usage-logs) potvrdzuje `client_reference_id` pre všetky STT/TTS cesty. REST fallback, preview aj replay ho posielajú ako používateľské meno. `/api/replay` prijíma číselnú rýchlosť `speed` alebo `tts_speed` v rozsahu 0.7–1.3; pri súčasnom použití musia byť rovnaké.

Overenie A2: 19 nových integračných a jednotkových testov v `test/admin.test.js` používa existujúci mock; celá sada prešla 100/100 a syntaktická kontrola 32 súborov. Lokálne prostredie má Node 22.14 namiesto požadovaného Node 24 a blokuje podprocesy (`spawn EPERM`), preto štandardné `npm run check` a `npm test` nemožno dokončiť. Použité náhrady: syntaktická kompilácia JS/CJS cez `vm.Script` a `node --test --experimental-test-isolation=none`. Overenie na Node 24 zostáva pre CI; živé Soniox API sa nevolalo.
