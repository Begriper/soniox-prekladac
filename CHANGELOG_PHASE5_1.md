# Fáza 5.1 — Final hardening a polish

Verzia: `2.6.1-production-final-hardening`

## Zmeny

- Predvolená rýchlosť reakcie je teraz `500 ms` namiesto `900 ms`.
- `fly.toml` drží `min_machines_running = 1`, aby jedna machine ostala pripravená po pridaní platobnej karty.
- Pridané bezpečnostné HTTP hlavičky: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, COOP/CORP a HSTS v produkcii.
- Pridaný chránený endpoint `/api/diagnostics`.
- Usage hodnoty sú zaokrúhlené pre čitateľnejšie UI a diagnostiku.
- Logovanie blokovaného audia je rozdelené na `soniox_not_ready`, `tts_muted` a `finalizing`.
- Backend ignoruje duplicitné `playback_done` správy, aby sa nemazal mute stav dvakrát.
- Frontend má jednorazový handler ukončenia audia, aby neposielal duplicitné `playback_done`.

## Poznámka

TTS stále používa stabilný REST tok. TTS WebSocket nechávame na samostatnú výkonovú verziu až po reálnom meraní, či REST TTS nestačí.
