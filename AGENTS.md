---
title: Todowai
description: "A privacy-first AI-assisted note and task companion for deciding what to do next."
sultan_phase: 2 — Mockup
iterations: 1
mockup_url: "" # GitHub Pages link, filled in once the mockup is deployed
---

# Agent Instructions

---

## Current Phase

<!-- Managed by the `update-phase` skill. Do not edit manually. -->

**Phase:** 2 — Mockup
**Iteration:** 1
**Status:** In Progress

---

## Project Overview

Todowai is a personal notes and task application that keeps track of what a person has done, is doing, and wants to do in an Obsidian-style Markdown workspace. The product should let the user capture and edit notes from mobile, browser, and desktop clients, then use AI to reorganize those notes, help follow projects, support delegated AI work, and suggest what to do next across large tasks, parallel work, and meetings.

---

## Phases

This project moves through five sequential phases. Each phase has its own folder.
The agent must not advance to the next phase without explicit human confirmation.

---

### Phase 1 — Specification (`specification/`)

**Goal:** Produce a clear, agreed-upon specification in `specification/specs.md`.

**How it works:**
- **Kick-off (once):** the human dumps raw material — notes, a brain dump, an existing document — into `specification/scratch.md` (or points the agent at any file / pasted text). The agent runs the `import-specs` skill to turn it into the first structured draft of `specification/specs.md`.
- **Iterate:** from there the human owns `specification/specs.md`. The agent assists via the `refine-specs` skill: asking clarifying questions, surfacing gaps, and suggesting structure improvements.
- Multiple iterations are expected. Each iteration increments the iteration count in *Current Phase*.
- Phase 1 is complete when the human explicitly marks specs as ready to prototype.

**Skills:**
- [`.agents/skills/import-specs/SKILL.md`](./.agents/skills/import-specs/SKILL.md) — seed the first draft from raw input
- [`.agents/skills/refine-specs/SKILL.md`](./.agents/skills/refine-specs/SKILL.md) — iterate on the draft

---

### Phase 2 — Mockup (`mockup/`)

**Goal:** Produce a fully clickable HTML prototype in `mockup/` derived from the specification.

**How it works:**
- Triggered by the `generate-mockup` skill once Phase 1 is marked complete.
- The agent generates a self-contained, fully navigable HTML mockup reflecting `specification/specs.md`.
- The human reviews and provides feedback. Feedback triggers one of two outcomes:
  1. **Iterate on mockup:** agent refines the prototype (increments iteration, stays in Phase 2).
  2. **Back to specs:** agent invokes `sync-specs-from-mockup` to update `specification/specs.md`, re-enters Phase 1.

**Deployment:** Every push to `main` that touches `mockup/` automatically deploys to GitHub Pages via `.github/workflows/deploy-mockup.yml`. The prototype is publicly accessible at `https://<org-or-user>.github.io/<repo-name>/`. Requires Pages source set to **GitHub Actions** in repository settings.

**Skills:**
- [`.agents/skills/generate-mockup/SKILL.md`](./.agents/skills/generate-mockup/SKILL.md)
- [`.agents/skills/sync-specs-from-mockup/SKILL.md`](./.agents/skills/sync-specs-from-mockup/SKILL.md)

---

### Phase 3 — Plan (`plan/`)

**Goal:** Produce actionable implementation, deployment, and monitoring plans with corresponding GitHub issues.

**How it works:**
- Triggered by the `create-plan` skill once Phase 2 is marked complete.
- The agent creates three plan documents under `plan/`:
  - `plan/implementation.md`
  - `plan/deployment.md`
  - `plan/monitoring.md`
- For each action item, the agent creates a GitHub issue (via `gh`) and embeds the issue URL back in the plan document.
- The human reviews and adjusts priorities before development begins.

**Skill:** [`.agents/skills/create-plan/SKILL.md`](./.agents/skills/create-plan/SKILL.md)

---

### Phase 4 — Implementation (`implementation/`)

**Goal:** Turn the plan into a working, deployed application by executing the Phase 3 GitHub issues with AI coding agents, until the first version runs in QA/staging.

**How it works:**
- Triggered by the `implement` skill once Phase 3 is marked complete and the issues are prioritised.
- Work through the planned issues in priority order. Each issue is routed to an AI coding agent via its **AI Coding Agent** label:
  - **Claude** (`agent:claude` label) — a team member opens a Claude Code session, implements the issue on a feature branch, and opens a PR that closes it.
  - **GitHub Copilot** (`agent:copilot` label) — assign the issue to `@copilot` in the GitHub UI, or click **"Request Copilot"** on the issue page. Copilot opens a draft PR autonomously. Works best for issues with clear, self-contained acceptance criteria.
