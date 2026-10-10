# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Fix `Cannot find module '@earendil-works/pi-ai/api/openai-responses'` when Pi loads the installed extension. The provider now imports its Responses streamer from `@earendil-works/pi-ai/compat`, which Pi's extension loader exposes on Pi 0.83 and later.

## [0.7.1] - 2026-10-10

### Changed

- Split the extension into focused OAuth, model validation, persistence, provider, and request-policy modules while preserving the registered entrypoint and named exports.
- Add strict indexed-access checks, Biome lint/format checks, a committed Bun lockfile, and shared local/CI verification through `bun run check`.
- Make `bun run test` credential-free with an isolated child environment and home; retain optional billable probes through `bun run test:live`.

### Fixed

- Honor login cancellation throughout device authorization, polling, and key minting, and stop polling when the device code expires.
- Report a cancelled `/login meta` as `Login cancelled`, the exact message Pi's login dialog treats as a user cancel, so pressing Escape no longer shows a "Failed to login" error.
- Follow a longer server-supplied `interval` on `slow_down` (still adding at least 5 seconds per RFC 8628), and never poll the token endpoint more than once per second, matching Pi's built-in device-code poller.
- Validate malformed catalog and credential responses and return independent fallback/cache model metadata.
- Require Contributor literal `max` opt-in even when the catalog advertises it, and limit the Muse fingerprint to the bare direct endpoint.
- Keep the Meta catalog in `models-store.json` on Pi 0.86.1 and later, where Pi's built-in pi.dev `meta` overlay shares the store entry and refreshes first. The extension persists its catalog with `lastModified: 0` and a `source` marker so the overlay skips pi.dev while the Meta catalog is fresh. It ignores overlay-written entries on restore, republishes its last good catalog after a failed Meta refresh, and always restores `https://api.meta.ai/v1` as the base URL.
- Bound each device-authorization, token-poll, and key-mint request to 30 seconds, and token polls also to the device-code deadline, so a stalled connection fails with a timeout or expiry error instead of hanging login or Pi 0.83 refreshes.
- Report Pi's refresh timeout as `Meta token refresh timed out` instead of a cancellation.
- Accept only http(s) verification and setup URLs from Meta, normalized like Pi's built-in Meta login so control characters cannot reach the terminal.
- Bind Responses cache hints and the opt-in Muse fingerprint to the in-flight request's model and endpoint, so switching the session model cannot modify another provider's request or skip Meta's adjustments. Preserve explicit header overrides and caller-replaced payloads ([#29](https://github.com/BlockedPath/pi-meta-oauth/pull/29)).
- Treat an empty or blank `META_API_KEY` or `MODEL_API_KEY` as unset when mirroring the two aliases.
- Point the README install command at the npm package or `main` instead of the stale v0.6.0 `meta-oauth-only` branch.

## [0.7.0] - 2026-09-26

### Added

- Reasoning effort `max` on `muse-spark-1.3` (live-verified 2026-09-06). Catalog entries without `variants.max` inherit it from the bundled fallback, while server-advertised values still win ([#13](https://github.com/BlockedPath/pi-meta-oauth/pull/13) by [@KSonny4](https://github.com/KSonny4)).
- Opt-in `META_MUSE_USER_AGENT=1` exposes reasoning effort `max` on `muse-spark-1.3-contributor` and sends the captured Muse CLI `User-Agent` on that model's direct `https://api.meta.ai/v1` requests, which Meta requires for Contributor `max`. Off by default. Other models, proxies, and explicit `User-Agent` headers are untouched. This identifies Pi as Meta's first-party client and is unsupported by Meta; see the README warning ([#20](https://github.com/BlockedPath/pi-meta-oauth/pull/20) by [@AdityaVG13](https://github.com/AdityaVG13)).

### Changed

- Support Pi 0.85: widen the peer ranges and typecheck/test against 0.85.1 ([#18](https://github.com/BlockedPath/pi-meta-oauth/pull/18) by [@antonioc-cl](https://github.com/antonioc-cl)).
- Support Pi 0.86 and 0.87: widen the `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` peer ranges to `>=0.83.0 <0.88.0` and typecheck/test against 0.87.1. The extension still overrides Pi's built-in `meta` provider on 0.87.1 ([#21](https://github.com/BlockedPath/pi-meta-oauth/pull/21)).

## [0.6.1] - 2026-09-04

### Fixed

- Direct expired Meta identity-token sessions back to `/login meta` when API-key minting returns HTTP 401 or 403.

## [0.6.0] - 2026-09-04

### Removed

- Voice dictation, platform audio helpers, and Meta ASR integration from the OAuth-only branch.
- Media analysis tools, commands, upload helpers, and request rewriting from the OAuth-only branch.
- Unused `@earendil-works/pi-tui` and `typebox` runtime peer dependencies.

### Changed

- Register only `extensions/meta.ts` and advertise only Pi-native text and image model inputs.

## [0.5.0] - 2026-09-03

### Added

- Send `prompt_cache_retention: "24h"` on Meta Responses requests (chat hook and direct media calls). Muse prompt caching is opt-in and measured ~0% on `/chat/completions` vs 93–99% on `/responses` with this hint.
- Strip `reasoning.effort: "none"` from outbound payloads — Meta 400s on it.
- Hermetic wire-contract tests for the Responses URL, retention setdefault/override, reasoning omit/passthrough, session `prompt_cache_key` stability, contributor cache pricing, and the ASR handshake JSON.
- Optional live prompt-cache probe (`PI_META_LIVE_API_KEY`, or any already-available Meta credential) that performs two identical Responses calls — plus one retry on a cache miss — and asserts `cached_tokens`.
- Bundled model metadata for `muse-spark-1.3` and `muse-spark-1.3-contributor`.

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

[Unreleased]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.4.3...v0.4.4
