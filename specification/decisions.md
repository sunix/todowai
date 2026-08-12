# Architecture Decisions

> A running log of significant, hard-to-reverse decisions and the reasoning behind them —
> kept separate from `specs.md` (which describes the current target state) so the *why*
> behind past pivots isn't lost as the spec evolves. Append a new entry whenever a decision
> like this changes direction on something already decided, or already built.

---

## ADR-001: Rust core + self-hosted backend, replacing browser-only git (2026-08-12)

**Status:** Accepted

**Context:**

While implementing issue #12 (offline-first sync engine), pushing/pulling from a browser
page hit a hard blocker: GitHub's git-smart-HTTP endpoints (`/info/refs`, `git-upload-pack`,
`git-receive-pack`) send no CORS headers, so no in-browser `fetch()` can ever reach them
directly, regardless of app code. This is a general limitation of virtually every git host's
HTTP endpoint, not something specific to Todowai.

**Options considered:**

- A CORS-relay proxy in front of git hosts — works technically, even self-hostable invisibly
  to the end user, but rejected because it adds trust/infra surface for something this core.
- GitHub's REST/Git-Data API instead of raw git — CORS-enabled, but GitHub-only; breaks
  support for self-hosted git remotes (e.g. an existing Obsidian vault repo hosted elsewhere)
  and would mean re-implementing the sync engine against a different API shape.
- OAuth instead of a PAT — a real credential-security improvement, but orthogonal: it does
  not fix CORS on its own.
- Kotlin Multiplatform for a shared core — strong fit for Android (JGit is mature on the
  JVM), but iOS has no JGit equivalent; Kotlin/Native would need libgit2 via cinterop,
  splitting the app across two different git engines instead of one.
- Node.js embedded on mobile (`nodejs-mobile`) — technically works, but fights mobile OS
  background-process lifecycle limits.

**Decision:**

Move all git, filesystem, and sync logic out of the browser into a shared Rust core
(`git2-rs`/`gitoxide` — one engine, compiles natively to desktop/iOS/Android with no VM).
It's consumed two ways:

- As a self-hosted backend service (Docker locally now; the user's own cloud infrastructure
  later, deferred — see `specs.md` Out of Scope), bundled with the existing web UI into a
  single Docker image.
- Packaged via Tauri into installable native desktop and mobile apps, reusing the same web UI
  (one UI codebase everywhere) through Tauri's webview + IPC bridge instead of browser
  `fetch()` — sidestepping the CORS restriction entirely for anyone who installs the app
  rather than self-hosting.

The original browser-only model (File System Access API + isomorphic-git, built across
#9–#12) is fully superseded, not kept as a fallback.

**Consequences:**

- `specs.md`'s Non-Functional Requirements architecture section is rewritten accordingly.
- Issues #10, #11, and #12 (isomorphic-git + File System Access API integration,
  subfolder/vault access rules, browser-based sync scheduling) were built against the
  superseded architecture and need to be revisited in the Phase 3 plan once specs settle —
  their acceptance criteria and UX intent mostly still apply, but the underlying
  implementation moves to the Rust core.
- AI provider credentials (OpenAI/Anthropic/etc., for future AI-delegation features) will
  live server-side in the Rust core rather than in browser JS, closing off a
  DevTools/XSS exposure path that existed under the old model.
- The recurring File System Access API friction (re-picking the vault folder and
  re-walking it fully every session, since the browser API has no persistence) goes away,
  since the backend has real, persistent filesystem access.
