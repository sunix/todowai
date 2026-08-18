# Implementation Plan

Derived from `specification/specs.md` (Phase 1) and `mockup/README.md` (Phase 2). Milestones are ordered by dependency — each should ship before the next begins.

## M1 — Core storage & sync engine

Foundational storage layer everything else depends on. **Reworked following the architecture
pivot in [ADR-001](../specification/decisions.md)** — see there for the full reasoning. The
browser-only git engine (isomorphic-git + File System Access API) is superseded by a shared
Rust core, consumed as a self-hosted backend (bundled with the web UI in one Docker image) and,
later, via Tauri for desktop/mobile (M8).

- **Scaffold PWA project shell** (S) — https://github.com/sunix/todowai/issues/9 — *Merged.*
  Set up the PWA build tooling and a routing shell for the seven screens (Capture, Notebook, Next Action, Projects, Horizon, Meetings, Settings) defined in specification/specs.md. This project shell (routing, screens, UI) is unaffected by the architecture pivot and is reused as-is.
  - [x] Project builds and runs locally as an installable PWA
  - [x] Shell navigates between seven empty placeholder screens matching mockup/index.html's structure

- ~~Integrate isomorphic-git with File System Access API storage adapter — #10~~ **Superseded**, see #59.
- ~~Settings: configurable git repo path + subfolder — #11~~ **Superseded**, see #60.
- ~~Offline-first sync engine (pull/push scheduling) — #12~~ **Superseded**, see #62.

- **Scaffold Rust core + self-hosted backend service (git2-rs/gitoxide)** (L) — https://github.com/sunix/todowai/issues/59 — *Merged (#67).*
  Replaces #10 (closed). A shared Rust core implements git/filesystem operations against a real path, compiled into a backend HTTP service bundled with the web UI into a single Docker image — one `docker run` self-hosts both. Delivered as git2-rs (not gitoxide) plus an axum HTTP API; deliberately skipped porting the old browser code's in-memory incremental status-tracking optimization since git2's native `statuses()` is already fast against a real filesystem.
  - [x] Rust core exposes open/read/write/commit/history via git2-rs against a real filesystem path
  - [x] Backend HTTP service exposes these operations locally
  - [x] Single Docker image bundles backend + web UI static assets; `docker run` with a mounted repo folder works end-to-end

- **Backend: configurable repo subfolder + vault access rules** (M) — https://github.com/sunix/todowai/issues/60 — *Merged (#72).*
  Replaces #11 (closed). Same subfolder/vault-access rules as before (`.git`/`.obsidian` off-limits, edit-anywhere/create-only-inside-subfolder), re-implemented against real backend filesystem access. `commit_all` now stages each pending change individually (not a blanket pathspec) so it can precisely exclude non-manageable changes outside the subfolder — covers both externally deleted *and* externally added files there, not just deletions.
  - [x] Configurable Todowai subfolder name (default `todowai`), set via mounted path/config
  - [x] `.obsidian/` and `.git/` rejected on any read/write and never listed
  - [x] Editing existing files outside the subfolder succeeds; creating new ones there is rejected
  - [x] Externally-deleted files outside the subfolder are not staged/committed by Todowai

- **Web UI: integrate with the backend API** (M) — https://github.com/sunix/todowai/issues/61 — *Merged (#75).*
  Swap the web UI's in-browser `RepositoryController` (File System Access API + isomorphic-git) for an HTTP client against the new backend, with no change to screens/UX. The old picker-based "open a repository" flow is gone entirely (there's nothing to open — the backend already owns the vault); replaced with an automatic load on startup plus a manual refresh button.
  - [x] All repository operations in the UI go through the backend API
  - [x] No File System Access API / isomorphic-git code paths remain in the web UI
  - [x] Existing UI/UX behaves the same from the user's perspective — verified end-to-end against a real Docker image + test vault by driving the actual rendered UI with Playwright

