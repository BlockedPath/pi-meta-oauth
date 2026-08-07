<img width="3840" height="2160" alt="Meta-Symbol" src="https://github.com/user-attachments/assets/a3074df9-ad80-40ca-b9b9-944b96dda192" />

# pi-meta-oauth

<!-- markdownlint-disable-next-line MD013 -->
[![npm version](https://img.shields.io/npm/v/pi-meta-oauth)](https://www.npmjs.com/package/pi-meta-oauth) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/BlockedPath/pi-meta-oauth?style=social)](https://github.com/BlockedPath/pi-meta-oauth/stargazers) [![Last Commit](https://img.shields.io/github/last-commit/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/commits/main) [![Issues](https://img.shields.io/github/issues/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/issues) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/BlockedPath/pi-meta-oauth/pulls) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://www.conventionalcommits.org/en/v1.0.0/) [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/) [![CI](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml) [![Pi compatible](https://img.shields.io/badge/pi-Compatible-blueviolet)](https://pi.dev)

Meta Model API OAuth and Muse-style voice input for [pi](https://pi.dev).

- Use Muse Spark models through Pi's `openai-responses` provider
- Device authorization against `https://auth.meta.com`
- Model API-key minting through `POST https://api.meta.ai/muse-code/key`
- Dynamic Muse model catalog from `GET https://api.meta.ai/v1/models`
- Toggle-based Meta voice dictation on macOS with a live green input meter

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

Voice mode currently requires macOS. It uses the same Meta credential managed by this provider; a separate Muse login is not required.

1. Press **Alt+V** once to start recording.
2. Speak while the green microphone meter is visible in Pi's status bar.
3. Press **Alt+V** again to stop.
4. The transcript is inserted into Pi's editor for review before submission.

Commands:

- `/voice` — show voice status and privacy behavior
- `/voice-on` — enable the Alt+V shortcut
- `/voice-off` — disable voice input

The first recording may trigger the macOS microphone permission prompt. Audio is captured only between the two Alt+V presses and streamed as 16 kHz mono PCM to Muse Code's internal Meta ASR endpoint. No local speech-recognition model is downloaded. The endpoint is undocumented and may change in a future Muse release.

Optional overrides:

- `PI_META_VOICE_ASR_ENDPOINT`
- `PI_META_VOICE_ASR_MODEL`

## Models

Fallback models use a 1,048,576-token context window, up to 256K output tokens, image input, and reasoning levels `minimal`, `low`, `medium`, `high`, and `xhigh`.

| id | pricing (input/output/cached) $/M |
| --- | --- |
| `muse-spark-1.2` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.2-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.1` | 1.25 / 4.25 / 0.15 |

To scope Pi's model picker to Meta models:

```json
{ "enabledModels": ["meta/*"] }
```

## Verify

```bash
pi --list-models meta
pi -p --provider meta --model muse-spark-1.2 "Reply exactly: META_OK"
bun run typecheck
bun test
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
