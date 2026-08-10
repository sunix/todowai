---
name: import-specs
description: Bootstrap specification/specs.md from raw, unstructured input — a scratch file, brain dump, meeting notes, an existing document, or pasted text. Use at the very start of Phase 1, before refine-specs, to turn rough material into the first structured draft of the spec. Use when the human says they have notes/a doc/an idea to import, wants to kick off the specification, or asks to "import", "seed", or "initialise" the specs.
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products)
---

# Skill: import-specs

Produce the **first structured draft** of `specification/specs.md` from raw, unstructured input. This is the entry point of Phase 1 — it runs **once**, before `refine-specs` takes over the iterative loop.

## Input sources

Accept whichever the human provides (ask if unclear):

1. **The scratch file** — `specification/scratch.md` is the default dumping ground. If it exists and has content, use it.
2. **A file path** the human names (e.g. an exported doc, a `.txt`, a transcript, an existing README).
3. **Pasted text** provided directly in the conversation.

If more than one is available, ask which to use (or confirm combining them).

## Steps

1. Confirm the input source and read it in full. If the scratch file is empty and no other source was given, tell the human to drop their notes into `specification/scratch.md` (or paste them) and stop.
2. Read the section skeleton of `specification/specs.md` — the target structure is fixed:
   `Project Summary`, `Actors`, `Use Cases / User Stories`, `Screens / Views`, `Acceptance Criteria`, `Non-Functional Requirements`, `Out of Scope`, `Open Questions`.
3. Map the raw material into those sections:
   - Place each piece of information under the section it belongs to.
   - **Do not invent facts.** Only write what the source supports.
   - Where the source is silent, leave the section's `TODO:` placeholder intact.
   - Where the source is ambiguous or implies a decision that was never made, add a bullet to **Open Questions** rather than guessing.
4. Write the populated `specification/specs.md`. Do **not** append `[CONFIRMED]` to any heading — nothing is confirmed yet; that is `refine-specs`' job.
5. Populate the `AGENTS.md` front-matter if the material makes it derivable:
   - `title:` — the project name.
   - `description:` — a one-line summary.
   Leave the `TODO` placeholders if the source does not clearly support a value.
6. Invoke `update-phase` to set **Phase 1 — Specification, Iteration 1, In Progress**.
7. Summarise for the human: which sections were populated, which are still `TODO`, and the Open Questions raised. Then hand off: recommend running `refine-specs` to close the gaps.

## Boundaries

- This skill **creates the first draft only**. All subsequent iteration happens through `refine-specs`.
- It never fabricates requirements, actors, or scope to fill a section.
- It does not delete or overwrite an already-populated `specs.md` without confirming — if `specs.md` already contains real content (not just `TODO` placeholders), stop and ask, since the human may want `refine-specs` instead.
