```
   ███████╗██╗   ██╗██╗     ████████╗ █████╗ ███╗   ██╗
   ██╔════╝██║   ██║██║        ██║   ██╔══██╗████╗  ██║
   ███████╗██║   ██║██║        ██║   ███████║██╔██╗ ██║
   ╚════██║██║   ██║██║        ██║   ██╔══██║██║╚██╗██║
   ███████║╚██████╔╝███████╗   ██║   ██║  ██║██║ ╚████║
   ╚══════╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝

   S·CIAM  U·sine  L·ogicielle  T·oolkit  A·gent-  N·ative
   ─────────────────────────────────────────────────────────
               AI-Driven Software Delivery · SCIAM
```

A GitHub repository template that structures AI-assisted software delivery into five sequential phases: **Specification → Mockup → Plan → Implementation → Operate**.

Use this template as the starting point for any new project. The agent follows the instructions in [`AGENTS.md`](./AGENTS.md) and uses the skills in [`.agents/skills/`](./.agents/skills/) to guide you from idea to a running, maintained application.

---

## How to use this template

1. Click **"Use this template"** on GitHub to create a new repository from this one.
2. In the new repo, go to **Settings → Pages → Source** and select **GitHub Actions**.
3. Open [`AGENTS.md`](./AGENTS.md) and fill in the **Project Overview** and **Constraints** sections, plus the `title` and `description` fields in the front-matter.
4. Start a Claude Code session in the repo and work through the phases below.

The template also includes a one-time issue seeding workflow:
- [`.github/workflows/seed-initial-issues.yml`](./.github/workflows/seed-initial-issues.yml)
- Trigger: first push to `main` (or manual `workflow_dispatch`)
- Behavior: creates one issue per entry in [`.github/issue-seeds.json`](./.github/issue-seeds.json), then writes a closed marker issue so reruns are safe.

---

## Phases

### Phase 1 — Specification

**Folder:** `specification/`
**Entry skills:** `import-specs`, `refine-specs`

Start by dumping whatever you already have — rough notes, a brain dump, meeting notes, an existing document — into [`specification/scratch.md`](./specification/scratch.md) (or just point the agent at any file or paste it). Ask the agent to run `import-specs` and it turns that raw material into the first structured draft of [`specification/specs.md`](./specification/specs.md), leaving `TODO`s and Open Questions where the input was silent.

From there you own `specs.md`. Ask the agent to run `refine-specs` — it asks clarifying questions, surfaces gaps, and helps you reach a complete, unambiguous spec. Iterate as many times as needed. When you are satisfied, tell the agent the specs are ready.

---

### Phase 2 — Mockup

**Folder:** `mockup/`
**Entry skills:** `generate-mockup`, `sync-specs-from-mockup`

Once specs are approved, ask the agent to run `generate-mockup`. It produces a self-contained, fully clickable HTML prototype in `mockup/`.

Pushing `mockup/` to `main` automatically deploys the prototype to **GitHub Pages** via the included workflow (`.github/workflows/deploy-mockup.yml`). The live URL will be:

```
https://<your-org-or-user>.github.io/<your-repo-name>/
```

Review the prototype. You have two options:
- **Iterate on the mockup** — ask the agent to refine it.
- **Go back to specs** — ask the agent to run `sync-specs-from-mockup`, which updates the spec and re-enters Phase 1.

When the mockup is approved, move to Phase 3.

---

### Phase 3 — Plan

**Folder:** `plan/`
**Entry skill:** `create-plan`

Ask the agent to run `create-plan`. It produces three documents:

| File | Contents |
|------|----------|
| `plan/implementation.md` | Milestones, tasks, complexity estimates |
| `plan/deployment.md` | Environments, CI/CD steps, rollback strategy |
| `plan/monitoring.md` | Metrics, alerting thresholds, dashboards |

For each action item, the agent creates a **GitHub issue** and embeds the issue URL in the plan. Review and reprioritize the issues before development begins.

---

### Phase 4 — Implementation

**Folder:** `implementation/`
**Entry skill:** `implement`

Once the plan and its issues are agreed, ask the agent to run `implement` to build the application. It works through the planned GitHub issues in priority order, routing each to an AI coding agent based on its **AI Coding Agent** label:

