<img width="3840" height="2160" alt="Meta-Symbol" src="https://github.com/user-attachments/assets/a3074df9-ad80-40ca-b9b9-944b96dda192" />

# pi-meta-oauth

<!-- markdownlint-disable-next-line MD013 -->
![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/blockedpaths?style=flat&link=https%3A%2F%2Fx.com%2FBlockedPaths)
[![npm version](https://img.shields.io/npm/v/pi-meta-oauth)](https://www.npmjs.com/package/pi-meta-oauth) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/BlockedPath/pi-meta-oauth?style=social)](https://github.com/BlockedPath/pi-meta-oauth/stargazers) [![Last Commit](https://img.shields.io/github/last-commit/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/commits/main) [![Issues](https://img.shields.io/github/issues/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/issues) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/BlockedPath/pi-meta-oauth/pulls) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://www.conventionalcommits.org/en/v1.0.0/) [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/) [![CI](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml) [![Pi compatible](https://img.shields.io/badge/pi-Compatible-blueviolet)](https://pi.dev)

Meta Model API OAuth and Muse-style voice input for [pi](https://pi.dev).

- Use Muse Spark models through Pi's `openai-responses` provider (not `/chat/completions` — Muse prompt cache is ~0% there)
- Send `prompt_cache_retention: "24h"` on Meta Responses requests unless the payload already set a retention
- Device authorization against `https://auth.meta.com`
- Model API-key minting through `POST https://api.meta.ai/muse-code/key`
- Dynamic Muse model catalog from `GET https://api.meta.ai/v1/models`
- Toggle-based Meta voice dictation on macOS and Windows with a live green input meter

## Install

```bash
# Local checkout
pi install /absolute/path/to/pi-meta-oauth

# npm
pi install npm:pi-meta-oauth

pi --list-models meta
```

## Login

```text
/login meta
```

Pi displays a device code, opens the Meta authorization flow, and mints a Model API key. Credentials are stored by Pi in `~/.pi/agent/auth.json` under provider `meta`:

```json
{ "meta": { "type": "oauth", "refresh": "<identity>", "access": "<MODEL_API_KEY>", "expires": 123 } }
```

The access key is re-minted daily.

## Voice input

Voice mode runs on **macOS and Windows** (Linux is not yet supported). It uses the same Meta credential managed by this provider; a separate Muse login is not required.

1. Press **Alt+V** once to start recording.
2. Speak while the green microphone meter is visible in Pi's status bar.
3. Press **Alt+V** again to stop.
4. The transcript is inserted into Pi's editor for review before submission.

Commands:

- `/voice` — show voice status and privacy behavior
- `/voice-on` — enable the Alt+V shortcut
- `/voice-off` — disable voice input

Audio is captured only between the two Alt+V presses and streamed as 16 kHz mono PCM to Muse Code's internal Meta ASR endpoint. No local speech-recognition model is downloaded. The endpoint is undocumented and may change in a future Muse release.

**macOS:** uses `AVFoundation` via a Swift helper compiled with `xcrun swiftc` (first recording triggers the system microphone permission prompt).

**Windows:** uses `winmm.dll` `waveIn*` via a C# helper. On first run pi tries to compile `extensions/voice/windows-audio.cs` with `csc.exe` (in-box .NET Framework) to `~/.pi/agent/bin/pi-meta-oauth-voice-v1.exe` for best performance. If no compiler is found it falls back to `extensions/voice/windows-audio.ps1` executed with `powershell.exe -ExecutionPolicy Bypass` (PowerShell 5.1 inbox, or `pwsh` 7 if present) which compiles the same capture code at runtime via `Add-Type`. No extra install is required. If recording fails, check **Settings → Privacy & security → Microphone** that access is allowed for desktop apps.

Optional overrides (the `PI_META_*` name takes precedence):

- `PI_META_VOICE_ASR_ENDPOINT` (legacy alias: `MUSE_VOICE_ASR_ENDPOINT`)
- `PI_META_VOICE_ASR_MODEL` (legacy alias: `MUSE_VOICE_ASR_MODEL`)

## Media tools

Text-only Pi models can delegate media inspection to Muse Spark without switching models:

- `meta_analyze_file` inspects one or more images, PDFs, audio files, or videos. Use ordered `sources` with optional labels for comparisons such as before and after screenshots.
- `meta_describe_video` analyzes MP4 visuals and embedded audio.
- `meta_transcribe_audio` transcribes MP3 or WAV speech.
- `meta_upload_file` uploads a large or reusable file and returns a Meta `file_id`.

Give each analysis tool a task-specific prompt that asks for the evidence the calling model needs next. Analysis tools default to an 8,000-token Muse generation budget and accept `max_output_tokens` from 4,000 to 32,000. Inline tool output defaults to 20,000 characters and accepts `max_chars` up to 50,000. If a result is truncated, the complete text is saved to a temporary file so the agent can continue with Pi's `read` tool using `offset` and `limit`.

Automatic uploads made during analysis expire after 24 hours. Explicit `meta_upload_file` uploads expire after seven days by default; set `expires_after_seconds` to choose another supported duration or `retain: true` to keep a file without expiry.

Media tool failures are reported as failed Pi tool calls, allowing the calling model to retry or report the blocker. Media analysis is model-generated observation, so verify consequential details when another source is available.

## Models

Fallback models use a 1,048,576-token context window, up to 256K output tokens, image input, and reasoning levels `minimal`, `low`, `medium`, `high`, and `xhigh`.

| id | pricing (input/output/cached) $/M |
| --- | --- |
| `muse-spark-1.2` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.2-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.1` | 1.25 / 4.25 / 0.15 |

> **Contributor-model privacy:** the discounted contributor model allows Meta to use prompts and completions for product improvement, including training future Meta models. Use the standard `muse-spark-1.2` model if you do not want the contributor terms. See [Meta's model documentation](https://dev.meta.ai/docs/models).

To scope Pi's model picker to Meta models:

```json
{ "enabledModels": ["meta/*"] }
```

### Making context windows visible to external tools

After a successful network model refresh, the extension persists the Meta
catalog to `~/.pi/agent/models-store.json`. External usage tools such as
[herdr-agent-usage](https://github.com/senna-lang/herdr-agent-usage) can then
show a percentage (for example, `⛁ 2% (24k)`) instead of only an absolute token
count. Pi writes the cache during interactive or RPC startup, and again after
`/login meta`. `pi --list-models meta` lists currently available models but does
not itself trigger a network catalog refresh. The cached catalog is also used
when Pi starts without network access.

The bundled fallback uses Meta's nominal `1,048,576`-token context window. A
cached Muse Code 0.1.0/R708.1 catalog observed on 2026-08-06 reported a lower
effective limit of `1,007,997` for `muse-spark-1.2` and
`muse-spark-1.2-contributor`. If you need percentages to match that specific
Muse snapshot, you can still set `contextWindow: 1007997` for those models in
`~/.pi/agent/models.json`; model overrides take precedence over the persisted
catalog.

## Verify

```bash
pi --list-models meta
pi -p --provider meta --model muse-spark-1.2 "Reply exactly: META_OK"
bun run typecheck
bun test
```

`bun test` is hermetic unless a Meta credential is already available. The live cache-hit probe makes real billable API calls when a credential resolves: two identical `/v1/responses` calls (asserting `cached_tokens` on the second), plus one 2s retry if that second call misses cache. The credential is resolved, in order, from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or the minted key from `~/.pi/agent/auth.json` after `/login meta` (skipped if expired). OAuth is enough — you do not need a separate key. Skipped when no valid credential exists (CI):

```bash
bun test tests/meta-cache.test.ts
# or, if you are not logged in:
PI_META_LIVE_API_KEY='LLM|...' bun test tests/meta-cache.test.ts
```

## Publish to npm and pi.dev

The `pi-package` keyword makes the package discoverable at <https://pi.dev/packages>. Publishing is handled by `.github/workflows/publish.yml` when a `v*` tag is pushed. Each release publishes the canonical `pi-meta-oauth` package to npm and a scoped `@blockedpath/pi-meta-oauth` mirror to GitHub Packages.

Before the first automated release, configure npm trusted publishing for `pi-meta-oauth` with:

- GitHub owner: `BlockedPath`
- Repository: `pi-meta-oauth`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allowed action: `npm publish`

GitHub Packages uses the workflow's short-lived `GITHUB_TOKEN`. Its npm registry defaults new packages to private visibility; after the first publish, open the package settings on GitHub and change its visibility to **Public** if desired.

Bump `package.json`, commit the change, create a `v<version>` tag, and push the commit and tag. The workflow verifies that the tag matches the package version, runs typechecking and tests, publishes to both registries, and creates the GitHub Release. Re-running a partially completed workflow is safe when either registry reports that the same commit was already published.

Users can then update with:

```bash
pi update npm:pi-meta-oauth
```
