---
name: generate-mockup
description: Generate a fully clickable self-contained HTML prototype in mockup/ derived from specification/specs.md. Use when the human approves the specs and wants to produce or refresh the interactive UI mockup for Phase 2.
compatibility: Designed for GitHub Copilot and Claude Code (or similar agentic coding products)
---

# Skill: generate-mockup

Generate a fully clickable HTML prototype in `mockup/` based on `specification/specs.md`.

## Steps

1. Read `specification/specs.md` in full.
2. Derive the complete list of screens, flows, and interactions — both explicitly stated and implied.
3. Generate the HTML mockup:
   - Prefer a single `mockup/index.html` unless the prototype requires multiple pages.
   - All in-prototype navigation must be functional (no dead links between screens).
   - Use realistic placeholder content (not "Lorem ipsum") to make flows legible.
   - Display a visible banner on every screen: "Prototype — not production code".
   - No external dependencies; the file(s) must open correctly when opened locally without a server.
4. Write `mockup/README.md` listing every screen, its route/anchor within the prototype, and its status (Draft / Reviewed / Approved).
5. Invoke `update-phase` to set the current phase to Phase 2, Iteration 1 (or increment if regenerating).
6. Remind the human that pushing `mockup/` to the `main` branch will automatically trigger the GitHub Actions workflow (`.github/workflows/deploy-mockup.yml`) and publish the prototype to GitHub Pages at:
   `https://<org-or-user>.github.io/<repo-name>/`
   The Pages source must be set to **GitHub Actions** in the repository settings (Settings → Pages → Source).
   Once the deployment is live, record that URL in the `mockup_url` front-matter field of `AGENTS.md` (via `update-phase`) so the project dashboard can link to the prototype.
7. Present the mockup to the human and ask for structured feedback:
   - What is missing?
   - What is wrong?
   - What should change before moving to Phase 3?
