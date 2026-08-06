<img width="3840" height="2160" alt="Meta-Symbol" src="https://github.com/user-attachments/assets/a3074df9-ad80-40ca-b9b9-944b96dda192" />
# pi-meta-oauth

Meta Model API OAuth provider for [pi](https://pi.dev) — use **Muse Spark** (`muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.1`) via `openai-responses` inside pi.

- Device authorization (same client as Muse Code) against `https://auth.meta.com`
- Mints a Model API key via `POST https://api.meta.ai/muse-code/key`
- Stores OAuth `refresh = identity token` + `access = Model API key` in `~/.pi/agent/auth.json` under provider `meta`
- Refresh re-mints the Model API key daily
- Model catalog from `GET https://api.meta.ai/v1/models` with thinking levels `minimal/low/medium/high/xhigh`

## Install

```bash
# local path (no publish needed)
pi install ./pi-meta-provider
# or npm (after publish)
pi install npm:pi-meta-oauth

pi --list-models meta
```

## Login

```bash
pi
/login meta
# shows device code -> approve in browser -> mints Model API key automatically
```

Stored credential shape:

```json
{ "meta": { "type": "oauth", "refresh": "<identity>", "access": "<MODEL_API_KEY>", "expires": 123 } }
```

## Models

All three share 1,048,576 context, 256K output, `supportsReasoningEffort: true`, and `input: ["text","image"]`:

| id | pricing (input/output/cached) $/M |
|---|---|
| `muse-spark-1.2` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.2-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.1` | 1.25 / 4.25 / 0.15 |

Add to `enabledModels` in `~/.pi/agent/settings.json`:

```json
{ "enabledModels": ["meta/*"] }
```

## Verify

```bash
pi --list-models meta
pi -p --provider meta --model muse-spark-1.2 "Reply exactly: META_OK"
bun test extensions/meta.test.ts
```

## Publish to pi.dev

`pi-package` keyword makes it appear at https://pi.dev/packages

```bash
npm publish --access public
# users then run: pi install npm:pi-meta-oauth
```

See `extensions/meta.ts` for the `registerProvider` / `refreshModels` / `oauth` implementation reused from Muse Code's launcher flow.
