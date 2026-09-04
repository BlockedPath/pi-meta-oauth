# pi-meta-oauth — OAuth-only branch maintainer notes

## Branch contract

This branch intentionally ships only the Meta OAuth/provider extension:

- `package.json` registers only `extensions/meta.ts`.
- Do not add voice capture, media tools, slash commands, helper binaries, or platform-specific assets.
- Keep runtime dependencies limited to what `extensions/meta.ts` imports.

The extension owns the complete login/provider flow: Meta device authorization, identity-token polling, Model API-key minting and refresh, Muse model discovery, and provider request compatibility hints.

## OAuth flow

`/login meta` uses the device flow at `https://auth.meta.com`, then exchanges the identity token through `POST https://api.meta.ai/muse-code/key`. Pi stores the identity token as `refresh`, the minted Model API key as `access`, and refreshes that key daily.

Keep both Pi refresh-context shapes working:

- Pi 0.83: mutable `store` read/write API
- Pi 0.84: immutable `stored` snapshot plus generation-checked `publish`

Hermetic OAuth and catalog tests live in `tests/meta.test.ts`.

## Prompt caching

Muse Spark on `api.meta.ai` returns no useful cache hits on `/v1/chat/completions`. Keep the provider on `/v1/responses` and preserve `applyMetaResponsesCacheHints()` in the `before_provider_request` hook. It sets `prompt_cache_retention: "24h"` only when the payload has no explicit retention and removes `reasoning` when effort is `"none"` or missing because Meta rejects that shape.

`tests/meta-cache.test.ts` contains hermetic wire-contract coverage plus an optional live cache probe. The live probe resolves a key from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or an unexpired `meta.access` entry in `~/.pi/agent/auth.json`. It makes real billable requests whenever a credential resolves; do not put a live key in CI.
