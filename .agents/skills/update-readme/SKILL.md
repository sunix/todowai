---
name: update-readme
description: Keep README.md in sync with AGENTS.md and .agents/skills/. Use when a skill is added or removed, a phase description changes, or the human explicitly asks to refresh the README.
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products)
---

# Skill: update-readme

Keep `README.md` in sync with the current state of `AGENTS.md` and `.agents/skills/`.

## When to invoke

- A new skill is added to or removed from `.agents/skills/`.
- A phase description in `AGENTS.md` changes materially.
- A new folder or workflow is added to the repository.
- The human explicitly asks for the README to be refreshed.

## Steps

1. Read `AGENTS.md`, `README.md`, and list all files in `.agents/skills/`.
2. Identify every section of `README.md` that is stale or missing:
   - **Skills reference table** — must match every `SKILL.md` file present under `.agents/skills/` subfolders.
   - **Repository structure** — must reflect the actual directory tree.
   - **Phases** — descriptions must match the corresponding phase sections in `AGENTS.md`.
   - **GitHub Pages URL pattern** — verify it still matches the workflow in `.github/workflows/deploy-mockup.yml`.
3. Apply the minimal edits needed to bring `README.md` back in sync. Do not rewrite sections that are already accurate.
4. Do not change the tone or structure of `README.md` unless the human asks for it.
