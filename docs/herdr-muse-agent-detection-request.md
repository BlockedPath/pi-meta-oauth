# Agent support request: Muse Code (`muse`)

**Requesting:** a `muse` agent kind + detection manifest, and `herdr integration install muse`.

**Tested against:** herdr 0.8.0 (macOS, Ghostty), Muse Code 0.1.0 (`0.1.0-R708.1`).

All screen and title captures below are from live `herdr pane get` / `herdr pane read`
against a real Muse pane, not from reading the binary.

---

## Why

Muse Code is Meta's coding-agent CLI (`muse`, installed as `~/.local/bin/muse`, a
launcher shim that execs `muse-bin-<version>`). It is a full TUI agent in the same
class as the kinds herdr already supports.

Today a Muse pane is invisible to herdr: `agent_status` stays `unknown` and no
`agent_session` is reported, so pane state, agent targeting (`herdr agent prompt`),
and every plugin that keys off `pane.agent` skip it. Concretely this blocks a
Muse provider in [`senna-lang/herdr-agent-usage`](https://github.com/senna-lang/herdr-agent-usage),
which needs `pane.agent == "muse"` to attribute context and token usage — the data
is all on disk and ready to read (see "Session data" below), only the pane→session
link is missing.

The kind list is a compile-time enum
(`pi|claude|codex|gemini|cursor|devin|agy|cline|omp|mastracode|opencode|copilot|kimi|kiro|droid|amp|grok|hermes|kilo|qodercli|maki`),
so a local detection-manifest override cannot introduce `muse` — this needs an
engine change.

Proposed id: `muse`. No alias needed; the binary and the product are both `muse`.

---

## Detection evidence

### OSC 0 title — spinner prefix while working

Muse emits exactly one OSC 0 title, the **cwd basename**, and prefixes a braille
spinner while a turn is in flight. Captured via `herdr pane get`:

| State | `terminal_title` |
| --- | --- |
| Idle | `muse-detect-probe` |
| Working | `⠹ muse-detect-probe` |
| Idle again (turn complete) | `muse-detect-probe` |

The title alone is **not sufficient for identification** — the idle title is an
ordinary directory name that any shell could emit. It is a good *state* signal
once the pane is known to be Muse, in the same shape as the grok manifest's
`osc_title` rules, but the identifying rules must come from the screen.

### Idle screen

```text
  Muse Code 0.1.0

  Model set to muse-spark-1.2-contributor
  ⎿  Discounted tokens: your content may be used for product improvement.

  Skills: 25 loaded · 1 warning · 1 detail hidden (ctrl+o to expand)

── Voice input (⌥ + v to start) ─────────────────────────────────────────────────
⟩
────────────────────────────────────────────────────────────────────────────────
  muse-spark-1.2-contributor · high · /private/tmp/muse-detect-probe
```

Stable idle markers:

- **Status footer (last row):** `<model> · <reasoning effort> · <cwd>`, e.g.
  `muse-spark-1.2-contributor · high · /private/tmp/muse-detect-probe`.
  Present in every frame, idle and working — the strongest identity anchor.
- **Prompt glyph:** `⟩` at the start of the input row, inside a rule-bordered box.
- **Startup banner:** `Muse Code <semver>` — only on the first screen, so useful
  for identification but not for steady state.
- The `── Voice input (⌥ + v to start) ──` header appears when voice is enabled;
  do not depend on it (it is configurable and platform-dependent).

### Working screen

Two observed working frames, both with `(<elapsed> · esc to interrupt)`:

```text
◆ Thinking (2s · esc to interrupt)
```

```text
◇ Finishing up (5s · esc to interrupt)
```

Note the leading glyph changes (`◆` → `◇`), so a working rule should anchor on
`esc to interrupt`, not on the glyph. `esc to interrupt` never appears in an idle
frame.

Completed tool calls and assistant output also use `◆` as a bullet:

```text
◆ Ran command · Create probe file · ✓ · 0.1s · ctrl+o

◆ Done — created probe-file.txt (exit 0).
```

so `◆` by itself cannot mean "working" — another reason to key on
`esc to interrupt` plus the spinner-prefixed title.

### Blocked state — not reproduced

I could not produce a permission prompt. Muse runs shell tools in a sandbox and
**denies rather than asks**; an escalation attempt returned a tool error inside
the normal transcript flow, with no modal:

```text
◆ Ran command · Run sudo check · ✗ · 0.1s · ctrl+o

◆ Command failed (exit 126):

    /bin/sh: /usr/bin/sudo: Operation not permitted

  sudo -n true is not permitted in this sandbox.
```

There is one **pre-session** modal, the workspace trust gate, shown before the
TUI starts:

```text
Do you trust this workspace?
Workspace: /private/tmp/muse-detect-probe

Trusting allows project-local skills, rules, hooks, and plugin config to load
before the model runs.
Only trust this workspace when you trust its contents.

> 1  Trust and continue
  2  Quit

Use Up/Down or 1/2, then Enter. Esc quits.
```

This is a genuine blocker (the agent will not start until answered) and is a good
`blocked` rule: `contains = ["Do you trust this workspace?"]`. If Muse has an
in-session approval mode I did not hit, I'm happy to capture it on request.

### Draft manifest rules

Offered as a starting point, in the shape of `remote/grok.toml`:

```toml
id = "muse"
version = "2026.08.10.1"
min_engine_version = 2

[[rules]]
id = "trust_gate_blocked"
state = "blocked"
priority = 1300
visible_blocker = true
contains = ["Do you trust this workspace?"]

[[rules]]
id = "esc_to_interrupt_working"
state = "working"
priority = 1200
contains = ["esc to interrupt"]

[[rules]]
id = "osc_title_spinner_working"
state = "working"
priority = 1100
region = "osc_title"
line_regex = "^[\\u2800-\\u28FF] "

[[rules]]
id = "status_footer_idle"
state = "idle"
priority = 900
line_regex = "^\\s+muse-spark-[^ ]+ · .+ · /"
```

The idle footer regex is written against the observed
`<model> · <effort> · <cwd>` layout; a looser `· .* · /` form may age better if
model ids change.

---

## Session data available for `agent_session`

If the integration reports `agent_session`, everything a usage plugin needs is
already on disk. Muse writes an append-only event log per session:

```text
~/.local/share/muse/sessions/YYYY/MM/DD/<session-uuid>/session.jsonl
```

`kind: "path"` pointing at that `session.jsonl` would match the OMP/Pi convention
exactly.

Each session log opens with route facts that make pane matching possible even
without an integration:

```json
{"payload_type": "runtime.session.route_facts",
 "payload": {"record": {"cwd": "/private/tmp/muse-detect-probe", "pid": 88964,
   "terminal_kind": "Ghostty", "terminal_bundle_id": "com.mitchellh.ghostty",
   "terminal_title_identity": "e40bfc96ac18"}}}
```

`terminal_title_identity` is the last 12 hex characters of the session uuid.
Note it is **not** present in the OSC title Muse actually emits (the title is the
cwd basename), so today it cannot be used to match a pane to a session — a real
integration is the reliable path.

There is also an index at `~/.local/share/muse/session-index.db`
(`sessions(session_id, workspace_root, session_log_path, model_id, updated_at_us, …)`),
but it **lags**: after my probe session ended, the newest indexed row was still a
different, older session. Consumers should treat the directory tree as the source
of truth and the DB as an accelerator.

---

## Environment

- herdr 0.8.0, Ghostty, macOS arm64
- Muse Code 0.1.0 (`0.1.0-R708.1`), `muse-bin` 97 MB, launcher shim at `~/.local/bin/muse`
- Config at `~/.config/muse/`, state at `~/.local/share/muse/`

Happy to capture more states (resume, compaction, subagents, an approval prompt if
one exists) or to test a draft manifest locally via
`herdr server reload-agent-manifests`.
