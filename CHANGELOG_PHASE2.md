# Phase 2 — production credit guard

## Version

`2.3.0-production-credit-guard`

## Main changes

- Daily per-user quotas for sessions, audio MB, TTS requests, and TTS audio MB.
- Global active WebSocket connection limit.
- Per-IP active WebSocket connection limit.
- `/api/usage` endpoint for logged-in user usage.
- Usage display in the app header.
- Idle timeout for inactive conversations.
- Timeout for WebSocket clients that do not send config.
- Timeout for Soniox STT connection setup.
- WebSocket ping/pong heartbeat.
- Rate limit for voice preview TTS.
- TTS playback timeout to avoid permanent muted state.
- More detailed metrics logs with usage snapshots.

## Notes

Usage counters are in-memory and reset when the process restarts. This is sufficient for a private Fly.io app, but a future multi-user/public version should store quotas in a database or durable KV store.
