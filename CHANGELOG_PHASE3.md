# CHANGELOG — fáza 3 audio stability

## 2.4.0-production-audio-stability

### Pridané

- Krátky pre-ready audio buffer vo frontende.
- Kontrola `ws.bufferedAmount` pred odoslaním audia.
- Presnejšie UI stavy počas pripájania a ukončovania streamu.
- Graceful Soniox finalization flow s fallback timeoutom.
- Nový env parameter `SONIOX_FINALIZE_TIMEOUT_SECONDS`.
- Držanie referencie na aktuálne prehrávaný audio element, aby sa dal korektne zastaviť.

### Upravené

- `session_finished` sa neposiela naslepo po pevnom čase; backend čaká na Soniox `finished` alebo close event.
- Pri `client_stop` sa najprv pošle Sonioxu empty frame, až potom sa konverzácia ukončuje.
- Frontend pri stopnutí čaká dlhšie, aby backend stihol získať finálne tokeny.

### Zachované

- Login/session z fázy 1.
- Credit guard a denné limity z fázy 2.
- EU endpointy a backend proxy model.
