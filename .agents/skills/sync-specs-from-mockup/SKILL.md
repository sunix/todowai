---
name: sync-specs-from-mockup
description: Back-propagate mockup review feedback into specification/specs.md and re-enter Phase 1. Use when the human reviews the mockup and wants to update the spec before generating a new mockup iteration.
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products)
---

# Skill: sync-specs-from-mockup

Back-propagate insights from mockup review into `specification/specs.md`, then re-enter Phase 1.

## Steps

1. Ask the human to describe what the mockup revealed — what was wrong, missing, unclear, or changed.
2. Read `specification/specs.md` and identify every section touched by the feedback.
3. For each affected section, propose a specific diff (what to remove, what to add, what to reword).
4. Apply the edits the human confirms; leave rejected changes as Open Questions if unresolved.
5. Remove `[CONFIRMED]` markers from sections that were materially changed — they need re-confirmation.
6. Invoke `update-phase` to revert to Phase 1 and increment the iteration counter.
7. Automatically continue with `refine-specs` to close any remaining gaps before the next mockup pass.
