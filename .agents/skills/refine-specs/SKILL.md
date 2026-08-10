---
name: refine-specs
description: Iteratively refine specification/specs.md in collaboration with the human by identifying gaps, ambiguities, and missing sections. Use when the user wants to improve or review the project specification, ask clarifying questions about requirements, or iterate on specs before moving to mockup.
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products)
---

# Skill: refine-specs

Iteratively improve `specification/specs.md` in collaboration with the human.

This skill assumes `specification/specs.md` already holds a first draft. If it is still all `TODO` placeholders and the human has raw notes to import, run `import-specs` first to seed it.

## Steps

1. Read the current content of `specification/specs.md` in full.
2. Identify gaps, ambiguities, or missing sections — check for:
   - Undefined actors or unclear roles
   - Use cases that lack acceptance criteria
   - Screens mentioned in prose but not listed in the Screens section
   - Non-functional requirements not addressed
   - Open Questions that have implicit answers buried in the text
3. Ask the human targeted clarifying questions — no more than 3–5 per iteration to avoid overload.
4. Incorporate confirmed answers and propose updated versions of the affected sections.
5. Once the human confirms a section, append `[CONFIRMED]` to its heading.
6. Ensure the `AGENTS.md` front-matter is populated:
   - `title:` — the project's name (replace the `TODO` placeholder as soon as it is known).
   - `description:` — a one-line summary of the project (replace the `TODO` placeholder).
   Keep both in sync with `specification/specs.md` as it evolves. These fields feed the project dashboard, so they must never be left as `TODO` once specs exist.
7. After each round of edits, invoke `update-phase` to increment the iteration counter (Phase 1).
8. When the human declares specs ready, prompt them to confirm before transitioning to Phase 2 via `generate-mockup`.
