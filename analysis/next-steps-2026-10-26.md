# Ďalšie kroky po v3.3.0 — 26. 10. 2026

Tvoje tri nápady po otestovaní v3.3.0 na telefóne: prihlásenie biometrikou, podpis autora a „O aplikácii“, a biznis nápad robiť podobné appky známym. Zdroje: rešerš na webe (oficiálne stránky Sonioxu, Google, DeepL, Apple, Samsung, W3C a web.dev), plugin `product-management:competitive-brief` a súčasný kód. Kód sa v tejto fáze nemenil.

---

## 1. Prihlásenie odtlačkom prsta alebo Face ID

### Čo platí už dnes (v3.3.0)
- Po prihlásení si ťa appka **pamätá 30 dní** a prežije aj nasadenie novej verzie. Kým sa neodhlásiš, prihlasovaciu obrazovku vôbec nevidíš.
- **Android:** nainštalovaná appka zdieľa prihlásenie s Chrome. Kto je prihlásený v Chrome, je prihlásený aj v appke.
- **iPhone:** appka z plochy má oddelené úložisko od Safari, preto sa v nej treba prihlásiť raz zvlášť.
- Chrome vie uložené heslo vyplniť po overení odtlačkom. Funguje to, lebo formulár má teraz pole pre meno aj heslo.

### Návrh: passkey (štandard WebAuthn) — balík A4
Passkey je „heslo“ uložené v telefóne a odomykané biometrikou: odtlačok, tvár alebo Face ID. Na server ide iba verejný kľúč, žiadne heslo ani odtlačok.

| Kde | Čo pribudne |
|---|---|
| Nastavenia → Účet → **Prihlásenie** | „Pridať odtlačok / Face ID na toto zariadenie“, zoznam zariadení s passkey (napr. „Pixel 8 · pridané 26. 10.“), tlačidlo Odstrániť |
| Prihlasovacia obrazovka | Veľké tlačidlo **„Prihlásiť sa odtlačkom / Face ID“**, pod ním meno a heslo ako záloha. Chrome ponúkne passkey aj priamo v poli „Meno“ |
| Správa (admin) | Pri používateľovi počet passkey a možnosť ich odobrať. Reset hesla ich môže odobrať tiež |
| Voliteľne, neskôr | „Zamknúť appku pri otvorení“: biometria pri každom otvorení po X hodinách. Predvolene **vypnuté**, telefón je už zamknutý tvojím odtlačkom, takže by to iba pridalo kroky. Má zmysel, ak telefón požičiavaš |

**Technicky (bez nového npm balíka):**
- Prehliadač vráti verejný kľúč priamo cez `getPublicKey()`, takže netreba parsovať CBOR. Funkcia je bežne dostupná od roku 2023 (MDN).
- Algoritmus ES256 overí vstavaný `node:crypto`. Safari dnes vracia iba ES256 (WebKit bug 312081), čo stačí.
- `userVerification: "required"`, `residentKey: "required"` (prihlásenie bez písania mena), `attestation: "none"`.
- Jednorazová výzva (challenge) uložená na serveri na 5 minút. Kontrola origin, rpId, príznaku UV a podpisu podľa W3C WebAuthn L3 §7.2. `signCount` sa ukladá, ale pri hodnote 0 sa neodmieta (platformové passkey často vracajú 0).
- Tabuľka `passkeys` v tej istej SQLite. Pri zmazaní účtu sa odstráni spolu s ním.

**Riziká a čo treba overiť na telefóne:**
- Passkey v appke z plochy na iPhone pravdepodobne funguje, ale Apple to oficiálne nedokumentuje. Treba otestovať na tvojom iPhone.
- Android WebAPK používa Google Password Manager. Oficiálne potvrdenie pre nainštalovanú appku som nenašiel, test je nutný.
- Heslo ostáva vždy ako záloha, takže passkey nikoho nezamkne von.

**Náročnosť:** M. Implementácia Codex, revízia a test Claude, plus Codex adversarial review (ide o bezpečnosť).

---

## 2. Podpis autora a „O aplikácii“

**Áno, hodí sa to.** Bežne to tak robia appky aj weby. Odporúčam dve miesta, nenápadne, aby to nerušilo pri preklade.

1. **Prihlasovacia obrazovka, dole malým písmom:**
   `© 2026 František Stolár · Vyrobené na Slovensku`
