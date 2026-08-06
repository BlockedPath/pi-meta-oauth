# pi-meta-oauth — maintainer notes

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

Voice is macOS-only. The Swift helper (`extensions/voice/macos-audio.swift`,
plus `Info.plist` / `Entitlements.plist`) must stay in the published tarball —
`package.json` `files` includes `extensions/`, and a test asserts the resources
are present.
