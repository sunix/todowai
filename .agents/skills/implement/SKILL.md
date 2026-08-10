---
name: implement
description: Execute the plan by building the application — work the GitHub issues created in Phase 3 into merged code, routing each to the chosen AI coding agent (Claude or GitHub Copilot), until the first version runs in QA/staging. Use in Phase 4 (Implementation), after the plan and its issues are reviewed, when the human wants to start or continue building. Invoke once per issue/work round.
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products)
---

# Skill: implement

Turn the Phase 3 plan into a working, deployed application by executing its GitHub issues. This skill runs the **build loop** — invoke it once per issue (or work round); each round increments the Phase 4 iteration counter.

## Prerequisites

- Phase 3 (Plan) is complete: `plan/implementation.md`, `plan/deployment.md`, `plan/monitoring.md` exist and their GitHub issues are created and prioritised.
- Do not start until the human confirms the plan and priorities are agreed.

## Steps

1. Read `plan/implementation.md` (and the linked issues) to find the next unit of work. Pick the highest-priority open issue unless the human names a specific one.
2. Route the issue to an AI coding agent. Use its **AI Coding Agent** label if one is set (`agent:claude` / `agent:copilot`); otherwise ask the human which agent should handle it (the `agent:*` labels are created by `issue-template-maker`, but Phase 4 does not require them — a per-issue decision is fine).
   - **Claude** — implement it here: make the code changes on a feature branch, keep changes scoped to the issue's acceptance criteria, and open a PR that references the issue (`Closes #<n>`).
   - **Copilot** — dispatch it: assign the issue to `@copilot` (or tell the human to click **"Request Copilot"**), then stop and let Copilot open its draft PR autonomously.
3. Verify the work against the issue's acceptance criteria before handing off for review (run tests / exercise the change where possible). Never mark an issue done on unverified work.
4. The human reviews and merges the PR. A merged issue is a completed unit of work.
5. Record progress in `implementation/progress.md`: issue number, title, agent used, PR link, and status (In Progress / In Review / Merged).
6. Invoke `update-phase` to record **Phase 4 — Implementation** and increment the iteration count.
7. Report what shipped and what remains. When the planned scope is implemented, tested, and deployed to QA/staging, tell the human Phase 4 is complete and prompt them to confirm before advancing to Phase 5 (Operate) via `issue-template-maker`.

## Boundaries

- This skill builds the **initial** version from the plan's issues. User-submitted feature requests and bug reports on the live app are a Phase 5 (Operate) concern.
- Scope each change to a single issue; do not bundle unrelated work into one PR.
- Never advance to Phase 5 without explicit human confirmation and a deploy to QA/staging.