| Choice | Label applied | How it works |
|--------|--------------|--------------|
| Claude (default) | `agent:claude` | Open a Claude Code session, reference the issue number, implement, and open a PR |
| GitHub Copilot | `agent:copilot` | Assign the issue to `@copilot` or click **"Request Copilot"** in GitHub — Copilot opens a draft PR autonomously |

You review and merge the PRs; progress is tracked in [`implementation/progress.md`](./implementation/progress.md). Invoke `implement` once per issue. Phase 4 is complete when the planned scope is merged and the first version is deployed to QA/staging.

---

### Phase 5 — Operate

**Entry skill:** `issue-template-maker`

Once the first version is running in QA or staging, ask the agent to run `issue-template-maker`. It reads the project specs and mockup to generate project-aware GitHub issue templates and creates the required labels in the repository.

Users can then submit **feature requests** and **bug reports** directly through GitHub Issues. Each template carries the same **AI Coding Agent** field, and issues are routed to Claude or Copilot exactly as in Phase 4.

Phase 5 has no fixed end — it runs continuously alongside the live application.

---

## Skills reference

| Skill | What it does |
|-------|-------------|
| `import-specs` | Seeds the first `specification/specs.md` draft from a scratch file or raw input |
| `refine-specs` | Iterates on `specification/specs.md` with targeted questions |
| `generate-mockup` | Generates the clickable HTML prototype in `mockup/` |
| `sync-specs-from-mockup` | Back-propagates mockup feedback into the spec |
| `create-plan` | Builds the three plan docs and opens GitHub issues |
| `implement` | Executes the plan's issues into merged code, routed to Claude or Copilot (Phase 4) |
| `update-phase` | Updates the current phase / iteration header **and front-matter** in `AGENTS.md` |
| `issue-template-maker` | Installs project-aware GitHub issue templates + labels for Phase 5 |
| `update-readme` | Keeps this README in sync with `AGENTS.md` and `.agents/skills/` |

---

## Repository structure

```
.
├── AGENTS.md                         # Agent instructions + front-matter metadata + current phase tracker
├── README.md                         # This file
├── specification/
│   ├── scratch.md                    # Raw input dumping ground (seeds specs.md via import-specs)
│   └── specs.md                      # Project specification (human-owned)
├── mockup/                           # Generated HTML prototype
├── plan/
│   ├── implementation.md             # Generated in Phase 3 (the plan)
│   ├── deployment.md
│   └── monitoring.md
├── implementation/
│   └── progress.md                   # Phase 4 build tracker (maintained by implement)
├── .agents/
│   └── skills/
│       ├── import-specs/SKILL.md
│       ├── refine-specs/SKILL.md
│       ├── generate-mockup/SKILL.md
│       ├── sync-specs-from-mockup/SKILL.md
│       ├── create-plan/SKILL.md
│       ├── implement/SKILL.md
│       ├── update-phase/SKILL.md
│       ├── issue-template-maker/SKILL.md
│       └── update-readme/SKILL.md
└── .github/
    ├── issue-seeds.json                # One issue definition per bootstrap step (used by seeding workflow)
    ├── workflows/
    │   └── deploy-mockup.yml         # Auto-deploys mockup/ to GitHub Pages
    │   └── seed-initial-issues.yml   # One-time issue seeder (idempotent)
    └── ISSUE_TEMPLATE/
        ├── config.yml                # Disables blank issues
        ├── feature_request.yml       # Structured feature request form
        └── bug_report.yml            # Structured bug report form
```

---

## Project metadata (front-matter)

[`AGENTS.md`](./AGENTS.md) begins with a YAML front-matter block that is the machine-readable status of the project — it is exported to the projects dashboard:

```yaml
---
title: <project name>
description: <one-line summary>
sultan_phase: <e.g. "2 — Mockup", or "Not started">
iterations: <number of work rounds with the agent>
mockup_url: <GitHub Pages link, once the mockup is deployed>
---
```

`title` and `description` are filled during Phase 1 (`refine-specs`). `sultan_phase`, `iterations`, and `mockup_url` are kept up to date automatically by the `update-phase` skill — do not edit them by hand.

---

## Current phase

See the **Current Phase** section at the top of [`AGENTS.md`](./AGENTS.md) for the live phase and iteration count.
