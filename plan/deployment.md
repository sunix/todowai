# Deployment Plan

**Reworked following the architecture pivot in [ADR-001](../specification/decisions.md).**
Todowai now ships as: a self-hosted backend (Rust core + bundled web UI in a single Docker
image, run locally by the user — hosted/cloud deployment is deferred, see specs.md Out of
Scope) and installable Tauri desktop/mobile apps that reuse the same web UI and Rust core.
There is still no third-party application server beyond what the user runs themselves — the
only remote is the user's own configured git host.

## Target Environments

- **Dev** — local builds against local/test git repos.
- **Staging** — an ephemeral per-PR web UI preview on Surge (triggered by a `/preview` PR comment, see below — UI-only, doesn't exercise the backend) plus a desktop/mobile beta channel, for manual QA before release.
- **Prod** — the self-hosted Docker image (backend + bundled UI), signed desktop installers, and mobile store/TestFlight builds.

## Action Items

- **CI pipeline: lint, test, and build the PWA** (S) — https://github.com/sunix/todowai/issues/36
  Set up continuous integration to lint, test, and build both the web UI and the Rust core on every push/PR.
  - [ ] CI runs on every PR (web UI and Rust core) and blocks merge on failure
  - [ ] Build artifacts are produced and archived per run

- **PWA PR preview via Surge (`/preview` comment)** (S) — https://github.com/sunix/todowai/issues/52
  Give reviewers a live preview build of the web UI on any pull request, following the [`pr-preview-surge`](https://github.com/sunix/ai-skills/tree/main/skills/github-actions/pr-preview-surge) skill: a `/preview` PR comment builds the PR's merge ref and deploys it to a deterministic Surge URL. Still useful for UI-only changes; doesn't exercise the backend.
  - [x] Commenting `/preview` on an open PR deploys the current build to a per-PR Surge URL
  - [x] The triggering comment is updated with the live URL on success, or a failed-run link on failure
  - [x] A second `/preview` comment while a deploy is running cancels the in-flight one rather than racing it

- ~~Static hosting + service worker for PWA (prod) — #37~~ **Superseded**, see #64.

- **Build & publish the self-hosted Docker image (backend + bundled UI)** (M) — https://github.com/sunix/todowai/issues/64
  Replaces #37 (closed): there's no standalone static PWA to host anymore — the backend serves the UI itself. This is production for v1.
  - [ ] CI builds and publishes the combined Docker image (e.g. to GHCR) on a tagged release
  - [ ] Image is versioned consistently with the release-please-driven version
  - [ ] Documented `docker run` instructions let a user self-host with a single command against a mounted vault folder

- **Per-PR backend preview image via GHCR (`/preview` comment)** (M) — https://github.com/sunix/todowai/issues/66
  Extends the `/preview` comment (see #52's Surge UI preview) to also build and push a per-PR Docker image to GHCR, once #59/#64 exist, so a reviewer can `docker run` the exact PR against a real test vault instead of only eyeballing the UI shell.
  - [ ] `/preview` builds and pushes a `pr-<number>`-tagged image to GHCR, alongside the existing Surge preview
  - [ ] The triggering comment includes a ready-to-run `docker run` command for that tag
  - [ ] A second `/preview` while a build is running cancels the in-flight one, matching the Surge preview's behavior
  - [ ] Closing the PR cleans up its image tag from GHCR

- **Tauri desktop build pipeline with code signing** (L) — https://github.com/sunix/todowai/issues/38
  Set up CI builds for macOS/Windows/Linux Tauri installers (backed by the shared Rust core), including code signing for macOS and Windows.
  - [ ] CI produces installable artifacts for all three desktop OSes
  - [ ] macOS and Windows artifacts are signed and pass local install without security warnings

- ~~Capacitor mobile build pipeline with signing/store credentials — #39~~ **Superseded**, see #65.

- **Tauri mobile build pipeline with signing/store credentials** (L) — https://github.com/sunix/todowai/issues/65
  Replaces #39 (closed): mobile packaging moved from Capacitor to Tauri.
  - [ ] CI produces an installable Android build and an iOS build uploadable to TestFlight via Tauri's mobile tooling
  - [ ] Signing credentials are pulled from CI secrets, never committed to the repo

- **Automate versioning & releases with release-please** (S) — https://github.com/sunix/todowai/issues/40
  Use [`release-please`](https://github.com/sunix/ai-skills/tree/main/skills/github-actions/release-please) to turn Conventional Commits on `main` into an always-up-to-date Release PR (version bump + `CHANGELOG.md`); merging it publishes a GitHub Release and tag that becomes the single version referenced by the Docker image and Tauri builds.
  - [ ] A `feat:`/`fix:` commit on `main` produces or updates a Release PR with the correct version bump and changelog entry
  - [ ] Merging the Release PR publishes a GitHub Release and a git tag
  - [x] `AGENTS.md` documents the Conventional Commits + one-commit-per-PR requirement this depends on

- **Rollback strategy per platform** (S) — https://github.com/sunix/todowai/issues/41
  Define how to roll back a bad release: self-hosted Docker image (redeploy previous image tag), desktop (re-publish previous Tauri installer), mobile (halt rollout / revert store release).
  - [ ] Rollback steps are documented per platform
  - [ ] A rollback has been dry-run at least once in staging

- **Secrets management for signing certs and store credentials** (M) — https://github.com/sunix/todowai/issues/42
  Store and manage code-signing certificates, keys, and store credentials securely in CI secrets — including `SURGE_TOKEN` (PR previews) and the optional `RELEASE_PLEASE_TOKEN` — with a documented rotation procedure.
  - [ ] No signing material or credentials are present in the repository
  - [ ] `SURGE_TOKEN` and (if used) `RELEASE_PLEASE_TOKEN` are documented alongside the desktop/mobile signing secrets
  - [ ] Rotation procedure is documented and has an owner

- **Desktop/mobile beta channel for pre-release manual QA** (M) — https://github.com/sunix/todowai/issues/43
  Provide a beta distribution channel for Tauri desktop and Tauri mobile builds ahead of a stable release — the UI's equivalent (per-PR preview) is already covered by the Surge item above.
  - [ ] A desktop build can be promoted to a beta channel independently of the stable release
  - [ ] A mobile build can be promoted to TestFlight / an Android beta track independently of the stable release
  - [ ] Manual QA checklist exists and is run against the beta channel before each production release

