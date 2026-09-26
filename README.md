<img width="3840" height="2160" alt="Meta-Symbol" src="https://github.com/user-attachments/assets/a3074df9-ad80-40ca-b9b9-944b96dda192" />

# pi-meta-oauth

<!-- markdownlint-disable-next-line MD013 -->
![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/blockedpaths?style=flat&link=https%3A%2F%2Fx.com%2FBlockedPaths)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/BlockedPath/pi-meta-oauth?style=social)](https://github.com/BlockedPath/pi-meta-oauth/stargazers) [![Last Commit](https://img.shields.io/github/last-commit/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/commits/main) [![Issues](https://img.shields.io/github/issues/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/issues) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/BlockedPath/pi-meta-oauth/pulls) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://www.conventionalcommits.org/en/v1.0.0/) [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/) [![CI](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml) [![Pi compatible](https://img.shields.io/badge/pi-Compatible-blueviolet)](https://pi.dev)

Meta Model API OAuth for [pi](https://pi.dev).

- Use Muse Spark models through Pi's `openai-responses` provider (not `/chat/completions` — Muse prompt cache is ~0% there)
- Send `prompt_cache_retention: "24h"` on Meta Responses requests unless the payload already set a retention
- Optional, off by default: send the Muse CLI `User-Agent` on direct `muse-spark-1.3-contributor` requests so it accepts reasoning effort `max` (see [Contributor `max`](#contributor-max-opt-in))
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

Prefer a static key instead? Set `META_API_KEY` (or `MODEL_API_KEY`) and skip
`/login meta` entirely — requests use it directly.

## Models

Fallback models use a 1,048,576-token context window, up to 256K output tokens, image input, and reasoning levels `minimal`, `low`, `medium`, `high`, and `xhigh` (`muse-spark-1.3` additionally supports `max`; `muse-spark-1.3-contributor` does too when [opted in](#contributor-max-opt-in)).

| id | pricing (input/output/cached) $/M |
| --- | --- |
| `muse-spark-1.3` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.3-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.2` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.2-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.1` | 1.25 / 4.25 / 0.15 |

> **Contributor-model privacy:** discounted contributor models allow Meta to use prompts and completions for product improvement, including training future Meta models. Use a standard model such as `muse-spark-1.3` if you do not want the contributor terms. See [Meta's model documentation](https://dev.meta.ai/docs/models).

### Contributor `max` (opt-in)

Meta documents reasoning effort `max` for standard-tier `muse-spark-1.3` only. `muse-spark-1.3-contributor` rejects it (HTTP 400) unless the request carries the Muse CLI's `User-Agent` (observed 2026-09-25, same for API-key and `/login meta` credentials). To use it anyway, set `META_MUSE_USER_AGENT=1` (`true` and `yes` also work) in the environment Pi starts from:

| OS / shell | Enable permanently |
| --- | --- |
| macOS (zsh, the default) | `echo 'export META_MUSE_USER_AGENT=1' >> ~/.zshrc` |
| Linux (bash) | `echo 'export META_MUSE_USER_AGENT=1' >> ~/.bashrc` |
| fish (any OS) | `set -Ux META_MUSE_USER_AGENT 1` |
| Windows (PowerShell) | `[Environment]::SetEnvironmentVariable("META_MUSE_USER_AGENT", "1", "User")` |

Then open a **new** terminal and restart Pi. Shells that were already open don't see the change, and long-running terminal apps or multiplexers (e.g. tmux) may need a full restart. On macOS/Linux you can instead run `source ~/.zshrc` (or `~/.bashrc`) in the current shell. For a single run, use `META_MUSE_USER_AGENT=1 pi`. To disable it, remove the line (fish: `set -Ue META_MUSE_USER_AGENT`; Windows: pass `$null` instead of `"1"`) and restart Pi.

The header is the same on every OS. The captured string names `linux-x86_64`, but the platform segment doesn't appear to be checked: it was accepted from Windows (2026-09-26), and oh-my-pi sends the same fixed string on every platform.

With the flag set, the extension exposes `max` on `muse-spark-1.3-contributor` and sends the captured Muse `User-Agent` on that model's requests to `https://api.meta.ai/v1` only. Other models, proxies and custom `baseUrl`s, and any `User-Agent` you set yourself are left untouched. Without the flag, Contributor `max` is hidden and Pi's own `User-Agent` is sent.

> **Warning:** this makes Pi identify as Meta's first-party Muse client. It relies on undocumented server behavior, is not supported by Meta, may stop working without notice, and may conflict with Meta's terms. Enable it only if you accept that risk for your account.

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

`bun test` is hermetic unless a Meta credential is already available. The live cache-hit probe makes real billable API calls when a credential resolves: two identical `/v1/responses` calls (asserting `cached_tokens` on the second), plus one 2s retry if that second call misses cache. The live fingerprint probe makes two tiny Contributor-`max` calls: one without the fingerprint (status logged only) and one with it (asserting HTTP 200). It sends the header directly and does not depend on `META_MUSE_USER_AGENT`. The credential is resolved, in order, from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or the minted key from `~/.pi/agent/auth.json` after `/login meta` (skipped if expired). OAuth is enough — you do not need a separate key. Skipped when no valid credential exists (CI):

```bash
bun test tests/meta-cache.test.ts
# or, if you are not logged in:
PI_META_LIVE_API_KEY='LLM|...' bun test tests/meta-cache.test.ts
```
