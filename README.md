<img width="3840" height="2160" alt="Meta-Symbol" src="https://github.com/user-attachments/assets/a3074df9-ad80-40ca-b9b9-944b96dda192" />

# pi-meta-oauth

<!-- markdownlint-disable-next-line MD013 -->
![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/blockedpaths?style=flat&link=https%3A%2F%2Fx.com%2FBlockedPaths)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/BlockedPath/pi-meta-oauth?style=social)](https://github.com/BlockedPath/pi-meta-oauth/stargazers) [![Last Commit](https://img.shields.io/github/last-commit/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/commits/main) [![Issues](https://img.shields.io/github/issues/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/issues) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/BlockedPath/pi-meta-oauth/pulls) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://www.conventionalcommits.org/en/v1.0.0/) [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/) [![CI](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml) [![Pi compatible](https://img.shields.io/badge/pi-Compatible-blueviolet)](https://pi.dev)

Meta Model API OAuth for [pi](https://pi.dev).

- Use Muse Spark models through Pi's `openai-responses` provider (not `/chat/completions` — Muse prompt cache is ~0% there)
- Send `prompt_cache_retention: "24h"` on Meta Responses requests unless the payload already set a retention
- Device authorization against `https://auth.meta.com`
- Model API-key minting through `POST https://api.meta.ai/muse-code/key`
- Dynamic Muse model catalog from `GET https://api.meta.ai/v1/models`

## Install

```bash
# OAuth-only branch
pi install git:github.com/BlockedPath/pi-meta-oauth@meta-oauth-only

# Or from a local checkout
pi install /absolute/path/to/pi-meta-oauth

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

## Models

Fallback models use a 1,048,576-token context window, up to 256K output tokens, image input, and reasoning levels `minimal`, `low`, `medium`, `high`, and `xhigh`.

| id | pricing (input/output/cached) $/M |
| --- | --- |
| `muse-spark-1.3` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.3-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.2` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.2-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.1` | 1.25 / 4.25 / 0.15 |

> **Contributor-model privacy:** discounted contributor models allow Meta to use prompts and completions for product improvement, including training future Meta models. Use a standard model such as `muse-spark-1.3` if you do not want the contributor terms. See [Meta's model documentation](https://dev.meta.ai/docs/models).

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
pi -p --provider meta --model muse-spark-1.3 "Reply exactly: META_OK"
bun run typecheck
bun test
```

`bun test` is hermetic unless a Meta credential is already available. The live cache-hit probe makes real billable API calls when a credential resolves: two identical `/v1/responses` calls (asserting `cached_tokens` on the second), plus one 2s retry if that second call misses cache. The credential is resolved, in order, from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or the minted key from `~/.pi/agent/auth.json` after `/login meta` (skipped if expired). OAuth is enough — you do not need a separate key. Skipped when no valid credential exists (CI):

```bash
bun test tests/meta-cache.test.ts
# or, if you are not logged in:
PI_META_LIVE_API_KEY='LLM|...' bun test tests/meta-cache.test.ts
```
