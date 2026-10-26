# Modernizácia — implementácia a overenie

Dátum: 6. 9. 2026. Verzia: 3.0.0. Stav: implementácia v pracovnom strome, bez produkčného deployu.

## Čo sa zmenilo

| Oblasť | Implementácia |
|---|---|
| Modely | Centrálne STT v5 a TTS v2 v runtime-models.js; rovnaký model v katalógoch, WS, REST a ukážkach. |
| Autentifikácia | Bezpečný parser cookie, striktne validované WS správy, chybové handlery, jediný config, presný Origin, ohraničené sessions/login pokusy, rušenie pri logout/expirácii. |
| Kredity | Transakčná SQLite rezervácia pred každým plateným pokusom vrátane fallbacku; kvóty požiadaviek, znakov, STT času a prenesených bajtov. Pevné krátke ukážky hlasu. |
| TTS | First-audio/idle/total timeout 3/5/30 s, REST deadline 15 s a AbortController. REST fallback iba pred prvým audiom a iba pri transportnej chybe. Po dvoch zlyhaniach režim REST na 60 s. |
| Prehrávanie | conversation_id, utterance_id, playback_id; potvrdenia viazané na operáciu; oneskorené potvrdenia aj chyby zrušených streamov sa ignorujú. Stop má vlastné potvrdenie a blokuje staré audio. |
| Mikrofón | Rovnaké stlmenie počas streamu aj lokálneho opakovania; STT keepalive po 10 s. Flush posledného worklet bufferu pred dokončením rozhovoru. |
| Preťaženie | Ohraničené buffery/fronta; odmietnutý hlas sa označí ako neprehraný, predchádzajúce položky sa nezahadzujú. Dlhý text sa delí bez limitu štyroch častí a bez poškodenia Unicode. |
| Konverzácia | Rozpoznanie jazyka bez automatického hlasu, potvrdenie a nový two_way stream. Zachovanie prepisu pri obnove alebo zmene jazykov. |
| Mobilné UI | Slovenské ovládanie, dostupné Stop audio/odhlásenie/textový režim, explicitné slúchadlá, dva hlasy, vyhľadávanie jazykov, posledné jazyky, otočené zobrazenie oproti sebe. |
| História | Výslovné ukladanie textu do IndexedDB podľa používateľa, otvorenie, kopírovanie/export, vymazanie. Žiadne trvalé audio; cache v RAM max. 12 MiB s hlasom aj modelom v kľúči. |
| PWA | Manifest a offline oznam; service worker necacheuje API, audio ani údaje rozhovoru. |
| Runtime | Node 24 LTS, neprivilegovaný node v Docker image, len potrebné runtime súbory. |

Server je rozdelený na security.js, usage-store.js, catalog.js, speech-session.js, tts-transport.js a tts-rest.js. Zostáva Express a pôvodný vanilla frontend, bez zavedenia frameworku či ďalšieho poskytovateľa.

## Bezpečnostná aktualizácia závislostí

Audit odhalil zraniteľné transitive qs a body-parser. body-parser je aktualizovaný na 1.20.6. Express 4.22.2 a body-parser obmedzujú qs na rad 6.15, preto package.json obsahuje zdokumentované override na opravené qs 6.16.0. Override odstrániť až keď ich vlastné závislosti povoľujú opravenú verziu. Po zmene npm hlási 0 zraniteľností. Ide o výsledok databázy npm, nie záruku neprítomnosti všetkých bezpečnostných chýb.

Zdroje: [qs isBuffer oprava](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), [qs limit poľa](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx).

## Overenie

Záverečný beh: 52 úspešných testov (vrátane načítania pomocného mock modulu), 0 zlyhaní; syntax prešla a npm audit hlási 0 zraniteľností.

Lokálne testy používajú vstavanú SQLite a simulované HTTP/WS API. Nespúšťajú platené Soniox požiadavky ani nečítajú produkčný .env.

