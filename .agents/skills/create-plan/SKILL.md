---
name: create-plan
description: Produce implementation, deployment, and monitoring plan documents under plan/ and create a GitHub issue for each action item. Use when the human approves the mockup and is ready to plan the build in Phase 3.
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products). Requires the gh CLI.
---

# Skill: create-plan

Produce implementation, deployment, and monitoring plans in `plan/`, then create a GitHub issue for each action item.

## Steps

1. Read `specification/specs.md` and `mockup/README.md` (if present) in full.
2. Create `plan/implementation.md`:
   - Break the build into logical milestones, each containing concrete tasks.
   - Per task: description, acceptance criteria, estimated complexity (S / M / L).
   - Order milestones by dependency (what must ship before what).
3. Create `plan/deployment.md`:
   - List all target environments (e.g. dev, staging, prod).
   - Document infrastructure requirements, CI/CD pipeline steps, secrets management, and rollback strategy.
4. Create `plan/monitoring.md`:
   - Define key business and technical metrics to track.
   - Specify alerting thresholds and on-call responsibilities.
   - Include error tracking, structured logging, and dashboard requirements.
5. For each action item across all three plans, create a GitHub issue:
   ```
   gh issue create \
     --title "<item title>" \
     --body "<description>\n\n## Acceptance Criteria\n<criteria>" \
     --label "<implementation|deployment|monitoring>"
   ```
   Embed the returned issue URL inline in the plan document next to the item.
6. Invoke `update-phase` to set the current phase to Phase 3, Iteration 1.
7. Present a summary of all created issues to the human for priority review.
8. Once the human has reviewed and prioritised the issues, prompt them to confirm before advancing to Phase 4 (Implementation) via the `implement` skill.
