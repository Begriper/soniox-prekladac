# Soniox prekladač — návrhový brief

## Úloha

Navrhnúť a implementovať súdržnú mobilnú PWA pre obojsmerný hovorený preklad na jednom telefóne. Vizuál má pôsobiť ako samostatný kvalitný produkt: technologický, pokojný, presný a ľahko čitateľný počas živého rozhovoru.

## Zdrojová pravda

- Existujúci HTML/CSS/JavaScript a používateľské stavy sú autoritatívne pre funkcie. Dizajn nesmie sľubovať offline preklad ani trvalý beh mikrofónu na pozadí.
- Hlavné cesty: prihlásenie, jazyky a prostredie, AUTO/PTT, potvrdenie rozpoznaného jazyka, živý prepis a hlas, textový režim, zobrazenie oproti sebe, hlasy, nastavenia, explicitné uloženie a história.
- Zachovať slovenské ovládanie, súkromie histórie a jasné stavy mikrofónu, syntézy, siete a chyby.

## Vizuálne rozhodnutia

- Tmavý grafitový základ; tyrkysová označuje aktívny zvuk a primárnu akciu, teplá oranžová upozornenie. Smer prekladu rozlišuje rozloženie, nadpis a farba spolu, nie iba farba.
- Manrope pre nadpisy a ovládanie, lokálne uložený font s náhradou systémového písma. Krátke nadpisy, výrazný preklad, pokojný pôvodný text.
- Vlastný znak dvoch hlasových prúdov a nadväzujúca PWA ikona. Žiadna ilustračná výplň; ornament má vychádzať z reči alebo smeru prekladu.
- Ovládanie rozhovoru stále dosiahnuteľné palcom. Nastavenie pred začiatkom, prepis v strede, zreteľné AUTO/PTT a samostatné zastavenie hlasu.

## Figma výstup

Jeden súbor s tokenmi, textovými štýlmi a opakovane použiteľnými komponentmi. Obrazovky pri 390 px a 1280 px: prihlásenie, príprava, živý AUTO, živý PTT, potvrdenie jazyka, zobrazenie oproti sebe, nastavenia/hlasy, história a chybové/offline stavy. Prepojený prototyp: prihlásenie → príprava → rozhovor → uloženie → história.

## Kritériá hodnotenia

1. Do dvoch sekúnd je jasné, ktorý jazyk patrí komu, či mikrofón počúva a kde je preklad.
2. Na 360 px nie je horizontálne pretekanie ani zakrytý primárny ovládač; dlhé preklady sa zalomia a zostanú čitateľné.
3. Stav mikrofónu a prehrávania je zrozumiteľný aj bez farby a animácie.
4. Text má kontrast najmenej WCAG AA; cieľové dotykové plochy majú najmenej 44 × 44 px.
5. Všetky existujúce funkcie sú dostupné klávesnicou a v režime zníženého pohybu.

## Pracovný prompt pre návrh

> Z existujúcej funkčnej PWA Soniox prekladača navrhni produktový dizajn podľa tohto briefu. Zachovaj všetky uvedené používateľské cesty a význam stavov. Najprv vytvor vizuálne tokeny a komponenty, potom mobilné a široké obrazovky s reálnym slovenským textom. Uprednostni čitateľnosť živého prekladu, jednoznačné ovládanie mikrofónu a osobitú identitu. Pri každej obrazovke skontroluj prázdny, aktívny, čakajúci a chybový stav tam, kde sa vyskytuje. Výstupom je klikateľný prototyp a konkrétne špecifikácie pre HTML/CSS/JavaScript.
