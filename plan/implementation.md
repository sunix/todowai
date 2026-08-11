# Implementation Plan

Derived from `specification/specs.md` (Phase 1) and `mockup/README.md` (Phase 2). Milestones are ordered by dependency — each should ship before the next begins.

## M1 — Core storage & sync engine

Foundational git-backed storage layer everything else depends on.

- **Scaffold PWA project shell** (S) — https://github.com/sunix/todowai/issues/9
  Set up the PWA build tooling and a routing shell for the seven screens (Capture, Notebook, Next Action, Projects, Horizon, Meetings, Settings) defined in specification/specs.md.
  - [ ] Project builds and runs locally as an installable PWA
  - [ ] Shell navigates between seven empty placeholder screens matching mockup/index.html's structure

- **Integrate isomorphic-git with File System Access API storage adapter** (M) — https://github.com/sunix/todowai/issues/10
  Wire up isomorphic-git as the sole git engine (per NFR) and implement the desktop-browser storage adapter using the File System Access API to read/write a real folder on disk.
  - [ ] Can open an existing local git repo folder and read its contents
  - [ ] Can commit and read history via isomorphic-git, no shell-out to a native git binary

- **Settings: configurable git repo path + subfolder** (M) — https://github.com/sunix/todowai/issues/11
  Implement the Settings screen fields for repo path and Todowai subfolder (e.g. todowai/), supporting pointing at an existing Obsidian vault without colliding with .obsidian/ or other vault content.
  - [ ] User can select a folder and a subfolder name
  - [ ] All app reads/writes are confined to the configured subfolder
  - [ ] Verified no writes ever touch .obsidian/ or files outside the subfolder

- **Offline-first sync engine (pull/push scheduling)** (L) — https://github.com/sunix/todowai/issues/12
  Implement the sync engine per the NFR: pull before opening a page/main screen and periodically in the background while foregrounded; push immediately after AI edits and debounced after manual edits. Must never block the UI when offline (fail silently, retry in background).
  - [ ] Pull attempts on page open and on a background interval; failures never block rendering
  - [ ] AI edits push immediately; manual edits push after a short idle debounce
  - [ ] Verified behavior with network disabled: app remains usable, queues changes, and syncs once back online

- **Non-blocking git 3-way merge conflict handling** (M) — https://github.com/sunix/todowai/issues/13
  Handle concurrent edits between devices using git's 3-way merge; when a true conflict occurs, surface it as a dismissible, non-blocking item rather than halting editing.
  - [ ] Non-overlapping concurrent edits merge automatically with no user action
  - [ ] Overlapping edits produce a conflict entry the user can resolve later without being blocked from continuing other edits


## M2 — Notebook & Capture

Core note-taking surface and the capture-to-filing flow.

- **Notebook view: file tree + markdown viewer/editor** (M) — https://github.com/sunix/todowai/issues/14
  Build the Notebook screen: an Obsidian-style file tree (done/doing/backlog/.ai folders) and a markdown viewer/editor pane for the selected file.
  - [ ] Tree lists real files from the configured subfolder
  - [ ] Selecting a file loads and allows editing its raw markdown, including frontmatter

- **Capture view: quick-add note UI** (S) — https://github.com/sunix/todowai/issues/15
  Build the Capture screen's quick-add form and the Recently Captured list, consistent across mobile, browser, and desktop.
  - [ ] A typed note is saved and appears at the top of Recently Captured immediately
  - [ ] Works with touch and keyboard input

- **Capture filing flow — manual path** (M) — https://github.com/sunix/todowai/issues/16
  From a captured note, let the user manually choose a destination type (todo / meeting / status / project note) and edit the resulting draft before it is saved into the Notebook.
  - [ ] User can pick a type and edit title/content
  - [ ] Nothing is written to the Notebook until the user explicitly saves
  - [ ] Saved item appears in the correct Notebook location for its type

- **Capture filing flow — AI-proposed path** (M) — https://github.com/sunix/todowai/issues/17
  From a captured note, let the AI propose a classification (type, title, content) as a fully editable draft, per the confirm-first pattern used elsewhere in the app.
  - [ ] AI drafts type/title/content instead of just a label
  - [ ] User can edit any field before saving
  - [ ] Nothing is written to the Notebook without explicit user confirmation

- **Frontmatter conventions & parser for note types** (S) — https://github.com/sunix/todowai/issues/18
  Define and implement shared frontmatter parsing/writing for todo, meeting, status, and project-note types (e.g. type, status, project, date, attendees fields).
  - [ ] Frontmatter is parsed consistently across Notebook, Meetings, Horizon, and Capture
  - [ ] Round-tripping a note (read, edit, save) preserves unrelated frontmatter fields


