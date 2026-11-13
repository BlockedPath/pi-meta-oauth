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

Pi 0.99+ types `ProviderConfig.models` as a union of chat, image, and classifier
configs. `MetaProviderModel` in `src/meta/types.ts` narrows that element type to
the chat member before applying `Omit`, which keeps `reasoning`,
`thinkingLevelMap`, `contextWindow`, and `maxTokens` on every supported Pi
version (the narrowing is a no-op on Pi 0.83–0.87). Tests that read models back
out of a `ModelsStoreEntry` must narrow the same way, since that list holds
every model type on Pi 1.x. The Pi matrix lives in
`.github/workflows/pi-compatibility.yml`, which both CI and Publish call, so a
tag is verified against every leg and only publishes from a commit on `main`.
It pins each supported Pi line; the `lockfile` leg tests the committed dev pin
without a reinstall. Add a leg when widening the peer range, and add the old pin
as its own leg when bumping the dev pin past a line that must stay covered.

Use `bun run check` for lint, strict typecheck, and hermetic tests. `bun run test`
runs through `scripts/test.ts`, which strips credentials and isolates the child
home without changing the caller. Direct `bun test` bypasses that isolation, but
the billable live probes still skip: `tests/live-key.ts` resolves no credential
unless `PI_META_LIVE=1`, which `bun run test:live` sets and the hermetic runner
strips. The variable is the gate, so never export it or set it by hand.
Live mode keeps credentials and the Pi home, and blanks `META_MUSE_USER_AGENT`
and `META_TOOL_ALIASES` so the wire-name assertions stay deterministic.
Run `bun run test:live` only when live billable probes are explicitly requested.

Every credential-bearing request (device flow, key mint, model catalog) goes
through `requestJson()` in `src/meta/http.ts`: one timeout covering the body
read, and `redirect: "manual"` so a token or key is never resent elsewhere. The
catalog request has its own `META_CATALOG_TIMEOUT_MS`; that timeout is not a host
cancellation, so it restores and republishes the cached catalog.
Install dependencies with `bun install --frozen-lockfile`.

## OAuth flow

`/login meta` uses the device flow at `https://auth.meta.com`, then exchanges the identity token through `POST https://api.meta.ai/muse-code/key`. Pi stores the identity token as `refresh`, the minted Model API key as `access`, and refreshes that key daily.

Keep both Pi refresh-context shapes working:

- Pi 0.83: mutable `store` read/write API
- Pi 0.84: immutable `stored` snapshot plus generation-checked `publish`

On Pi 0.86.1+, Pi's built-in pi.dev `meta` catalog overlay refreshes before this extension through the same `models-store.json` entry. Keep persisted entries marked with `lastModified: 0` and `source: "pi-meta-oauth"`, restore only owned (or legacy unmarked) entries, and pin restored `baseUrl` to `https://api.meta.ai/v1`. `tests/model-runtime.test.ts` drives the real Pi `ModelRuntime` and skips on Pi versions without the built-in provider.

Hermetic OAuth and catalog tests live in `tests/meta.test.ts`. Failure-path and wire-shape tests (exact error messages, polling back-off, request shapes, catalog fallbacks, bundled model table) live in `tests/meta-failures.test.ts`.

## Prompt caching

Muse Spark on `api.meta.ai` returns no useful cache hits on `/v1/chat/completions`. Keep the provider on `/v1/responses` and preserve `applyMetaResponsesCacheHints()` in the provider's request-local `streamSimple` adapter, after the caller's payload callback. It sets `prompt_cache_retention: "24h"` only when the payload has no explicit retention and removes `reasoning` when effort is `"none"` or missing because Meta rejects that shape. Do not use session-scoped request hooks for these adjustments: `ctx.model` can change while a request is in flight.

`tests/meta-cache.test.ts` contains hermetic wire-contract coverage plus an optional live cache probe. The live probe resolves a key from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or an unexpired `meta.access` entry in Pi's `auth.json` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). It makes real billable requests under `bun run test:live` whenever a credential resolves; do not put a live key in CI.

`forwardMetaStream()` in `src/meta/provider.ts` must always settle downstream:
an upstream that ends without `done` or `error`, or a throw while sending,
becomes an error event. It is exported for `tests/meta-cache.test.ts`, not from
the entrypoint.

## Tool name aliases

Keep tool-name translation request-local in `src/meta/tool-aliases.ts`, after the
caller's payload callback and scoped to the actual Meta model's direct endpoint.
Translate definitions, replayed calls, and explicit choices together; restore Pi
names in every stream event and final result without mutating the caller's tools
or transcript. Preserve a live downstream partial without sharing upstream tool
blocks, which can acquire new wire names between events. Cover collisions,
concurrent requests, and multi-turn replay in `tests/tool-aliases.test.ts`.
`META_TOOL_ALIASES` (`name=alias` pairs, `name=` disables) merges over the
built-in table through `resolveToolAliases()`, read per request; the hermetic
runner strips it so a developer export cannot change wire-name assertions.

## Muse User-Agent opt-in

`muse-spark-1.3-contributor` accepts reasoning effort `max` only with the captured Muse CLI `User-Agent` (`MUSE_USER_AGENT`); `muse-wonder-1.0-contributor` and `muse-wonder-full-1.0-contributor` are gated the same way. Keep this strictly opt-in via `META_MUSE_USER_AGENT`: the stream adapter must use the actual request model to scope headers to the Meta provider, the models in `MUSE_USER_AGENT_MODEL_IDS`, and the direct `https://api.meta.ai/v1` endpoint, and it must never override an explicit `User-Agent`. Route every model list (fallbacks, catalog, cached restore) through `gateMuseMaxEffort()` so Contributor `max` is exposed only when opted in. The standard Wonder models (`muse-wonder-1.0`, `muse-wonder-full-1.0`) get unconditional `max` from `MAX_EFFORT_MODEL_IDS` in the same gate, and their bundled definitions in `models.ts` agree. Tests that depend on the flag must use `tests/muse-env.ts` to stay hermetic.

## Catalog policy

Since at least 2026-10-23, `GET https://api.meta.ai/v1/models` returns bare `{id, object, created, owned_by}` entries with no `metadata["muse-code"]` block for any model, regardless of `x-api-version` or `User-Agent`. Names, prices, image input, and `max` support for known IDs therefore come from `FALLBACK_DEFINITIONS` in `src/meta/models.ts`; add a definition there when Meta ships a new chat model. Wonder Full and the Wonder Contributor variants are Muse Code subscription only with no published per-token rate, so they carry a zero cost on purpose.

The catalog also lists non-token models that Meta bills per generated image (`muse-image-*`), per hour of audio (`muse-voice-*`), or per video frame (`sam-*`). `isNonChatModelId()` filters those families by prefix in both `toProviderModels()` and `restoreProviderModels()`, so a new version stays hidden without a code change and an entry cached by an earlier release disappears on restore. Keep the filter prefix-based. On restore, bundled IDs take name, cost, and input from `FALLBACK_DEFINITIONS` (a cached copy is an older release's bundled value or its default) and keep cached limits, effort names, headers, and compat; unknown IDs restore every cached field.

Every live probe must resolve its key through `tests/live-key.ts` (env, then an unexpired `meta.access` in Pi's agent-dir `auth.json`) so a plain `bun run test:live` runs all of them and no run without `PI_META_LIVE=1` can reach a live credential; the catalog canary in `tests/meta.test.ts` fails when a live ID has neither a bundled definition nor a non-chat prefix.