2. **Nastavenia → úplne dole → „O aplikácii“** (rozklikávacia časť):
   - **Prekladač** · verzia 3.4.0 · vytvoril **František Stolár**, Slovensko, 2026
   - **Ako funguje:** rozpoznávanie a preklad Soniox `stt-rt-v5`, hlas Soniox `tts-rt-v2`, server Fly.io vo Frankfurte (EÚ)
   - **Súkromie:** text rozhovorov sa na serveri neukladá, zvuk spracúva Soniox v EÚ a neuchováva ho. Uložený rozhovor zostáva iba v tvojom telefóne.
   - **Príbeh** (2–3 vety tvojimi slovami): prečo a pre koho appka vznikla. **Tento text mi pošli ty**, nebudem ho vymýšľať.
   - Kontakt (e-mail), ak ho chceš uviesť.

Na prihlasovaciu obrazovku príbeh nedávaj, tam má byť iba rýchly vstup.

**Náročnosť:** S. Pôjde v tom istom vydaní ako A4 (v3.4.0).

---

## 3. Biznis nápad: appky pre známych

### Konkurencia (stav október 2026)

| Produkt | Hovorí preklad nahlas | Slovenčina | Cena | Poznámka |
|---|---|---|---|---|
| **Tvoja appka** | áno, prirodzený hlas | áno, SK ↔ DE overené | ~0,12 $/h rozpoznávania + ~0,70 $/h vygenerovanej reči | režim „oproti sebe“, správa účtov, žiadne reklamy |
| Google Translate + Gemini 3.5 Live Translate | áno, s intonáciou hovoriaceho | **neoverené** (stránka uvádza „70+ jazykov“) | zadarmo | najsilnejší konkurent, dostupnosť v EÚ a SK treba overiť |
| Soniox App (Translator) | **iba text**, bez hlasu | áno | zdarma s limitom, Pro 10–20 $/mes. | rovnaká kvalita rozpoznávania, ale bez hlasu. To je tvoj rozdiel |
| DeepL Voice | nejasné (hlas cez systém telefónu) | áno | bez oficiálnej ceny pre jednotlivcov | jedna dvojica jazykov na rozhovor |
| Apple Live Translation (AirPods) | áno | **nie** | v systéme | v EÚ nedostupné, iPhone 15 Pro+ |
| Samsung Interpreter | čiastočne | **nie** (13 jazykov) | v systéme | iba Samsung |
| Timekettle W4 Pro (slúchadlá) | áno | áno (online) | ~449 $ | hardvér |
| Microsoft Translator | — | — | zadarmo | režim Converse sa ruší (jún 2026) |

### Čo je na nápade dobré
- **Skutočná medzera:** obojsmerný preklad **hlasom** so slovenčinou a dobrou kvalitou rozpoznávania. Soniox vlastnú hlasovú appku nemá, Apple a Samsung slovenčinu nemajú.
- **Nízke prevádzkové náklady:** hodina rozhovoru stojí rádovo desiatky centov.
- **Hotová správa používateľov a limitov:** to je presne to, čo by si pri ďalších ľuďoch potreboval.
- **Výborná vizitka:** ukazuje, čo vieš postaviť.

### Čo je slabé alebo rizikové (úprimne)
1. **Google je zadarmo a stále lepší.** Ak Gemini Live Translate dobre zvládne slovenčinu, väčšina bežných ľudí nebude mať dôvod platiť. **Najprv to otestuj sám** v Google Translate na telefóne (SK ↔ DE, ulica, lekár).
2. **Podmienky Sonioxu:** oddiel 3 zakazuje bez písomného súhlasu **ďalší predaj a „service bureau“**, teda prevádzkovať službu pre cudzích na tvojom kľúči. Rodina a známi na tvojom účte sú v poriadku. Model, kde má každý zákazník **vlastný Soniox účet a kľúč**, podmienky nezakazujú, ale **treba si to písomne potvrdiť u Sonioxu** (partnerský program som nenašiel).
3. **Soniox nemá limit výdavkov na projekt.** Náklady každého zákazníka musí strážiť tvoj server. To už vieš: limity na osobu a mesačný strop.
4. **GDPR a zodpovednosť:** pre rodinu platí výnimka pre osobné použitie (recitál 18 GDPR). Keď to robíš pre iných, a najmä za peniaze, stávaš sa prevádzkovateľom. Potrebuješ:
   - informácie o spracovaní (zvuk ide do Sonioxu),
   - kontakt a identifikáciu prevádzkovateľa (zákon č. 22/2004 Z. z.),
   - zmluvu so Sonioxom o spracovaní (DPA je v Soniox Console),
   - upozornenie, že druhá osoba je prekladaná.

   *Toto nie je právna rada. Pred platenou službou to over u právnika.*
