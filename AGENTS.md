# pi-meta-oauth — OAuth-only branch maintainer notes

## Branch contract

This branch intentionally ships only the Meta OAuth/provider extension:

- `package.json` registers only `extensions/meta.ts`.
- Do not add voice capture, media tools, slash commands, helper binaries, or platform-specific assets.
- Keep runtime dependencies limited to what `extensions/meta.ts` imports.

The extension owns the complete login/provider flow: Meta device authorization, identity-token polling, Model API-key minting and refresh, Muse model discovery, and provider request compatibility hints.

## Module boundaries and verification

Keep `extensions/meta.ts` as the only extension entrypoint. Supporting runtime
modules live under `src/meta/`, which must remain included in the package's
`files` list. Keep provider wiring, OAuth, model decoding, persistence, and
request policy separate; preserve the entrypoint's existing named exports.

Use `bun run check` for lint, strict typecheck, and hermetic tests. `bun run test`
runs through `scripts/test.ts`, which strips credentials and isolates the child
home without changing the caller. Direct `bun test` bypasses that protection.
Run `bun run test:live` only when live billable probes are explicitly requested.
Install dependencies with `bun install --frozen-lockfile`.

## OAuth flow

`/login meta` uses the device flow at `https://auth.meta.com`, then exchanges the identity token through `POST https://api.meta.ai/muse-code/key`. Pi stores the identity token as `refresh`, the minted Model API key as `access`, and refreshes that key daily.

Keep both Pi refresh-context shapes working:

- Pi 0.83: mutable `store` read/write API
- Pi 0.84: immutable `stored` snapshot plus generation-checked `publish`

On Pi 0.86.1+, Pi's built-in pi.dev `meta` catalog overlay refreshes before this extension through the same `models-store.json` entry. Keep persisted entries marked with `lastModified: 0` and `source: "pi-meta-oauth"`, restore only owned (or legacy unmarked) entries, and pin restored `baseUrl` to `https://api.meta.ai/v1`. `tests/model-runtime.test.ts` drives the real Pi `ModelRuntime` and skips on Pi versions without the built-in provider.

Hermetic OAuth and catalog tests live in `tests/meta.test.ts`. Failure-path and wire-shape tests (exact error messages, polling back-off, request shapes, catalog fallbacks, bundled model table) live in `tests/meta-failures.test.ts`.

## Prompt caching

Muse Spark on `api.meta.ai` returns no useful cache hits on `/v1/chat/completions`. Keep the provider on `/v1/responses` and preserve `applyMetaResponsesCacheHints()` in the `before_provider_request` hook. It sets `prompt_cache_retention: "24h"` only when the payload has no explicit retention and removes `reasoning` when effort is `"none"` or missing because Meta rejects that shape.

`tests/meta-cache.test.ts` contains hermetic wire-contract coverage plus an optional live cache probe. The live probe resolves a key from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or an unexpired `meta.access` entry in `~/.pi/agent/auth.json`. It makes real billable requests whenever a credential resolves; do not put a live key in CI.

## Muse User-Agent opt-in

`muse-spark-1.3-contributor` accepts reasoning effort `max` only with the captured Muse CLI `User-Agent` (`MUSE_USER_AGENT`). Keep this strictly opt-in via `META_MUSE_USER_AGENT`: the `before_provider_headers` hook must stay scoped to the Meta provider, the models in `MUSE_USER_AGENT_MODEL_IDS`, and the direct `https://api.meta.ai/v1` endpoint, and it must never override an explicit `User-Agent`. Route every model list (fallbacks, catalog, cached restore) through `gateMuseMaxEffort()` so Contributor `max` is exposed only when opted in. Tests that depend on the flag must use `tests/muse-env.ts` to stay hermetic.
