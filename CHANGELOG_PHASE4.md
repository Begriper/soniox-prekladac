# CHANGELOG — fáza 4: Conversation UX v4

Verzia: `2.5.0-production-conversation-ux`

Táto fáza nadväzuje na produkčné uzamknutie, credit guard a audio stability. Cieľom je lepší pocit pri reálnom rozhovore bez veľkého zásahu do jadra STT/TTS.

## Nové

- pridaný režim počúvania `Reproduktor` / `Slúchadlá`,
- v režime `Reproduktor` backend pri TTS naďalej stlmí mikrofón, aby sa aplikácia nepočúvala sama,
- v režime `Slúchadlá` backend počas TTS nestlmí mikrofón, takže konverzácia pôsobí plynulejšie,
- pridaný stavový panel: server/Soniox, mikrofón, prehrávanie, režim,
- pridané tlačidlo `Zopakovať hlas` pre posledný prijatý TTS audio buffer,
- pridané tlačidlo `Stop audio`, ktoré korektne nahlási backendu koniec prehrávania,
- pridané tlačidlo `Textový režim`, ktoré vypne hovorený výstup pre rýchle text-only testy,
- `play_audio` správa teraz obsahuje `generation_ms`, `tts_request_id` a `output_mode`,
- UI zobrazuje jednoduchú TTS odozvu.

## Poznámky

- Fáza 4 ešte neprechádza na Soniox TTS WebSocket; ostáva bezpečnejší REST TTS tok z predchádzajúcich verzií.
- Režim `Slúchadlá` je vhodný iba vtedy, keď reproduktor telefónu/notebooku nevracia TTS späť do mikrofónu.
- Režim `Reproduktor` ostáva bezpečný default.