5. **Podpora:** každý ďalší používateľ znamená otázky, výpadky a aktualizácie. Pri známych sa to rýchlo zmení na prácu zadarmo.

### Odporúčaná cesta
1. **Teraz:** appku používaj ako vizitku. Známym môžeš dať prístup cez admin (vlastný účet, limity), a to **na tvojom účte, bez peňazí**. To je v súlade s podmienkami aj s výnimkou GDPR pre osobné použitie, pokiaľ ide o úzky okruh.
2. **Ak bude záujem:** pre konkrétneho človeka alebo firmu **samostatná inštancia**: vlastná Fly appka a **jeho vlastný Soniox účet a kľúč**. Ty spravíš nastavenie a údržbu (jednorazovo alebo mesačný poplatok). Žiadne spoločné dáta medzi zákazníkmi a náklady platí priamo on. Pred tým písomný súhlas Sonioxu.
3. **Nie teraz:** verejná služba pre cudzích na jednom serveri a jednom kľúči (SaaS). Potrebovala by zmluvu so Sonioxom, platby, právne dokumenty a podporu.

### Na čo sa sústreďujú dobrí tvorcovia appiek
Väčšinu už máš. Chýbajúce body sú označené **→**.

| Oblasť | Stav |
|---|---|
| Spoľahlivosť (výpadky siete, obnova) | v3.2.1 ✔ |
| Bezpečnosť (heslá, roly, audit, limity) | v3.3.0 ✔ |
| Súkromie (texty sa neukladajú na server) | ✔ → napísať to v „O aplikácii“ |
| Rýchlosť prekladu merateľne | → L0 meranie latencie z plánu |
| Jednoduché prihlásenie | → passkey (A4) |
| Dôvera (kto appku robí, verzia, kontakt) | → „O aplikácii“ |
| Spätná väzba od používateľov | → tlačidlo „Nahlásiť problém“ (e-mail s verziou appky, bez textu rozhovoru) |
| Prvé spustenie (krátky návod v 3 krokoch) | → voliteľné, pre známych užitočné |
| Testovanie na reálnych telefónoch | → matica T1–T3 z plánu |

---

## 4. Navrhované vydanie v3.4.0

| Poradie | Obsah | Náročnosť |
|---|---|---|
| 1 | **A4 passkey:** prihlásenie odtlačkom alebo Face ID, správa zariadení, admin prehľad | M |
| 2 | **O aplikácii + podpis** na prihlasovacej obrazovke (príbeh dodáš ty) | S |
| 3 | **Nahlásiť problém** (mailto s verziou a zariadením, bez textu rozhovoru) | S |

Neskôr podľa plánu z `perfection-plan-2026-10-26.md`: meranie latencie (L0), ladenie endpointu (L1), príprava hlasu počas reči (L2), vylepšenia režimu „oproti sebe“.

---

## 5. Rozhodnutia používateľa (26. 10. 2026, po návrhu)

- **„O aplikácii“, príbeh ani „Vyrobené na Slovensku“ sa nerobia.** V appke bude iba meno autora na úvodnej obrazovke, vložené do dizajnu.
- **Passkey (A4) áno.** Zapína sa v Nastaveniach. Tlačidlo na úvodnej obrazovke sa zobrazí iba na zariadení, kde je zapnuté. Meno a heslo ostávajú ako záloha.
- **Zamykanie appky biometriou ani „Nahlásiť problém“ sa nerobia.**
- **Konkurencia:** používateľ Google porovnal sám. Soniox je podľa neho rýchlejší a lepšie rozumie nepresnej reči, takže appka ostáva na Sonioxe.
- **Appka ostáva súkromná:** autor a rodina (brat, mama, bratranec, ujo) napríklad na dovolenke. Biznis pre iných sa zatiaľ nerobí.

## 6. Nový nápad: režim „Počúvanie“ (ako v Google Translate)

**Čo to je:** appka iba počúva okolie (lekár, úrad, film, ľudia v miestnosti) a cudziu reč ti priebežne prekladá do slovenčiny. Nečaká, kým hovoríš ty, a nestrieda smery.

