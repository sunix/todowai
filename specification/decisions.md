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

---

## ADR-002: Persist Remote/AI settings to a git-ignored vault file (2026-08-18)

**Status:** Accepted

**Context:**

ADR-001 established that credentials live server-side in the Rust core rather than in
browser JS — but the implementation went further than that decision required, keeping
Remote sync and AI provider config in memory only, with no persistence at all. In practice
this means every container restart wipes both, forcing the user to retype a git PAT and an
AI API key each time — a real, repeated friction point once self-hosting for actual daily
use (issue #89), not just for local development.

**Options considered:**

- Keep in-memory only, rely entirely on `TODOWAI_REMOTE_*`/`TODOWAI_AI_*` env vars for
  anything that should survive a restart — pushes the problem onto deployment config
  (`docker run -e ...` / compose files) rather than solving it for someone just running the
  container directly, and doesn't help at all if the user wants to change providers/tokens
  without redeploying.
- A separate secrets store (OS keychain, a `.env` file the user manages by hand) — real
  options for the native Tauri apps later, but this backend runs in a plain Docker
  container with no keychain access, and a manually-managed `.env` reintroduces exactly the
  "retype it somewhere" friction this is trying to remove.
- Persist to the vault itself, git-ignored — the vault is already the durable, private,
  self-hosted storage this whole app is built around; reusing it needs no new
  infrastructure and the file survives exactly as long as the vault does.

**Decision:**

Persist both Remote sync and AI provider config to `<subfolder>/.todowai-settings.json`,
auto-added to `<subfolder>/.gitignore` on first save so the plaintext file is never
committed. This is a deliberate, informed reversal of the "in-memory only" convention
`RemoteConfig`/`AiConfig`'s doc comments previously stated — traded for the concrete
convenience the user asked for, given the residual risk is limited to whoever already has
filesystem access to the user's own private, self-hosted vault (the same access they'd
need to read any other note in it).

Mitigations kept in place:

- The settings file is fully protected like `.git`/`.obsidian` — invisible to
  Notebook/Settings' file listings, and rejected by the generic `read_file`/`write_file`
  endpoints — so it's never reachable except through the dedicated settings load/save path.
- `RemoteConfig`/`AiConfig` still deliberately have no `Serialize` derive; the persisted
  JSON is built by hand in `api.rs` instead, so it stays structurally impossible for either
  to leak whole through some future API response by accident — the API's existing "never
  echo the key back" behavior (`AiConfigView`) is untouched by this change.
- Written with `0600` permissions on Unix as a defensive baseline.
- Persisting is best-effort: a filesystem failure never blocks actually using the remote or
  AI provider for the current session, only the "remember it for next time" part.

**Consequences:**

- `TODOWAI_REMOTE_*`/`TODOWAI_AI_*` env vars now only seed a section that has never been
  saved through the UI — once saved, the persisted file wins on every subsequent restart
  regardless of env vars, which is what actually removes the retyping friction.
- Self-hosting on a filesystem without normal Unix permission semantics loses the `0600`
  hardening (best-effort, not enforced) — acceptable for v1's Docker/Linux-first target.

---

## ADR-003: Folder-notes via `index.md`; horizon stays a per-note field, no central manifest (2026-08-21)

**Status:** Accepted

**Context:**

