# Muse Code hidden-feature reconnaissance — 2026-08-06

Static/read-only analysis of the locally installed Muse Code release, with public
documentation used to distinguish hidden behavior from newly documented features.

## Snapshot and boundaries

- Release: `Muse Code 0.1.0 (0.1.0-R708.1)`
- Binary: `~/.local/bin/muse-bin-0.1.0-R708.1`
- SHA-256: `4290bfafa5bbb81a6fd493aaea12f848c789b1d22edfa0c4b849151deba3e70c`
- Format: signed arm64 Mach-O, 101,945,920 bytes
- Signature: Meta Platforms, Inc. (`V9WTTPBFK9`)
- Inspected: launcher, binary strings/dependencies, shipped skills/plugin contracts,
  cached public feature config and model catalog, CLI help, and public Meta docs
- Not inspected: credentials, auth files, settings contents, session transcripts,
  TUI history, session database, shell history, tokens, or user prompts
- No private endpoint was contacted and no hidden feature performed a real action.
  One-process environment overrides were used only with `--help` or built-in
  inventory commands to confirm gate reachability.

## Executive summary

The best direct follow-ups for `pi-meta-oauth` are:

1. **Voice finalization:** Muse's ASR client has an explicit `endStream` protocol
   field and an `endStream encode failed` error. Our extension currently sends
   trailing silence and waits, but never sends this marker. This is the strongest
   likely reliability improvement, though the exact wire value must be confirmed
   before changing production behavior.
2. **Tap-to-talk:** Muse contains a second voice mode on **Alt+T**, distinct from
   toggle recording on Alt+V. The official docs mention only Alt+V. A Pi version
   could be a one-shot recording that auto-finalizes after speech/silence.
3. **Contributor disclosure:** the local Muse catalog marks the discounted
   contributor model current/default and explicitly says content may be used for
   product improvement. Public Meta docs say prompts and completions may train
   future models. Our README shows the price but not this privacy tradeoff.
4. **Search grounding:** this is no longer hidden—Meta publicly documents native
   Responses API `web_search`, citations, raw results, context sizing, and location.
   It may be worth exposing when Pi's provider/tool API can represent hosted tools.

The binary also contains gated plugins, dynamic workflows, artifacts, JavaScript
Code Mode, monitors, local session messaging, remote kill switches, and several UI
experiments. Most overlap with Pi's existing extension/subagent/process surfaces
and should not be copied into this OAuth/provider package.

## 1. Voice protocol details not in the public Muse docs

### Confirmed static evidence

The ASR transport already documented in this repository is still present:

- Endpoint: `wss://shortwave.facebook.com/voyager/v1/asr/duplex`
- Handshake fields: `accessToken`, `mode`, `authorization`, `audioEncoding`, `model`
- Modes/encodings in the binary: `DEFAULT`, `PCM_16KHZ`, `PCM_24KHZ`, `WAV`
- Model default: `prod_tbh`
- Authorization: `OAuth <Model API key>`

New findings adjacent to that protocol:

- A serialized **`endStream`** field
- Error string: **`duplex endStream encode failed`**
- Two capture modes: `record` and `tap`
- Two shortcuts:
  - `voice` — Alt+V — "Start or stop voice input"
  - `voice-tap` — Alt+T — "Start or stop tap-to-talk voice input"
- Internal diagnostic/override names:
  - `TBH_VOICE_ASR_PROTOCOL`
  - `TBH_VOICE_ASR_ENDPOINT`
  - `TBH_VOICE_ASR_MODEL`
  - `TBH_VOICE_ASR_PROXY`
  - `TBH_VOICE_CAPTURE_WAV_FILE`
  - `TBH_VOICE_FAKE`, `TBH_VOICE_FAKE_AUDIO`
  - `MUSE_DISABLE_VOICE_WAVE`

The binary's fake audio lane accepts scripts like `loud:2500,quiet:2000`, which
explains how Muse tests voice timing without a live microphone.

### Public-doc comparison

Meta's current [interactive Muse docs](https://dev.meta.ai/docs/muse-code/interactive#voice)
document Alt+V, `/voice status`, and `/voice debug`. They do **not** mention Alt+T,
`endStream`, alternate encodings, the proxy, fake audio, or the ASR endpoint.