- **Rust core: git pull/push sync engine (offline-first)** (L) — https://github.com/sunix/todowai/issues/62 — *Merged (#76).*
  Replaces #12 (closed — the browser-based attempt hit an unfixable GitHub CORS wall, see closed PR #58 and ADR-001). Same design (debounced/immediate push, background pull, non-blocking offline/conflict status), implemented via git2-rs on the backend where CORS doesn't apply. Also switched the shared repository lock to `std::sync::Mutex` + `spawn_blocking` throughout, since a blocking network call could otherwise stall every other request.
  - [x] Backend supports configuring a remote URL + credentials (username/PAT), in-memory only
  - [x] Pull attempts on backend start and on a background interval; failures never block the API/UI
  - [x] Shared push entry point with an `immediate` flag; `immediate: true` exercised directly to stand in for future AI edits
  - [x] A merge conflict during pull surfaces as a clear, non-blocking error (full resolution UI is #13)
  - [x] Verified behavior with the network unreachable: app remains usable, edits still save locally, sync-status reflects offline/retry

- **Web UI: remote sync configuration + status indicator** (M) — https://github.com/sunix/todowai/issues/77 — *Merged (#78).*
  Adds the UI #62 deliberately left out (backend-only, verified via direct API calls): a global sync-status indicator matching the Phase 2 mockup's sidebar-footer design (extended to all four backend statuses, not just the mockup's two), and Remote URL/Username/Token fields in Settings wired to `PUT /api/sync/remote` — not in the mockup at all, since it predates ADR-001. Follow-up also added `GET /api/sync/remotes` so the Remote URL field suggests any remotes already configured in the vault's `.git/config` (e.g. `origin`) via a `<datalist>`, instead of requiring the URL to be retyped from scratch.
  - [x] Sync-status indicator visible on every screen, matching the mockup's placement
  - [x] Indicator distinguishes all four sync states (synced/offline/conflict/error)
  - [x] Manual "Sync now" action triggers a pull/push and reflects the result
  - [x] Settings has Remote URL/Username/Token fields wired to `PUT /api/sync/remote`; empty URL clears the remote
  - [x] Indicator/fields reflect actual backend state on page load, not just optimistic local state

- **Non-blocking git 3-way merge conflict handling** (M) — https://github.com/sunix/todowai/issues/13 — *Merged (#79).*
  Handle concurrent edits between devices using git's 3-way merge; when a true conflict occurs, surface it as a dismissible, non-blocking item rather than halting editing. Now depends on #62 (the Rust-core sync engine) rather than the closed #12 — behavior/UX unchanged by the pivot. #62 already delivered non-overlapping auto-merge on *pull*; this closed the remaining gap on *push* (previously fast-forward-only, so it falsely reported a conflict for any divergence at all) and added a keep-mine/keep-theirs resolution UI for genuine conflicts, which #62 deliberately left unbuilt. A full diff/merge editor is out of scope for v1.
  - [x] Non-overlapping concurrent edits merge automatically with no user action
  - [x] Overlapping edits produce a conflict entry the user can resolve later without being blocked from continuing other edits


## M2 — Notebook & Capture

Core note-taking surface and the capture-to-filing flow.

- **Notebook view: file tree + markdown viewer/editor** (M) — https://github.com/sunix/todowai/issues/14 — *Merged (#80).*
  Build the Notebook screen: an Obsidian-style file tree (done/doing/backlog/.ai folders) and a markdown viewer/editor pane for the selected file. Reuses the file-tree component and readFile/writeFile client already built for Settings' dev-oriented file editor, but scopes the listing to the subfolder — unlike Settings, which deliberately shows the whole vault. Follow-up added "New note"/"New folder" creation: a typed path can include folder segments (write_file already creates any parent directories it needs), and "New folder" seeds an empty `untitled.md` since git can't track an empty directory on its own.
  - [x] Tree lists real files from the configured subfolder
  - [x] Selecting a file loads and allows editing its raw markdown, including frontmatter

- **Capture view: quick-add note UI** (S) — https://github.com/sunix/todowai/issues/15 — *Merged (#81).*
  Build the Capture screen's quick-add form and the Recently Captured list, consistent across mobile, browser, and desktop. A capture is deliberately not written to the vault — per specification/specs.md it stays an editable draft until explicitly filed into the Notebook (#16/#17) — so it lives in `localStorage` rather than going through the backend, surviving a reload without needing any new API.
  - [x] A typed note is saved and appears at the top of Recently Captured immediately
  - [x] Works with touch and keyboard input

- **Capture filing flow — manual path** (M) — https://github.com/sunix/todowai/issues/16 — *Merged (#82).*
  From a captured note, let the user manually choose a destination type (todo / meeting / status / project note) and edit the resulting draft before it is saved into the Notebook. Every manually filed note lands in `<subfolder>/backlog` regardless of type — specs.md and issues #18/#28 confirm meetings/project notes are plain notes discovered by frontmatter, not their own folders, so type only shapes the frontmatter written, not the destination folder.
  - [x] User can pick a type and edit title/content
  - [x] Nothing is written to the Notebook until the user explicitly saves
  - [x] Saved item appears in the correct Notebook location for its type

- **Capture filing flow — AI-proposed path** (M) — https://github.com/sunix/todowai/issues/17 — *Merged (#83).*
  From a captured note, let the AI propose a classification (type, title, content) as a fully editable draft, per the confirm-first pattern used elsewhere in the app. Supports Anthropic natively plus a shared OpenAI-compatible adapter for OpenAI, Gemini, Mistral, Groq, and Ollama (local), configured via a new Settings "AI provider" card with credentials kept server-side/in-memory only. Same PR also fixed filed-note filenames (manual and AI paths alike) to carry a `<capture-date>-` prefix, since each capture creates a new file rather than overwriting one. Verified against a mock OpenAI-compatible server and, later, a live Anthropic API call against a real vault.
  - [x] AI drafts type/title/content instead of just a label
  - [x] User can edit any field before saving
  - [x] Nothing is written to the Notebook without explicit user confirmation

- **Frontmatter conventions & parser for note types** (S) — https://github.com/sunix/todowai/issues/18 — *Merged (#84).*
  Define and implement shared frontmatter parsing/writing for todo, meeting, status, and project-note types (e.g. type, status, project, date, attendees fields). Shipped as `app/src/frontmatter.ts`, wired into Capture's draft flow (replacing a raw string template and a fragile type-line regex) and Notebook's viewer (a read-only parsed-frontmatter chip summary above the raw editor). Meetings/Horizon/Projects views (#25/#26/#28) don't exist yet, so the parser ships as shared infrastructure for them to consume once built.
  - [x] Frontmatter is parsed consistently across Notebook and Capture (Meetings/Horizon aren't built yet — see above)
  - [x] Round-tripping a note (read, edit, save) preserves unrelated frontmatter fields


## M3 — Current status & Next Action

The moment-to-moment decision-support loop.

- **Current-status field (task or situational context)** (S) — https://github.com/sunix/todowai/issues/19 — *Merged (#85).*
  Implement a persistent current-status field the user can view and set, accepting either a todo/task reference or a free-text situational context (e.g. 'coffee break', 'commuting'). Built out the Next Action screen around a single well-known file (`<subfolder>/status.md`, using #18's frontmatter parser) rather than a discrete note per entry, synced like any other vault file. Shipped with a curated set of 28 predefined situational-status suggestions (breaks, commute, chores, work-mode switches, reading/learning) as quick picks on the free-text field.
  - [x] Status is visible on Next Action and persists across sessions/devices via the synced repo
  - [x] Both a task-linked status and a free-text situational status are supported

- **Next Action: AI next-todo suggestion engine** (L) — https://github.com/sunix/todowai/issues/20 — *Merged (#86).*
  Implement the suggestion engine that proposes a next todo from current status, notes, backlog, and the connected calendar feed(s), always requiring explicit user confirmation before it is treated as decided. New `POST /api/ai/suggest-next-action` reads status + backlog directly and prompts the configured AI provider; rejected suggestions are tracked and excluded on retry so "suggest something else" reliably differs. Confirm appends to a new persistent `<subfolder>/today.md` list. Calendar feeds (#22–#24) don't exist yet, so suggestions are grounded in status + backlog only for now. A real-vault testing pass also surfaced and fixed an unrelated pre-existing bug (binary files breaking the startup file preview — #87).
  - [x] Suggestion incorporates status and backlog contents (calendar events: not yet possible, #22–#24 not built)
  - [x] Confirm adds the item to today's plan; nothing is auto-added without confirmation
  - [x] Rejecting/asking for another suggestion produces a different candidate

- **Situational-context small-suggestion behavior** (M) — https://github.com/sunix/todowai/issues/21 — *Merged (#88).*
  When the current status is a situational context rather than a task, bias suggestions toward small, fitting backlog items (e.g. a quick look at a side project, one page of a book) instead of full tasks. A new `parse_status()` gives the backend structured knowledge of status.md's `kind` field (previously only raw file content reached the prompt), letting `build_suggestion_prompt` add an explicit small-item bias instruction for situational status while leaving task-linked/unset behavior unchanged.
  - [x] A situational status like 'coffee break' surfaces a small backlog item, not a large task
  - [x] A task-linked status surfaces a normal next-todo suggestion


## M4 — Calendar integration

Read-only awareness of what's already planned.

- **Settings: multiple labeled calendar feed URLs** (S) — https://github.com/sunix/todowai/issues/22 — *Merged (#91).*
  Implement Settings UI to add, label, and remove one or more read-only calendar feed URLs (e.g. iCal links). Persisted as a plain JSON array at `<subfolder>/calendars.json` — a normal, synced vault file (not git-ignored like #89's credentials file, since a feed URL isn't a secret), reusing the existing generic read/write-file endpoints rather than new backend code.
  - [x] User can add/remove/rename multiple feed entries
  - [x] Configuration persists in the synced repo (not just local device state)

- **ICS feed fetch + parse (read-only, multi-source)** (M) — https://github.com/sunix/todowai/issues/23 — *Merged (#92).*
  Fetch and parse each configured calendar feed URL client-side (no OAuth, no write access) and merge events from all configured sources. New `GET /api/calendar/upcoming`, backed by a hand-rolled ICS parser (RFC5545 line unfolding, UTC/all-day dates, TEXT unescaping) — recurring events (RRULE) are explicitly out of scope. Backend-only; no UI yet.
  - [x] Events from two or more feeds are correctly merged and de-duplicated by time
  - [x] A failing feed does not block or crash the fetch of the others

- **Upcoming list in Next Action, labeled by source** (S) — https://github.com/sunix/todowai/issues/24 — *Merged (#93).*
  Show merged upcoming events in the Next Action view, each labeled with its source calendar (e.g. 'Work', 'Personal'). Fetched once at startup plus an explicit "Refresh" button, matching the app's existing explicit-refresh convention. Verified live against a real Google Calendar feed.
  - [x] Each event displays its source label
  - [x] List updates when calendar feeds are added, removed, or refreshed


## M5 — Projects & Horizon

Mid-to-long-range planning views.

- **Projects view: tracking large tasks & delegated work** (M) — https://github.com/sunix/todowai/issues/25
  Build the Projects screen: cards for large tasks, parallel work, and AI-delegated work, with status badges and progress indicators.
  - [ ] Projects display status (e.g. blocked, in progress, AI-delegated) and progress
  - [ ] An AI-delegated project links to its pending suggestions for review

- **Horizon view: week/month/year grouping with manual move** (M) — https://github.com/sunix/todowai/issues/26
  Build the Horizon screen: todos/projects grouped into This Week / This Month(s) / This Year columns, with a manual way to move an item between horizons.
  - [ ] Items display in the correct column based on their horizon tag
  - [ ] Moving an item updates its stored horizon and re-renders it in the new column

- **Horizon: AI-suggested reassignment with confirm/dismiss** (M) — https://github.com/sunix/todowai/issues/27
  Implement AI-suggested horizon reassignments (e.g. promoting a stale weekly item to monthly), requiring explicit user confirmation or dismissal.
  - [ ] A suggested reassignment is clearly marked as AI-proposed and unapplied until confirmed
  - [ ] Dismissing a suggestion leaves the item's horizon unchanged


## M6 — Meetings

Lightweight meeting note representation.

- **Meetings view: list + frontmatter note preview** (S) — https://github.com/sunix/todowai/issues/28
  Build the Meetings screen: a list of meeting notes (plain Markdown with type/date/attendees frontmatter) with a preview pane.
  - [ ] Meeting notes are discovered from frontmatter (type: meeting), not a separate data store
  - [ ] Selecting a meeting shows its frontmatter and body content


## M7 — AI reorganization & delegation guardrails

Cross-cutting AI behavior and its safety boundaries.

- **AI note reorganization engine** (L) — https://github.com/sunix/todowai/issues/29
  Implement the AI capability to propose reorganization of the note base (e.g. cleanup, restructuring) for user review, per the 'AI reorganizes notes' user story.
  - [ ] AI-proposed reorganization changes are presented as a reviewable diff, not applied silently
  - [ ] User can accept, edit, or reject each proposed change

- **AI conversation storage in dedicated subfolder** (S) — https://github.com/sunix/todowai/issues/30
  Store AI conversation history in a dedicated subfolder within the same git repository as the notes (e.g. todowai/.ai/).
  - [ ] Conversations are written as files under the dedicated subfolder
  - [ ] Conversation files are versioned via the same git history as notes

- **Enforce confirm-before-write guardrails across all AI actions** (M) — https://github.com/sunix/todowai/issues/31
  Add a shared guardrail layer ensuring every AI-originated change (capture drafts, next-action suggestions, horizon reassignments, reorganization) requires explicit user confirmation, and that the AI never writes to external services.
  - [ ] Automated check/test confirms no code path commits an AI-originated change without a prior explicit user confirmation event
  - [ ] No code path makes a write call to an external service (calendar, email, etc.) from AI logic


## M8 — Platform packaging

Turning the web UI + Rust core into installable desktop and mobile apps. One UI codebase and one
Rust core (from M1) reused across every target — see [ADR-001](../specification/decisions.md).

- **Tauri desktop wrapper** (M) — https://github.com/sunix/todowai/issues/32
  Package the web UI as a desktop app using Tauri, backed by the same Rust core (#59) via Tauri's IPC bridge instead of an HTTP API or the File System Access API.
  - [ ] Desktop build launches and can read/write a configured local repo folder via the shared Rust core
  - [ ] Same core UI/logic as the web app, no forked codebase

- ~~Capacitor mobile wrapper — #33~~ **Superseded**, see #63.

- **Tauri mobile wrapper (Rust core via FFI)** (L) — https://github.com/sunix/todowai/issues/63
  Replaces #33 (closed): mobile packaging moves from Capacitor + sandboxed isomorphic-git to Tauri, reusing the same web UI and Rust core via Tauri's IPC bridge — no local server, no browser CORS restriction.
  - [ ] Mobile build (iOS and Android) launches via Tauri, reusing the existing web UI with no forked UI codebase
  - [ ] Git/filesystem operations run through the same Rust core as the backend/desktop, via Tauri's IPC bridge
  - [ ] Sync to/from the configured remote works using the same sync engine design as the backend


## M9 — Privacy & hardening

Final verification against the privacy and safety requirements.

- **Security review: confirm no content encryption gaps** (S) — https://github.com/sunix/todowai/issues/34
  Verify the app relies solely on private-repo + transport security (SSH/HTTPS) for privacy in v1, with no accidental plaintext leakage (e.g. logs, caches, crash reports containing note content).
  - [ ] No note or conversation content appears in logs, crash reports, or telemetry
  - [ ] Documented confirmation that encryption/GPG is intentionally deferred, not accidentally missing

- **Vault-collision safety checks** (S) — https://github.com/sunix/todowai/issues/35
  Add defensive checks ensuring the app never writes outside its configured subfolder, protecting an existing Obsidian vault's other content and .obsidian/ configuration. **Note:** #11 already delivered most of this (the `.git`/`.obsidian` guard and the outside-subfolder create/delete restrictions, with an automated test attempting a rejected write) as part of resolving the vault-access design discussion — worth revisiting this issue's remaining scope (real-vault manual test?) before starting it rather than redoing what #11 already covers.
  - [ ] Automated test attempts a write outside the configured subfolder and confirms it is rejected
  - [ ] Manual test against a real Obsidian vault shows no unexpected files/changes outside the subfolder


