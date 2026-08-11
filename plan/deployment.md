# Deployment Plan

Todowai ships as three client artifacts (PWA, Tauri desktop, Capacitor mobile) with no application backend server — the only remote is the user's own configured git host. "Deployment" here means shipping and updating those client artifacts safely.

## Target Environments

- **Dev** — local builds against local/test git repos.
- **Staging** — preview PWA deployment + desktop/mobile beta channel, for manual QA before release.
- **Prod** — public PWA, signed desktop installers, and mobile store/TestFlight builds.

## Action Items

- **CI pipeline: lint, test, and build the PWA** (S) — https://github.com/sunix/todowai/issues/36
  Set up continuous integration to lint, run tests, and build the PWA on every push/PR.
  - [ ] CI runs on every PR and blocks merge on failure
  - [ ] Build artifact is produced and archived per run

- **Static hosting + service worker for PWA (staging + prod)** (M) — https://github.com/sunix/todowai/issues/37
  Configure static hosting for the PWA build with a versioned service worker for offline-shell support, with separate staging and production targets.
  - [ ] Staging deploys automatically from a designated branch/PR preview
  - [ ] Production deploys from a tagged release
  - [ ] Service worker updates do not strand users on a stale cached version

- **Tauri desktop build pipeline with code signing** (L) — https://github.com/sunix/todowai/issues/38
  Set up CI builds for macOS/Windows/Linux Tauri installers, including code signing for macOS and Windows.
  - [ ] CI produces installable artifacts for all three desktop OSes
  - [ ] macOS and Windows artifacts are signed and pass local install without security warnings

- **Capacitor mobile build pipeline with signing/store credentials** (L) — https://github.com/sunix/todowai/issues/39
  Set up CI builds for iOS and Android via Capacitor, including signing and store/testflight credential handling.
  - [ ] CI produces an installable Android build and an iOS build uploadable to TestFlight
  - [ ] Signing credentials are pulled from CI secrets, never committed to the repo

- **Versioning & release process across all platforms** (S) — https://github.com/sunix/todowai/issues/40
  Define a single version scheme applied consistently across the PWA, desktop, and mobile builds, and the process for cutting a release.
  - [ ] A single version bump updates PWA, desktop, and mobile build metadata consistently
  - [ ] Release process is documented and repeatable

- **Rollback strategy per platform** (S) — https://github.com/sunix/todowai/issues/41
  Define how to roll back a bad release: PWA (redeploy previous build/service worker), desktop (re-publish previous installer), mobile (halt rollout / revert store release).
  - [ ] Rollback steps are documented per platform
  - [ ] A rollback has been dry-run at least once in staging

- **Secrets management for signing certs and store credentials** (M) — https://github.com/sunix/todowai/issues/42
  Store and manage code-signing certificates, keys, and store credentials securely in CI secrets, with documented rotation procedure.
  - [ ] No signing material or credentials are present in the repository
  - [ ] Rotation procedure is documented and has an owner

- **Staging environment for pre-release manual QA** (M) — https://github.com/sunix/todowai/issues/43
  Provide a staging channel for manual QA before each release: a staging PWA deployment plus a desktop/mobile beta distribution channel.
  - [ ] A build can be promoted to staging independently of production
  - [ ] Manual QA checklist exists and is run before each production release