### Implication for this repo

`extensions/voice.ts` currently stops microphone capture, sends fixed trailing
silence, waits for drain, and closes the socket. It does not send an end-of-stream
JSON record. The next safe investigation is a local WebSocket fixture that records
Muse's exact final frame, or a controlled A/B test that sends the inferred marker
only after audio has drained. Do not guess the JSON shape in production merely
from a field name.

Tap-to-talk is likely implementable without terminal key-release events as a
one-shot mode that starts on Alt+T and auto-stops on sustained silence. Confirm
Muse's UX before assigning that behavior to the name.

The `TBH_*` variables are internal/test controls. Do not expose those names as a
public compatibility contract. Keep this package's `PI_META_VOICE_*` overrides.

## 2. Plugin system: shipped and reachable, but gated off by default

Without an override:

```text
$ muse plugins --help
plugins are not available in this build
```

With a help-only process override:

```text
$ MUSE_EXPERIMENTAL_PLUGINS=on muse plugins --help
usage: muse plugins <command>
```

The enabled parser exposes install/list/inspect/approve/reject, enable/disable,
update/remove, validation, hook fixture testing, and marketplace management. With
the same temporary gate, the built-in skill list grows from 10 to 11 and adds
`create-plugin`.

A native plugin uses `.muse-plugin/plugin.json`, schema version 1. Supported
capability families are:

- skills
- slash-command templates
- lifecycle hooks
- MCP servers (`stdio` or HTTP)
- reminder/observer agents

Direct plugin capability keys `tools`, `agents`, `outputStyles`, `settings`, and
`apps` are rejected. Custom tools are expected to arrive through MCP. Plugin IDs
`loop`, `muse-core`, and `tbh-reminders` are reserved.

This is a genuine live gate in this binary—not merely dead strings—but only help
and built-in inventory were validated. Runtime install/execute behavior was not.
Pi already has extensions, skills, hooks, MCP, and agent plugins, so this is useful
for compatibility research rather than a feature for `pi-meta-oauth`.

## 3. Hidden named-workflow CLI and dynamic workflow product

`muse --help` omits a `workflows` subcommand, but this works:

```text
muse workflows list
muse workflows save <name> --from <script.js> [--scope project|user] [--overwrite]
muse workflows run <entry> --headless-qa [--token-budget <tokens|Nk|Nm>]
muse workflows recover <workflow-run-id> [--apply] ...
```

Its own help explicitly says `run` and `recover` are a QA-only lane, deliberately
unadvertised and retained for headless QA seeding and release smokes. `list` and
`save` manage named JavaScript workflows.

Separately, the TUI contains a gated dynamic-workflow product:

- model-generated workflow proposals wait for user acceptance
- `/workflows` or `/ts`/`/ps` opens progress
- child rows support cancel, retry/skip, and result reading
- workflow scripts call agent/pipeline/parallel host functions
- `ultra` reasoning is clamped to `xhigh` on the provider request and instead
  increases proactive workflow/delegation behavior client-side

The official docs describe multi-agent subagents, but not this hidden workflow CLI
or the dynamic proposal/product details. Pi's `pi-subagents` already provides a
more mature equivalent; there is no Meta OAuth integration to port here.

## 4. Experimental feature registry

The binary contains these environment gates as one registry:

```text
MUSE_EXPERIMENTAL_WORKFLOW_TOOL
MUSE_EXPERIMENTAL_ARTIFACT_TOOL
MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING
MUSE_EXPERIMENTAL_CODE_MODE
MUSE_EXPERIMENTAL_PREFIX_COMPACTION
MUSE_EXPERIMENTAL_MONITOR
MUSE_EXPERIMENTAL_VOICE_TAB
MUSE_EXPERIMENTAL_FOREIGN_PERSONAL_CONTEXT_KILL
MUSE_EXPERIMENTAL_VOICE
MUSE_EXPERIMENTAL_VOICE_DEFAULT_ON
MUSE_EXPERIMENTAL_REASONING_DISPLAY
MUSE_EXPERIMENTAL_MODEL_EFFORT_CONTEXT
MUSE_EXPERIMENTAL_BASH_TITLES
MUSE_EXPERIMENTAL_PLUGINS
MUSE_EXPERIMENTAL_WEB_FETCH
```

