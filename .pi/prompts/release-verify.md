---
description: Verify pi-meta-oauth release readiness with extension-release
argument-hint: "[instructions]"
subagent: extension-release
fresh: true
---

# Release Verification

Perform the final release-readiness pass for the current pi-meta-oauth working tree.

Previous test-driver handoff:
{previous}

User instructions: $ARGUMENTS

Inspect the actual repository and working tree rather than trusting the previous handoff. Run the extension-release checklist: typecheck, full tests, npm pack dry-run and shipped-helper verification, version/README consistency, and diff/secrets hygiene.

Authority:

- Small release-preparation edits are allowed only within the extension-release agent's existing boundaries.
- Do not stage, commit, tag, push, publish, or modify credentials.
- Escalate unresolved release, versioning, scope, or publication decisions to the parent/user.

Return:

- pass/fail for every checklist item, with commands and key output
- files changed during this step
- residual risks or blockers
- an explicit ready/not-ready verdict
- the not-yet-executed final release command sequence
