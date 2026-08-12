# Deployment Plan

Todowai ships as three client artifacts (PWA, Tauri desktop, Capacitor mobile) with no application backend server — the only remote is the user's own configured git host. "Deployment" here means shipping and updating those client artifacts safely.

## Target Environments

- **Dev** — local builds against local/test git repos.
- **Staging** — an ephemeral per-PR PWA preview on Surge (triggered by a `/preview` PR comment, see below) plus a desktop/mobile beta channel, for manual QA before release.
- **Prod** — public PWA via GitHub Pages (the same mechanism already used for the Phase 2 mockup deploy), signed desktop installers, and mobile store/TestFlight builds.

## Action Items

- **CI pipeline: lint, test, and build the PWA** (S) — https://github.com/sunix/todowai/issues/36
  Set up continuous integration to lint, run tests, and build the PWA on every push/PR.
  - [ ] CI runs on every PR and blocks merge on failure
  - [ ] Build artifact is produced and archived per run

- **PWA PR preview via Surge (`/preview` comment)** (S) — https://github.com/sunix/todowai/issues/52
  Give reviewers a live preview build of the PWA on any pull request, following the [`pr-preview-surge`](https://github.com/sunix/ai-skills/tree/main/skills/github-actions/pr-preview-surge) skill: a `/preview` PR comment builds the PR's merge ref and deploys it to a deterministic Surge URL.
  - [x] Commenting `/preview` on an open PR deploys the current build to a per-PR Surge URL
  - [x] The triggering comment is updated with the live URL on success, or a failed-run link on failure
  - [x] A second `/preview` comment while a deploy is running cancels the in-flight one rather than racing it

- **Static hosting + service worker for PWA (prod)** (M) — https://github.com/sunix/todowai/issues/37
  Configure GitHub Pages hosting for the production PWA build with a versioned service worker for offline-shell support, extending the existing `deploy-mockup.yml` pattern to the real app build.
  - [ ] Production deploys from a tagged release (see the release-please item below)
  - [ ] Service worker updates do not strand users on a stale cached version

- **Tauri desktop build pipeline with code signing** (L) — https://github.com/sunix/todowai/issues/38
  Set up CI builds for macOS/Windows/Linux Tauri installers, including code signing for macOS and Windows.
  - [ ] CI produces installable artifacts for all three desktop OSes
  - [ ] macOS and Windows artifacts are signed and pass local install without security warnings

- **Capacitor mobile build pipeline with signing/store credentials** (L) — https://github.com/sunix/todowai/issues/39
  Set up CI builds for iOS and Android via Capacitor, including signing and store/testflight credential handling.
  - [ ] CI produces an installable Android build and an iOS build uploadable to TestFlight
  - [ ] Signing credentials are pulled from CI secrets, never committed to the repo

- **Automate versioning & releases with release-please** (S) — https://github.com/sunix/todowai/issues/40
  Use [`release-please`](https://github.com/sunix/ai-skills/tree/main/skills/github-actions/release-please) to turn Conventional Commits on `main` into an always-up-to-date Release PR (version bump + `CHANGELOG.md`); merging it publishes a GitHub Release and tag that becomes the single version referenced by Tauri and Capacitor builds.
  - [ ] A `feat:`/`fix:` commit on `main` produces or updates a Release PR with the correct version bump and changelog entry
  - [ ] Merging the Release PR publishes a GitHub Release and a git tag
  - [x] `AGENTS.md` documents the Conventional Commits + one-commit-per-PR requirement this depends on

- **Rollback strategy per platform** (S) — https://github.com/sunix/todowai/issues/41
  Define how to roll back a bad release: PWA (redeploy previous build/service worker), desktop (re-publish previous installer), mobile (halt rollout / revert store release).
  - [ ] Rollback steps are documented per platform
  - [ ] A rollback has been dry-run at least once in staging

- **Secrets management for signing certs and store credentials** (M) — https://github.com/sunix/todowai/issues/42
  Store and manage code-signing certificates, keys, and store credentials securely in CI secrets — including `SURGE_TOKEN` (PR previews) and the optional `RELEASE_PLEASE_TOKEN` — with a documented rotation procedure.
  - [ ] No signing material or credentials are present in the repository
  - [ ] `SURGE_TOKEN` and (if used) `RELEASE_PLEASE_TOKEN` are documented alongside the desktop/mobile signing secrets
  - [ ] Rotation procedure is documented and has an owner

- **Desktop/mobile beta channel for pre-release manual QA** (M) — https://github.com/sunix/todowai/issues/43
  Provide a beta distribution channel for Tauri and Capacitor builds ahead of a stable release — the PWA's equivalent (per-PR preview) is already covered by the Surge item above.
  - [ ] A desktop build can be promoted to a beta channel independently of the stable release
  - [ ] A mobile build can be promoted to TestFlight / an Android beta track independently of the stable release
  - [ ] Manual QA checklist exists and is run against the beta channel before each production release