Real projects need more than one note — related tasks, meeting notes, reference material —
kept together (issue #111), and an individual task/meeting needs its own horizon so a
project with work due in more than one horizon can appear in several Horizon columns at
once, expandable per horizon (issue #112), plus a Today's plan column with drag-in from
This Week (issue #113) and a few more horizon-like buckets (archive, sleeping/frozen, done).
This meant deciding both how a project's notes are grouped on disk, and how horizon
membership (now needed per-task, not just per-project) is tracked.

**Options considered:**

- *Grouping via an explicit `project:` link field* on each child note pointing back at its
  project — flexible (a note doesn't need to physically move), but reintroduces exactly the
  "notes scattered with only a mention" problem #111 exists to fix, and needs a stable
  reference (path breaks on rename; an ID needs inventing and mapping back to a note).
- *Grouping via folder + type-sniffing* — a project's folder is implicitly its own note's
  parent directory, found by scanning the folder for whichever note has `type: project`.
  Works, but is ambiguous when generalized to other note types, and requires explicitly
  excluding the shared `backlog`/`doing`/`done` folders from ever being treated as "a note's
  own folder" (every project note living directly in `backlog/` would otherwise claim every
  unrelated sibling note there).
- *Horizon as a central manifest* — one file (markdown or JSON) with a sublist per horizon
  bucket, every new note auto-linked into "unplanned" on creation. Attractive as a single
  glanceable dashboard, but rejected: it duplicates what the Horizon screen already computes
  live from frontmatter, and it requires active reconciliation — a note created any way
  other than through the exact registration flow (typed directly in Obsidian, restored from
  a backup, moved by hand outside the app) would be invisible until something explicitly
  re-syncs the manifest against what's actually on disk. Frontmatter-per-note can't drift
  that way: whatever the note's `horizon:` field says *is* the truth, however the note came
  to exist.

**Decision:**

- **Folder-notes via `index.md`.** Any note — a project, a task, a meeting — can be promoted
  from a flat `<name>.md` file to a folder `<name>/index.md` when it needs to hold more than
  itself (images, other notes). `index.md` carries exactly the frontmatter/body a flat file
  would; a folder with no `index.md` isn't a note at all (so `backlog`/`doing`/`done` are
  automatically excluded — nobody puts an `index.md` there — with no folder-name exclusion
  list to maintain). This is type-agnostic and applies uniformly to every note type, not
  just projects, and generalizes for free to a task that itself needs an attachment.
- **Containment defines ownership.** A note's owner is the nearest ancestor folder that is
  itself an `index.md`-defined note. Anything else living inside that folder — a flat task
  note, a meeting note, a nested `task-slug/index.md` promoted the same way — belongs to it,
  with no new frontmatter field needed to express the relationship. `note::display_name`
  gets one small addition: for an `index.md`, the title comes from the parent folder's name,
  not the literal filename "index".
- **Horizon stays a plain per-note frontmatter field**, unchanged from #26/#27, just with a
  wider set of recognized values: `week` / `month` / `year` as today, plus `next-action`,
  `archive`, `sleeping` (or `frozen`), and `done` — unset still means unplanned. Any note,
  however it was created, is automatically and correctly bucketed the instant it's scanned.
- **`horizon-order.json` is retired** in favor of a sparse numeric `horizon_order:`
  frontmatter field per note (deliberately gapped values, e.g. increments of 1000, so
  reordering only ever rewrites the one moved note, not a shared file). This removes the
  last piece of horizon state that lived outside the note itself — opening any note directly
  in Obsidian now shows exactly where it sits, with nothing to cross-reference.

**Consequences:**

- No migration for existing project notes: the folder/`index.md` behavior is opt-in — a flat
  project note keeps working exactly as it does today until it's promoted into its own
  folder with sibling notes placed alongside it.
- #111 implements `index.md`-aware discovery and the containment rule across
  `note.rs`/`projects.rs`/`horizon.rs`/`meetings.rs`; #112 widens the horizon enum and
  migrates from `horizon-order.json` to the sparse `horizon_order` field; #113 will need to
  decide how "Today's plan" maps onto this — likely the `next-action` value, or its own,
  resolved when that issue is implemented.
- `app/src/main.ts`'s `horizon-order.json` read/write path (`parseHorizonOrder`,
  `serializeHorizonOrder`, `refreshHorizonOrder`) is removed once #112 lands; until then it
  coexists without conflict with #111's work, since #111 doesn't touch horizon assignment.
