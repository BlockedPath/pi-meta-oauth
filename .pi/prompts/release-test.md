---
description: Get the release test suite green with test-driver
argument-hint: "[instructions]"
subagent: test-driver
fresh: true
---

# Release Test

Prepare the current pi-meta-oauth working tree for release by getting its validation suite green.

User instructions: $ARGUMENTS

Authority:

- You may make minimal source or test fixes inside the current repository.
- Do not stage, commit, tag, push, publish, or alter release credentials.
- Stop and report any product, architecture, scope, or test-expectation decision that needs approval.

Required validation:

1. Detect and run the repository's intended test command.
2. Fix failures one cluster at a time, rerunning targeted tests after each fix.
3. Run the full test suite after targeted tests pass.
4. Run the typecheck if the changed files are TypeScript or the repository exposes a typecheck script.

Return a handoff containing:

- final pass/fail state and commands with exit codes
- files changed and why
- residual failures or decisions needed
- anything the release verifier must recheck