**Je to reálne?** Áno, väčšina už v appke je:
- Soniox `one_way` preklad do slovenčiny sa dnes používa pri „Rozpoznať jazyk“.
- Priebežný hlas do slúchadiel s otvoreným mikrofónom už funguje v režime „Slúchadlá“.
- Server už ignoruje reč v tvojom jazyku, takže tvoj vlastný slovenský hlas ani preklad z reproduktora sa nebudú prekladať dokola.

**Ako by to vyzeralo:**
- Na hlavnej obrazovke prepínač **Konverzácia | Počúvanie**.
- V režime Počúvanie zvolíš jazyk, ktorý počúvaš (alebo automaticky), a preklad ide vždy do tvojho jazyka.
- Veľké živé titulky: preklad veľkým písmom, originál malým.
- Výstup: **Slúchadlá** (odporúčané, hlas ide do uší a mikrofón stále počúva), **Iba titulky** (potichu, napríklad u lekára) alebo **Reproduktor** (s obmedzením nižšie).

**Úprimné obmedzenia:**
- **„Telefón pri uchu ako pri hovore“ webová appka nevie zaručiť.** Prehliadač nedovolí vybrať slúchadlo pri uchu namiesto reproduktora.
  - Na iPhone pri zapnutom mikrofóne zvuk niekedy sám ide do slúchadla pri uchu.
  - Na Androide väčšinou hrá reproduktor.
  - Treba otestovať na tvojich telefónoch. Istota sú slúchadlá alebo titulky.
- **Dlhé počúvanie (film, dlhá návšteva):** dnes sa rozhovor po 30 min ukončí. Pre Počúvanie treba plynulé pokračovanie bez prerušenia titulkov.
- **Spotreba:** rozpoznávanie beží nepretržite, ~0,12 $/h, plus hlas ~0,70 $ za hodinu vygenerovanej reči. Dvojhodinový film s veľa dialógmi vyjde zhruba na 1 $. Pozor na denný limit 180 min rozpoznávania (v Správe sa dá zvýšiť).
- **Súkromie:** prekladať pre vlastné porozumenie je bežné. Titulky iných ľudí si neukladaj bez ich vedomia. Appka ich na server neukladá.

**Náročnosť:** M (1–2 dni). Server: režim `listen` s pevným alebo automatickým zdrojovým jazykom, bez potvrdzovania jazyka, s plynulým pokračovaním po 30 min. Klient: prepínač režimov, titulky, výber výstupu.

**Odporúčanie:** spraviť ako **v3.5.0** až po tom, čo otestuješ v3.4.0 (passkey). Je to posledná funkcia, ktorú má zmysel pridať, a dobre dopĺňa „Konverzáciu“.

## Zdroje
- Soniox: [Terms of Service](https://soniox.com/policies/terms-of-service), [Soniox App Translator](https://soniox.com/soniox-app/translator), [cenník appky](https://soniox.com/soniox-app/pricing), [cenník API](https://soniox.com/pricing), [data residency](https://soniox.com/docs/data-residency), [concurrency limits](https://soniox.com/docs/guides/concurrency-limits)
- Google: [Gemini 3.5 Live Translate](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-live-3-5-translate/)
- DeepL: [Pro service specifications](https://www.deepl.com/en/pro-service-specifications)
- Samsung: [Live Translate languages](https://www.samsung.com/ae/support/mobile-devices/how-many-languages-does-the-live-translate-feature-support/)
- Timekettle: [W4 Pro](https://www.timekettle.co/products/w4-gift-set)
- Apple v EÚ (tretia strana): [trendingtopics.eu](https://www.trendingtopics.eu/airpods-pro-3-no-ai-based-live-translations-for-apple-users-in-the-eu/)
- WebAuthn: [MDN getPublicKey](https://developer.mozilla.org/en-US/docs/Web/API/AuthenticatorAttestationResponse/getPublicKey), [web.dev registrácia](https://web.dev/articles/passkey-registration), [web.dev autofill](https://web.dev/articles/passkey-form-autofill), [W3C WebAuthn L3](https://www.w3.org/TR/webauthn-3/), [WebKit bug 312081](https://bugs.webkit.org/show_bug.cgi?id=312081)
- GDPR: [recitál 18](https://gdpr-info.eu/recitals/no-18/)