The name `MUSE_EXPERIMENTAL_VOICE_TAB` is spelled **TAB** in this build even though
the UI feature is called `voice-tap`; preserve the observation rather than silently
correcting it.

The cached public feature configuration has a one-hour TTL and currently contains
only:

```json
{
  "gates": { "voice": true, "voice_default_on": true },
  "killed_slash_commands": []
}
```

This proves voice is remotely enabled and that Muse can remotely kill slash
commands. It does not prove all other experimental gates are available server-side.

## 5. Compiled/gated harness features

### Artifact tool

The settings UI describes an artifact tool as allowing the model to publish local
HTML and Markdown files. Static records use `artifact://` references. No public
Muse documentation was found for this product surface.

### JavaScript Code Mode

The binary defines `code.exec` and `code.wait` with JavaScript source, generated
tool bindings such as `tools.workspace.read_file(...)` and `tools.byId(...)`, and
`code.checkpoint(...)`. This release also contains explicit messages that Code Mode
needs a V8 workflow-script-engine build and that live background cells are not
wired. Treat it as compiled protocol/UI scaffolding, not a usable feature here.

### Monitor tool

A gated monitor runs one long-lived command, treats stdout lines as events, wakes
the agent on meaningful output, and has a 30-minute ceiling. It is designed to
replace sleep/poll loops. The official Muse docs mention monitors only in passing.
Pi already has process waiting/background task mechanisms.

### Local session messaging

The slash command `/message <target-session-id> <body>` and top-level
`muse session-message send|serve` use an authenticated local socket broker. This is
gated by settings/feature state. Pi's intercom/subagent messaging already covers the
same class of coordination.

### Web fetch and search

Muse has client-side `web_search`, `web_fetch`, open-page, and find-in-page tools,
plus an internal `/muse-code/search` transport. However, hosted search grounding is
now a public Model API feature and should be preferred over cloning an internal
Muse endpoint.

## 6. Public Model API capabilities worth checking in Pi

These are current public capabilities, not reverse-engineered secrets:

- Responses API `web_search` with inline `url_citation` annotations
- opt-in raw results via `include: ["web_search_call.results"]`
- `search_context_size`: `low`, `medium`, `high`
- approximate country/region/city/timezone search localization
- text, image, video, audio, and PDF input for Muse Spark
- structured output and tool search

Sources:

- [Search grounding](https://dev.meta.ai/docs/search-grounding)
- [Models](https://dev.meta.ai/docs/models)
- [Tool search](https://dev.meta.ai/docs/tool-search)

Whether `pi`'s `openai-responses` adapter can pass hosted tools and non-image media
through is a separate implementation question.

## 7. Model-catalog mismatch and contributor disclosure

The cached Muse-facing catalog contains only two visible rows:

- `muse-spark-1.2`
- `muse-spark-1.2-contributor`

It marks the contributor row `is_current: true` and `is_default: true`, with the
description: "Discounted tokens: your content may be used for product improvement."
The public Muse/Model API docs instead describe `muse-spark-1.2` as the default and
also list `muse-spark-1.1`. This may reflect a Muse-specific profile, rollout, or
account snapshot; do not change provider defaults from this cache alone.

The privacy disclosure is not ambiguous: Meta's public model docs say contributor
prompts and completions may be used to train future Meta models. The README should
state that beside the contributor model's discounted price.

The cached Muse catalog reports an effective context limit of 1,007,997, while
public model docs state 1,048,576. The smaller value is likely a harness/provider
budget after reserved overhead. The package's official 1,048,576 fallback is not
proven wrong.

## Recommended next work

1. **Add the contributor privacy disclosure to README** — low risk, public fact.
2. **Capture Muse's exact ASR final frame against a local WebSocket fixture** — do
   not hit the private endpoint for protocol discovery. If confirmed, add
   `endStream` finalization and a regression test.
3. **Prototype Alt+T one-shot voice locally** after confirming Muse's actual stop
   semantics. Keep Alt+V unchanged.
4. **Check Pi hosted-tool support** before attempting Model API `web_search`; use the
   public Responses API contract, not Muse's internal `/muse-code/search` path.
5. Do not port plugins, workflows, monitors, Code Mode, or local messaging into this
   package; those belong to Pi/the harness and already have close equivalents.