- Humans review and merge the PRs. Progress is tracked in `implementation/progress.md`. Each work round increments the iteration count in *Current Phase*.
- Phase 4 is complete when the planned scope is implemented, tested, and deployed to QA/staging.

**Agent routing cheat-sheet:**

| Preference | Label | How to trigger |
|-----------|-------|----------------|
| Claude | `agent:claude` | Open Claude Code, reference the issue, implement |
| GitHub Copilot | `agent:copilot` | Assign issue to `@copilot` or click "Request Copilot" |

**Skill:** [`.agents/skills/implement/SKILL.md`](./.agents/skills/implement/SKILL.md)

---

### Phase 5 — Operate (`operate/`)

**Goal:** Sustain a continuous feedback loop between live users and AI coding agents once the application is running in staging or production.

**How it works:**
- Users submit feature requests and bug reports through GitHub Issues using the structured templates in `.github/ISSUE_TEMPLATE/`.
- Each issue carries the same **AI Coding Agent** preference field and is routed exactly as in Phase 4 (see the routing cheat-sheet above): `agent:claude` or `agent:copilot`.
- The `issue-template-maker` skill is run once to install project-aware templates and create the required labels in the repository.
- There is no fixed end to Phase 5 — it runs continuously alongside the live application.

**Skill:** [`.agents/skills/issue-template-maker/SKILL.md`](./.agents/skills/issue-template-maker/SKILL.md)

---

## Phase Progression

| # | Phase | Folder | Entry Skill | Completion Signal |
|---|-------|--------|-------------|-------------------|
| 1 | Specification | `specification/` | `import-specs` → `refine-specs` | Human marks specs ready |
| 2 | Mockup | `mockup/` | `generate-mockup` | Human approves mockup |
| 3 | Plan | `plan/` | `create-plan` | GitHub issues created & reviewed |
| 4 | Implementation | `implementation/` | `implement` | Planned issues merged, app in QA/staging |
| 5 | Operate | `.github/ISSUE_TEMPLATE/` | `issue-template-maker` | Templates live, labels created, live feedback loop running |

Use the `update-phase` skill to advance to the next phase or record a new iteration.

---

## Invoking Skills

Type any skill name as a standalone message to invoke it — no extra phrasing needed:

```
import-specs
refine-specs
generate-mockup
create-plan
implement
update-phase
```

The agent will recognise the skill name, load the corresponding file from `.agents/skills/`, and execute it. Typing `help` lists all available skills for the current project.

---

## Skills

| Skill | When to invoke |
|-------|----------------|
| [`import-specs`](./.agents/skills/import-specs/SKILL.md) | Seed the first `specification/specs.md` draft from a scratch file or raw input |
| [`refine-specs`](./.agents/skills/refine-specs/SKILL.md) | Iterate on `specification/specs.md` |
| [`generate-mockup`](./.agents/skills/generate-mockup/SKILL.md) | Generate or refresh the clickable HTML mockup |
| [`sync-specs-from-mockup`](./.agents/skills/sync-specs-from-mockup/SKILL.md) | Back-propagate mockup feedback into specs |
| [`create-plan`](./.agents/skills/create-plan/SKILL.md) | Build plans and open GitHub issues |
| [`implement`](./.agents/skills/implement/SKILL.md) | Execute the plan's issues into merged code (Phase 4) |
| [`update-phase`](./.agents/skills/update-phase/SKILL.md) | Advance phase or increment iteration count |
| [`issue-template-maker`](./.agents/skills/issue-template-maker/SKILL.md) | Install project-aware GitHub issue templates + labels for Phase 5 |
| [`update-readme`](./.agents/skills/update-readme/SKILL.md) | Keep `README.md` in sync with `AGENTS.md` and `.agents/skills/` |

---

## Constraints

- Keep personal notes and task history as private as possible.
- Preserve an Obsidian-style Markdown note-taking model.
- Support note access and editing from mobile, browser, and desktop environments.
- Handle mobile and PC usage in parallel without blocking concurrent edits.
- Store notes and AI conversations in a single user-configurable private git repository (dedicated subfolder for conversations), not one hardcoded by the app.
- Do not implement note/conversation content encryption in v1; rely on private-repo + git transport security instead (GPG/content encryption deferred).
- Do not let the AI write to external services (e.g. calendar, email) or execute autonomously outside the note base; delegated AI work is limited to reviewable edits within the repo, always confirmed by the user.