- Kontrola syntaxe servera, frontend JS a testov.
- Regresie: chybná cookie, null JSON, neplatný WS frame, nesprávny Origin, opakovaný config, logout a expirácia bez HTTP requestu.
- Rezervácie: dva SQLite klienty, atomické odmietnutie, zachovanie po otvorení DB znova, oddelenie používateľov, súbežné ukážky, limit opakovania.
- Audio: prvé audio/idle/total timeout, cancel počas pripojenia aj REST, staré playback_done, stará chyba zrušeného streamu, WS fallback, žiadny fallback po čiastočnom audiu/401.
- Preklad: dve oddelené jazykové smerovania a auto → potvrdenie → two_way.
- Buffer: keepalive pri lokálnom opakovaní, zaplnená fronta, flush poslednej vzorky a delenie Unicode.
- Chrome s lokálnym poskytovateľom a syntetickým mikrofónom: prihlásenie, prepis/hlas, zastavenie, uloženie, otvorenie a hlasové opakovanie histórie, filtrovanie ženského hlasu, odhlásenie a prázdna história druhého účtu.
- Chrome responzivita: 360, 390, 768 a 1280 px; bez horizontálneho pretekania. Mobilné tlačidlo výmeny bolo zväčšené na 44 px.
- Offline: oznam sa zobrazí, počúvanie je zakázané. Prihlásenie pred získaním session zámerne vracia 401; zachytené UI error/unhandledrejection udalosti počas testovacieho rozhovoru boli prázdne.

Pri záverečnom reload Chrome navyše hlásil zablokovaný skript lokálneho antivírusu Kaspersky politikou script-src self. Aplikačné HTTP požiadavky v tom behu nemali chybové statusy; CSP sa kvôli externému skriptu neuvoľňovala.

Snímky overenia sú lokálne v output/playwright a nie sú súčasťou produkčného image.

## Meranie a limity overenia

/api/diagnostics sprístupňuje posledné časovanie používateľa bez textov a audia: čas syntézy po prvé audio na serveri, čas od serverového endpointu po audio a potvrdenie naplánovaného začiatku prehrávania klientom. Posledné údaje obsahujú počet vzoriek, medián a P95 samostatne pre WS/REST.

Tieto časy **nie sú meraním od fyzického konca reči po skutočne počuteľný zvuk**: zahŕňajú sieťové potvrdenie a začínajú serverovým endpointom. Sú pomôckou na porovnávanie transportov, nie dôkazom dosiahnutej latencie. Reálne meranie na telefóne vrátane endpoint delay a zvukového výstupu zostáva staging úlohou.

Neoverené: reálny Soniox, aktuálny katalóg konkrétneho účtu, kvalita prekladu medicínskych viet, fyzické zariadenia/echo/Bluetooth, iPhone Safari, prechod medzi sieťami a Docker build (Docker CLI nie je na tomto počítači). Produkčná topológia/secrets/volume sa nemenili. Pozri [nasadenie](../deployment.md).

## Prevádzkové rozhodnutia

- Konzervatívne rezervácie sa nevracajú po chybe, pretože upstream už mohol účtovať.
- Jeden používateľ má najviac jeden živý rozhovor; súbežná samostatná syntéza je blokovaná.
- Kompletný posledný overený katalóg sa uchová na disku; zlyhanie ho nenahradí menšou baseline.
- Lokálna história je oddelená v aplikácii podľa používateľa, nie kryptograficky izolovaná pred vlastníkom zariadenia.
- Tradíciu/zjednodušenú čínštinu nie je bezpečné automaticky určiť zo všetkých znakov. UI oznamuje obmedzenie a zlyhanie hlasu zostáva viditeľné; automatická konverzia písma sa nepridáva.
- Produkčný deploy a prípadné zmeny infraštruktúry zostávajú na samostatné schválenie.

Dokumentácia poskytovateľa: [speech-to-speech](https://soniox.com/docs/translation/sts-translation), [modely TTS](https://soniox.com/docs/tts/models), [keepalive](https://soniox.com/docs/stt/rt/connection-keepalive), [endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection).
