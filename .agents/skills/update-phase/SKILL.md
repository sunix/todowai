---
name: update-phase
description: Update the Current Phase header and the YAML front-matter in AGENTS.md to record the active phase, iteration count, and status. Use when any other skill needs to advance or increment the phase tracker, or when the human explicitly asks to record a new phase or iteration.
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products)
---

# Skill: update-phase

Update the **Current Phase** section and the **YAML front-matter** at the top of `AGENTS.md` to reflect the latest state. The two must always stay in sync.

## Steps

1. Determine the new state — confirm with the caller if any value is ambiguous:
   - **Phase number:** 1, 2, 3, 4, or 5
   - **Phase name:** Specification | Mockup | Plan | Implementation | Operate
   - **Iteration:** 1-based count of work rounds completed in the current phase
   - **Status:** In Progress | Complete
2. Read `AGENTS.md`.
3. Replace the body of the **Current Phase** section with:
   ```
   **Phase:** <number> — <name>
   **Iteration:** <n>
   **Status:** <In Progress | Complete>
   ```
4. Update the YAML front-matter block at the very top of the file so it matches:
   - `sultan_phase:` — `<number> — <name>` (or `Not started` before Phase 1).
   - `iterations:` — the same `<n>` as the iteration above.
   - `mockup_url:` — set to the GitHub Pages URL (`https://<org-or-user>.github.io/<repo>/`) once the mockup has been deployed; leave blank until then. Do not overwrite an existing URL.
   - Leave `title` and `description` untouched unless the caller explicitly asks to change them.
5. Write the updated `AGENTS.md`.
6. Confirm the update to the caller so they can continue their workflow.
