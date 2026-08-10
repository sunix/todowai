---
name: issue-template-maker
description: Generate project-aware GitHub issue templates (feature request and bug report) and create the required agent-routing labels in the repository. Use once the application is running in QA or staging and the team is ready to receive user feedback through GitHub Issues for Phase 5 (Operate).
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products). Requires the gh CLI.
---

# Skill: issue-template-maker

Generate project-aware GitHub issue templates (feature requests and bug reports) optimised for AI coding agents — Claude and GitHub Copilot.

## When to invoke

Once the first version of the application is running in QA or staging and the team is ready to start receiving user feedback through GitHub issues.

## What it produces

- `.github/ISSUE_TEMPLATE/feature_request.yml` — structured feature request form
- `.github/ISSUE_TEMPLATE/bug_report.yml` — structured bug report form
- `.github/ISSUE_TEMPLATE/config.yml` — template chooser config (disables blank issues)
- `.github/labels.yml` — label definitions for `enhancement`, `bug`, `agent:claude`, `agent:copilot`

## Steps

1. Read `specification/specs.md`, `plan/implementation.md`, and `mockup/README.md` to understand:
   - The domain vocabulary (use it in field descriptions and placeholder text)
   - The main screens / features (use them as examples in "Area affected" dropdowns)
   - The tech stack (reference it in bug report environment fields)

2. Generate `.github/ISSUE_TEMPLATE/feature_request.yml` using the base structure below, replacing placeholder values with project-specific content:
   - "Area" dropdown options → actual feature areas / screens from the mockup
   - Placeholder text in acceptance criteria → domain-relevant examples
   - Keep the **AI Coding Agent** field exactly as specified (do not customise it)

3. Generate `.github/ISSUE_TEMPLATE/bug_report.yml` similarly:
   - Environment field → pre-fill known environments from `plan/deployment.md`
   - Steps to reproduce placeholder → reference a real screen or flow from the mockup

4. Generate `.github/ISSUE_TEMPLATE/config.yml` and `.github/labels.yml`.

5. Create the labels in the GitHub repository:
   ```
   gh label create "agent:claude"   --color "CC785C" --description "To be handled by a Claude coding agent"
   gh label create "agent:copilot"  --color "6E40C9" --description "To be handled by GitHub Copilot agent"
   gh label create "enhancement"    --color "A2EEEF" --description "New feature or improvement" --force
   gh label create "bug"            --color "D73A4A" --description "Something is not working"   --force
   ```

6. Remind the human of the two agent routing mechanisms:

   **Claude coding agent**
   Apply the `agent:claude` label. A team member opens a Claude Code session, references the issue number, and works on it. Optionally, wire up a Claude-powered GitHub Action that triggers on `agent:claude` label assignment.

   **GitHub Copilot coding agent**
   Apply the `agent:copilot` label, then either:
   - Assign the issue to `@copilot` directly in the GitHub UI, or
   - Open the issue and click **"Request Copilot"** (if enabled on the organisation).
   Copilot will open a draft PR autonomously. It works best when the issue has clear acceptance criteria and no ambiguous scope.

7. Invoke `update-phase` — Phase 5 is now active.

---

## Base template structures

### feature_request.yml (base — customise steps 2–3 above)

```yaml
name: Feature Request
description: Suggest a new feature or improvement
labels: ["enhancement"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to suggest a feature.
        The more detail and context you provide, the better an AI agent can implement it autonomously.

  - type: textarea
    id: summary
    attributes:
      label: What should the application do?
      description: A clear, one-paragraph description of the desired behaviour.
    validations:
      required: true

  - type: textarea
    id: motivation
    attributes:
      label: Why is this needed?
      description: What user problem does it solve? Who is affected?
    validations:
      required: true

  - type: textarea
    id: acceptance-criteria
    attributes:
      label: Acceptance criteria
      description: Bullet list of conditions that must be true for this to be "done". Be specific.
      placeholder: |
        - [ ] ...
        - [ ] ...
    validations:
      required: true

  - type: dropdown
    id: area
    attributes:
      label: Area / screen affected
      description: Which part of the application is involved?
      options:
        - "TODO: replace with real areas from the mockup"
      multiple: true
    validations:
      required: true

  - type: dropdown
    id: agent
    attributes:
      label: Preferred AI coding agent
      description: |
        **Claude** — assign `agent:claude` label; a Claude Code session handles the issue.
        **GitHub Copilot** — assign `agent:copilot` label and assign the issue to @copilot in GitHub.
      options:
        - Claude (default)
        - GitHub Copilot
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Additional context
      description: Screenshots, sketches, links to related issues or specs, design constraints.
```

### bug_report.yml (base — customise steps 2–3 above)

```yaml
name: Bug Report
description: Report something that is broken or behaving unexpectedly
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        Please fill in as much detail as possible.
        Clear reproduction steps and expected vs actual behaviour help the AI agent fix the right thing.

  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: A clear description of the broken behaviour.
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: What did you expect to happen?
    validations:
      required: true

  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      placeholder: |
        1. Go to '...'
        2. Click on '...'
        3. Observe '...'
    validations:
      required: true

  - type: dropdown
    id: area
    attributes:
      label: Area / screen affected
      options:
        - "TODO: replace with real areas from the mockup"
      multiple: true
    validations:
      required: true

  - type: dropdown
    id: severity
    attributes:
      label: Severity
      options:
        - Critical — app is unusable
        - High — major feature broken
        - Medium — partial breakage, workaround exists
        - Low — cosmetic or minor
    validations:
      required: true

  - type: dropdown
    id: agent
    attributes:
      label: Preferred AI coding agent
      description: |
        **Claude** — assign `agent:claude` label; a Claude Code session handles the issue.
        **GitHub Copilot** — assign `agent:copilot` label and assign the issue to @copilot in GitHub.
      options:
        - Claude (default)
        - GitHub Copilot
    validations:
      required: true

  - type: input
    id: environment
    attributes:
      label: Environment
      placeholder: "e.g. staging · Chrome 124 · macOS 14"

  - type: textarea
    id: logs
    attributes:
      label: Logs / screenshots
      description: Paste error messages, console output, or attach screenshots.
```
