# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Send `prompt_cache_retention: "24h"` on Meta Responses requests (chat hook and direct media calls). Muse prompt caching is opt-in and measured ~0% on `/chat/completions` vs 93–99% on `/responses` with this hint.
- Strip `reasoning.effort: "none"` from outbound payloads — Meta 400s on it.
- Hermetic wire-contract tests for the Responses URL, retention setdefault/override, reasoning omit/passthrough, session `prompt_cache_key` stability, contributor cache pricing, and the ASR handshake JSON.
- Optional live prompt-cache probe (`PI_META_LIVE_API_KEY`, or any already-available Meta credential) that performs two identical Responses calls — plus one retry on a cache miss — and asserts `cached_tokens`.

## [0.4.4] - 2026-08-17

### Added

- Persist the live Meta catalog to `~/.pi/agent/models-store.json` after a successful network refresh, so external usage tools can show context-window percentages.
- Restore that cached catalog when Pi starts offline or without a Meta API key; bundled fallbacks remain the last resort.
- Compatibility adapter for both Pi 0.83 (`store` read/write) and Pi 0.84 (`stored` / `publish`).
- Contributor-model privacy note for `muse-spark-1.2-contributor`.
- Documented `MUSE_VOICE_ASR_ENDPOINT` / `MUSE_VOICE_ASR_MODEL` aliases (`PI_META_*` takes precedence).

### Fixed

- Treat Pi 0.84's `AbortSignal` as token-refresh cancellation instead of a `fetch` mock, so `/login meta` key rotation works on Pi 0.84.2.
- Do not persist or publish an empty catalog; restore the previous cache when a refresh returns no models or fails on the network.
- Force `store:false` and Files API promotion for large media in tool `output` arrays and ordinary `input_image` data URLs, avoiding Meta's ~20 MB `store=true` 413 limit.
- Rewrite media HTTPS URLs that include query strings or fragments.
- Validate video/audio MIME types from the full source URL, not only the path suffix.
- Honor abort signals on Files API uploads and check the 1 GiB size limit before buffering the file.
- Stage macOS codesign and Windows `csc` output so a failed helper compile cannot leave a half-built binary that skips later signing.
- Sample every 16-bit PCM frame in the voice meter (2-byte stride, not 4).
- Complete a voice session on ASR close only for normal close codes 1000/1005.

### Changed

- Split media internals into `extensions/media/{limits,mime,files,responses,payload}.ts`.
- Split voice ASR/auth/PCM and helper builds into `extensions/voice/asr.ts` and `extensions/voice/helpers.ts`.
- Pi entrypoints are unchanged: `extensions/meta.ts`, `extensions/media.ts`, `extensions/voice.ts`.
- Document that the catalog cache is written during interactive/RPC startup and after `/login meta`. `pi --list-models meta` lists models but does not trigger a network catalog refresh.

[0.4.4]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.4.3...v0.4.4
