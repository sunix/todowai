# Project Specification

> This file is owned by the human. Use the `refine-specs` skill to iterate with the agent.
> Sections marked `[CONFIRMED]` have been reviewed and agreed upon.

---

## Project Summary

Todowai is a personal productivity application that helps a user decide what to do at any given moment. It should keep memory of what the user has done, is doing, and wants to do inside a large Obsidian-style Markdown notebook, let the user capture notes from mobile, browser, and desktop, and use AI to reorganize notes, help follow projects, support delegated AI work, and suggest what to do next across large tasks, parallel work, and meetings.

---

## Actors

| Actor | Role |
|-------|------|
| Individual user | Captures notes, tracks what they have done / are doing / want to do, and follows projects from multiple devices. |
| AI assistant | Reorganizes notes, helps follow projects, supports delegated work, and proposes what the user should do next. |

---

## Use Cases / User Stories [CONFIRMED]

- **As an** individual user, **I want to** capture notes from mobile, browser, or desktop, **so that** I can record information from anywhere.
- **As an** individual user, **I want to** keep track of what I have done, what I am doing, and what I want to do, **so that** I have a personal history of my work and intentions.
- **As an** individual user, **I want the AI to** reorganize my notes, **so that** my note base stays cleaner and easier to use.
- **As an** individual user, **I want the AI to** suggest what I should do next, **so that** I can decide what to work on at each moment.
- **As an** individual user, **I want to** track large tasks, work happening in parallel, and meetings, **so that** I can follow ongoing commitments.
- **As an** individual user, **I want to** delegate some work to AI, **so that** the application can help me move projects forward.
- **As an** individual user, **I want to** configure which git repository (and optional subfolder) stores my notes, **so that** I can reuse an existing Obsidian vault or start a dedicated one.
- **As an** individual user, **I want to** see and set my current status — either a todo/task or a situational context like "coffee break" or "taking the metro" — **so that** I always have a clear picture of what I'm doing right now.
- **As an** individual user, **I want the AI to** propose my next todos based on my current status, notes, backlog, and calendar, and confirm them with me, **so that** nothing gets added to my plan without my approval.
- **As an** individual user, **I want to** connect a read-only calendar feed URL, **so that** the AI knows what I already have planned.
- **As an** individual user, **I want the AI to** suggest a small, fitting backlog item when my status is a situational context rather than a task — **so that** short or passive moments (e.g. a coffee break, the metro) are still put to good use, like glancing at a side project on my phone or reading one page of a book.
- **As an** individual user, **I want to** classify todos and projects by a week / month(s) / year horizon, **so that** I can distinguish near-term priorities from longer-term intentions.
- **As an** individual user, **I want to** move an item between horizons myself, **so that** I can re-prioritize as things change.
- **As an** individual user, **I want the AI to** suggest moving an item between horizons and confirm it with me, **so that** my horizons stay realistic without the AI silently reorganizing my plan.
- **As an** individual user, **I want to** connect more than one read-only calendar feed, **so that** events from multiple calendars (e.g. work and personal) are reflected in what's upcoming.
- **As an** individual user, **I want to** turn a captured note into a specific item (todo, meeting, status, or project note) either by choosing the type myself, or by letting the AI propose a fully-drafted, editable item, **so that** I can file captures quickly with as much or as little AI help as I want.
- **As an** individual user, **I want to** read, reference, and edit my existing notes anywhere in the vault (not just inside Todowai's own subfolder), **so that** Todowai can work with the notes I already have instead of only the ones it creates itself.

---

## Screens / Views [CONFIRMED]

- **Capture view:** a quick way to add or edit notes from mobile, browser, and desktop contexts. Each captured note can be filed manually (user picks the type: todo/meeting/status/project note) or via an AI-proposed draft (type, title, and content pre-filled); either way the item stays in an editable draft until the user explicitly saves it into the Notebook.
- **Notebook view:** an Obsidian-style Markdown workspace containing what the user has done, is doing, and wants to do.
- **Next action view:** shows the user's current status (task or situational context) and the AI's proposed next todo, which the user confirms or rejects before it's treated as decided.
- **Project tracking view:** a place to follow large tasks, parallel work, and delegated AI work.
- **Horizon view:** todos and projects grouped into This Week / This Month(s) / This Year columns; the user can move an item between horizons, and the AI can propose reassignments (e.g. promoting a stale weekly item to monthly) that the user confirms or rejects.
- **Meetings view:** a place to keep track of meeting-related notes and commitments.
- **Settings view:** configure the git repository path/subfolder and one or more read-only calendar feed URLs (each labeled, e.g. "Work," "Personal").

---

## Acceptance Criteria [CONFIRMED]

- The product lets the user create and edit notes from mobile, browser, and desktop environments.
- The product keeps track of what the user has done, is doing, and wants to do in an Obsidian-style Markdown note base.
- The AI can reorganize notes to keep them cleaner.
- The AI can suggest what the user should do next.
- The product supports tracking large tasks, parallel work, and meetings.
- The product supports workflows where some work can be delegated to AI.
- The privacy model keeps notes as private as possible.
- The product works with any user-configured git repository and subfolder, including an existing Obsidian vault, without colliding with the vault's own files.
- `.git/` and `.obsidian/` are fully off-limits — never read, shown in the file browser, or written to — since the latter can hold sensitive plugin data and corrupting it would break the user's Obsidian setup.
- Outside the configured Todowai subfolder, the user can read and edit existing notes anywhere in the vault, but cannot create or delete files there through Todowai — new files Todowai creates always go inside its own subfolder. A file deleted outside the subfolder by another tool is not staged or committed by Todowai; it's outside what Todowai manages.
- Inside the configured Todowai subfolder, full create/read/update/delete is allowed.
- The product supports offline editing on each device; conflicting edits are reconciled via git's 3-way merge and surfaced non-blockingly, never halting further editing.
- The product maintains a current-status field the user can view and set, accepting either a todo/task or a situational context (e.g. "coffee break," "commuting").
- The AI proposes next todos from the user's status, notes, backlog, and connected calendar feed, and always requires explicit user confirmation before treating a suggestion as decided.
- When the current status is a situational context rather than a task, the AI suggests a small, fitting backlog item (e.g. a look at a side project on the phone, one page of a book) instead of a full task.
- Meetings are represented as plain Markdown notes using a lightweight frontmatter convention (e.g. `type: meeting`, `date`, `attendees`), not a dedicated data object or calendar-synced entity.
- AI conversations are stored in a dedicated subfolder within the same git repository as the notes.
- No note or conversation content is encrypted in v1; privacy relies on the repository being private plus standard git transport security (SSH/HTTPS).
- Todos and projects can be tagged with a horizon (week / month(s) / year) and viewed grouped by that horizon.
- The user can move an item between horizons manually; the AI can propose moving an item between horizons, but the move only takes effect after explicit user confirmation.
- Settings supports configuring one or more read-only calendar feed URLs, each with a label; the upcoming/calendar view merges and labels events from all configured feeds.
- From a captured note, the user can either manually pick a destination type (todo / meeting / status / project note), or ask the AI to propose one.
- When the AI proposes a classification, it drafts an actual editable item (title, frontmatter, content) — not just a label — that the user can adjust before it's saved.
- Nothing is filed into the Notebook without explicit user confirmation, whether manually classified or AI-drafted.

---

## Non-Functional Requirements [CONFIRMED]

- Privacy is a primary requirement: notes stay as private as possible via a private git repository and standard git transport security; no content encryption in v1 (GPG/content encryption deferred to a later phase).
- Notes and AI conversations live in a single user-configurable private git repository, with a dedicated subfolder for AI conversations — not a repository hardcoded by the app.
- Architecture: a shared Rust core (via `git2-rs`/`gitoxide`) implements all git, filesystem, and sync logic — one engine, identical behavior on every platform. The existing web UI (HTML/CSS/TypeScript) is the single UI codebase, reused everywhere rather than rebuilt per platform:
  - **Self-hosted backend:** the Rust core runs as an HTTP service, bundled with the web UI into a single Docker image — one `docker run` self-hosts both. The same image is intended to run on the user's own cloud infrastructure later (see Out of Scope).
  - **Installable native apps (desktop & mobile):** the same Rust core and the same web UI are packaged via Tauri, which wraps the web UI in a native webview and exposes the Rust core through its own IPC bridge instead of browser `fetch()` — sidestepping the git-smart-HTTP CORS restriction entirely (GitHub's git endpoints send no CORS headers, so a browser page can never call them directly), with no server required for anyone who just installs the app.
  - Browser-only operation with no backend (the original File System Access API + isomorphic-git approach built across #9–#12) is fully superseded by this model, not kept as a fallback; those issues will be revisited in the plan.
- Offline-first: every device commits locally at any time regardless of sync state. Sync behavior:
  - **Pull:** before opening a page or the main screen, and periodically in the background while the app is foregrounded (to keep status/suggestions reasonably fresh across devices). If offline, the pull fails silently, the page opens with local/cached state, and it retries in the background — it never blocks the UI.
  - **Push:** immediately after AI edits (discrete, meaningful commits); debounced after manual user edits (e.g. after a short idle period or on closing a note) rather than on every keystroke, to avoid spamming the remote and draining battery/data on mobile.
  - Conflicts are resolved via git's 3-way merge and surfaced non-blockingly, never blocking further edits.
- Calendar integration is read-only via one or more user-configured feed URLs (e.g. iCal links), each merged and labeled by source; no write access to external calendar or other external services in v1.

---

## Out of Scope [CONFIRMED]

- Encryption/GPG of notes and conversations (deferred to a later phase).
- AI writing to external services (e.g. creating/modifying calendar events, sending emails).
- Autonomous, unsupervised AI execution outside the note base.
- Multi-user or real-time collaborative editing (this product is single-user, multi-device).
- OAuth-based calendar provider integrations or authenticated accounts (multiple read-only feed URLs are supported; provider authentication and write access are not).
- Hosted/cloud deployment of the self-hosted backend (authentication, TLS, secure multi-device remote access over the internet) is deferred to a later phase; v1 targets local self-hosting (Docker) and installable native apps only.

---

## Open Questions

None currently open — the initial open questions (platform sequencing, git storage model, AI conversation storage, encryption, concurrent editing, meeting representation, AI delegation scope) were resolved during PR #7 review; see the confirmed sections above.
