# Pokračovanie modernizácie — 6. 9. 2026

- Implementácia 3.0.0 je v pracovnom strome; bez commit/deploy a bez čítania produkčných secrets.
- Modely STT v5/TTS v2, SQLite rezervácie, bezpečnosť session/WS a rušiteľné TTS sú implementované.
- Hotové sú mobilné UI, potvrdenie automatického jazyka, dva hlasy a výslovná lokálna história.
- Testy a lokálny Chrome používali simulované API; reálny Soniox a fyzické mobily zostávajú neoverené.
- qs override 6.16.0 rieši aktuálne npm advisories; po aktualizácii závislostí audit ukázal nulu.
- Pred deployom je nutný jediný Fly Volume pre jednu Machine, zápis UID 1000 a nové silné individuálne kódy.
- Dokumentácia implementácie: docs/modernization.md. Postup nasadenia/rollbacku: deployment.md.
- Pôvodná rozpracovaná verzia bola zálohovaná pred úpravami; historický README je zachovaný v docs.
- Ďalší krok: staging overenie Sonioxu a fyzických mobilov, potom schválenie konkrétneho deployu.
- Next prompt: Pokračuj v Soniox prekladači podľa docs/modernization.md a deployment.md; najprv over aktuálny git diff a zostávajúce staging kontroly, produkciu nenasadzuj bez schválenia.