## M3 — Current status & Next Action

The moment-to-moment decision-support loop.

- **Current-status field (task or situational context)** (S) — https://github.com/sunix/todowai/issues/19
  Implement a persistent current-status field the user can view and set, accepting either a todo/task reference or a free-text situational context (e.g. 'coffee break', 'commuting').
  - [ ] Status is visible on Next Action and persists across sessions/devices via the synced repo
  - [ ] Both a task-linked status and a free-text situational status are supported

- **Next Action: AI next-todo suggestion engine** (L) — https://github.com/sunix/todowai/issues/20
  Implement the suggestion engine that proposes a next todo from current status, notes, backlog, and the connected calendar feed(s), always requiring explicit user confirmation before it is treated as decided.
  - [ ] Suggestion incorporates status, backlog contents, and upcoming calendar events
  - [ ] Confirm adds the item to today's plan; nothing is auto-added without confirmation
  - [ ] Rejecting/asking for another suggestion produces a different candidate

- **Situational-context small-suggestion behavior** (M) — https://github.com/sunix/todowai/issues/21
  When the current status is a situational context rather than a task, bias suggestions toward small, fitting backlog items (e.g. a quick look at a side project, one page of a book) instead of full tasks.
  - [ ] A situational status like 'coffee break' surfaces a small backlog item, not a large task
  - [ ] A task-linked status surfaces a normal next-todo suggestion


## M4 — Calendar integration

Read-only awareness of what's already planned.

- **Settings: multiple labeled calendar feed URLs** (S) — https://github.com/sunix/todowai/issues/22
  Implement Settings UI to add, label, and remove one or more read-only calendar feed URLs (e.g. iCal links).
  - [ ] User can add/remove/rename multiple feed entries
  - [ ] Configuration persists in the synced repo (not just local device state)

- **ICS feed fetch + parse (read-only, multi-source)** (M) — https://github.com/sunix/todowai/issues/23
  Fetch and parse each configured calendar feed URL client-side (no OAuth, no write access) and merge events from all configured sources.
  - [ ] Events from two or more feeds are correctly merged and de-duplicated by time
  - [ ] A failing feed does not block or crash the fetch of the others

- **Upcoming list in Next Action, labeled by source** (S) — https://github.com/sunix/todowai/issues/24
  Show merged upcoming events in the Next Action view, each labeled with its source calendar (e.g. 'Work', 'Personal').
  - [ ] Each event displays its source label
  - [ ] List updates when calendar feeds are added, removed, or refreshed


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

Turning the PWA core into installable desktop and mobile apps.

- **Tauri desktop wrapper** (M) — https://github.com/sunix/todowai/issues/32
  Package the PWA as a desktop app using Tauri, using native filesystem access in place of the File System Access API where beneficial.
  - [ ] Desktop build launches and can read/write a configured local repo folder
  - [ ] Same core UI/logic as the PWA, no forked codebase

- **Capacitor mobile wrapper** (L) — https://github.com/sunix/todowai/issues/33
  Package the PWA as iOS/Android apps using Capacitor, with the git repo stored in app-sandboxed storage and synced via push/pull to a remote (no shared-folder access, per platform constraints).
  - [ ] Mobile build launches and performs isomorphic-git operations against sandboxed local storage
  - [ ] Sync to/from the configured remote works over the offline-first sync engine from M1


## M9 — Privacy & hardening

Final verification against the privacy and safety requirements.

- **Security review: confirm no content encryption gaps** (S) — https://github.com/sunix/todowai/issues/34
  Verify the app relies solely on private-repo + transport security (SSH/HTTPS) for privacy in v1, with no accidental plaintext leakage (e.g. logs, caches, crash reports containing note content).
  - [ ] No note or conversation content appears in logs, crash reports, or telemetry
  - [ ] Documented confirmation that encryption/GPG is intentionally deferred, not accidentally missing

- **Vault-collision safety checks** (S) — https://github.com/sunix/todowai/issues/35
  Add defensive checks ensuring the app never writes outside its configured subfolder, protecting an existing Obsidian vault's other content and .obsidian/ configuration.
  - [ ] Automated test attempts a write outside the configured subfolder and confirms it is rejected
  - [ ] Manual test against a real Obsidian vault shows no unexpected files/changes outside the subfolder


