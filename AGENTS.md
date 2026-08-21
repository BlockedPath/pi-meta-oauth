# pi-meta-oauth — maintainer notes

## Prompt cache lives on `/v1/responses` with an explicit 24h retention hint

Muse Spark on `api.meta.ai` returns **0 cached tokens** on `/v1/chat/completions` even with identical prefixes and the retention hint. `/v1/responses` with `prompt_cache_retention: "24h"` is the surface that actually caches (measured 93–99% on agentic workloads; contributor tier is $0.10/M input vs $0.002/M cached).

Pi-ai defaults `cacheRetention` to `"short"`, which **omits** the retention field even when `supportsLongCacheRetention` is true. Do not assume the default is 24h. We setdefault it in two places:

- `applyMetaResponsesCacheHints()` from the `before_provider_request` hook in `extensions/meta.ts`
- `callMetaResponses()` in `extensions/media/responses.ts` for direct media/tool calls

An explicit `prompt_cache_retention` already on the payload wins. The same helper deletes `reasoning` when `effort` is `"none"` / missing — Meta 400s on `reasoning: { effort: "none" }`. Fallback `thinkingLevelMap.off` is `null` so the common path never emits that key; the strip is defense in depth.

Hermetic wire-contract tests live at the top of `tests/meta-cache.test.ts`. They capture the pi-ai Responses payload via a mock `fetch` and do **not** hit the live endpoint. A green `bun test` does not prove cache hits still happen in production.

To measure production hits (Hermes's `cache=17009/17344 (98%)` bar):

```bash
bun test tests/meta-cache.test.ts
```

The probe resolves a key from `PI_META_LIVE_API_KEY` / `META_API_KEY` / `MODEL_API_KEY`, then `~/.pi/agent/auth.json` `meta.access` (the Model API key minted by `/login meta`; skipped if that token's `expires` is past). OAuth is enough. It POSTs the same ~4k-token prefix via `callMetaResponses` twice, plus one retry after 2s if the second call misses cache (so up to three POSTs), and asserts `cached_tokens > 0`. It makes real billable API calls whenever a credential resolves — including plain `bun test` on a logged-in machine. Skipped when no valid credential is available. Do not put a live key in CI.

## The Meta ASR endpoint is undocumented, unversioned, and can break without warning

Voice input (`extensions/voice.ts`) streams audio to an internal Meta endpoint
reverse-engineered from Muse Code. It is **not a public API**. There is no
contract, no version negotiation, and no deprecation path — a server-side change
can break voice for every user with no code change on our side.

**The dependency, all in `extensions/voice.ts`:**

| What | Value | Line |
| --- | --- | --- |
| Endpoint | `wss://shortwave.facebook.com/voyager/v1/asr/duplex` | 29–30 |
| Model | `prod_tbh` | 31 |
| Audio | 16 kHz mono PCM (`PCM_16KHZ`) | 476 |
| Auth scheme | `OAuth <key>` — **not** `Bearer` | `formatAuthorization`, 120 |

Handshake sent on socket open (`connectSocket`, ~472):

```json
{ "mode": "DEFAULT", "authorization": { "accessToken": "OAuth <key>" },
  "audioEncoding": "PCM_16KHZ", "model": "prod_tbh" }
```

The credential is the same Model API key minted by `extensions/meta.ts`. No
separate Muse login.

**Symptoms when it breaks** — both surface as user-visible failures, neither
distinguishes "endpoint moved" from "network down":

- `could not connect to Muse's Meta ASR service` — socket `error` event
- `Meta ASR connection closed (<code>)` — socket `close`, uses `event.reason` when present

**Escape hatches** (first wins):

- Endpoint: `PI_META_VOICE_ASR_ENDPOINT`, then `MUSE_VOICE_ASR_ENDPOINT`
- Model: `PI_META_VOICE_ASR_MODEL`, then `MUSE_VOICE_ASR_MODEL`

⚠️ The `MUSE_VOICE_*` aliases exist in code but are **not documented in the
README** — only the `PI_META_VOICE_*` pair is. Keep both working or document both.

`asrEndpoint()` (124) hard-rejects any scheme except `wss://`, with a single
exception for `ws://localhost` / `ws://127.0.0.1` for testing. An `https://`
override throws `Voice ASR endpoint is not a valid URL` / must-use-`wss` — this
is intentional, don't "fix" it by relaxing the check.

**When voice breaks, check in this order:** (1) is the endpoint still resolving,
(2) did the handshake shape change — compare against a current Muse Code build,
(3) is `prod_tbh` still a valid model name. Reproduce with
`PI_META_VOICE_ASR_ENDPOINT` pointed at a local `ws://localhost` echo server to
isolate transport from contract.

Tests cover URL construction, the `OAuth` prefix, PCM→meter math, and that the
macOS helper resources ship — they do **not** hit the live endpoint, so a green
`bun test` says nothing about whether the endpoint still works.

## Platform

Voice runs on **macOS and Windows** (Linux not yet supported). Two helpers are shipped and must
stay in the published tarball — `package.json` `files` includes `extensions/` and tests assert
they are present:

- macOS: Swift helper (`extensions/voice/macos-audio.swift` + `Info.plist` / `Entitlements.plist`) compiled with `xcrun swiftc` + `codesign`, emitting `~/.pi/agent/bin/pi-meta-oauth-voice-v1`
- Windows: C# helper (`extensions/voice/windows-audio.cs`) compiled with `csc.exe` to `~/.pi/agent/bin/pi-meta-oauth-voice-v1.exe` when a compiler is found; PowerShell fallback (`extensions/voice/windows-audio.ps1` via `Add-Type` + `winmm.dll` `waveIn*`) runs when no compiler is present. Both speak the same line-delimited JSON protocol (`ready`/`audio`/`stopped`/`error`) and 16 kHz mono s16le framing as the Swift helper. Keep the Windows pair in sync with the Swift helper when changing the protocol.

`voice.ts` defaults `enabled` on for `darwin` and `win32` (see `loadSettings` / `isSupportedPlatform`) and the `/voice-on` guard checks both platforms. If adding a new platform, update those guards and ship a helper that implements the JSON protocol.
