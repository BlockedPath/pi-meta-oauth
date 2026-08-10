---
description: "Run with /prompt-workflow release-prep [instructions] --bg: test-driver then extension-release"
argument-hint: "[instructions] [--bg]"
chain: release-test -> release-verify
---

# Release Preparation Workflow

Run the project release-preparation workflow through pi-subagents: test-driver first, then extension-release, sequentially in the same working tree. Keep commit drafting separate because this workflow must not stage files.

Additional instructions: $ARGUMENTS
