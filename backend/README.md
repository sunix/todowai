# Todowai — Backend

Rust service exposing git/filesystem operations over HTTP, backed by [`git2`](https://docs.rs/git2) (libgit2 bindings) against a real filesystem path. Replaces the browser-only isomorphic-git + File System Access API approach — see [`specification/decisions.md`](../specification/decisions.md), ADR-001.

Also serves the built web UI ([`../app/`](../app/)) as static files, so the whole app ships as one process / one Docker image.

## Local development

Requires the Rust toolchain (`cargo`, `rustc`) and, for `git2`'s vendored libgit2 build, `cmake`, `pkg-config`, and `libssl-dev` (or equivalent) available on the system.

```bash
cargo build          # debug build
cargo test           # unit + integration tests
cargo run            # starts the server (see Configuration below)
cargo clippy --all-targets
```

## Configuration

Set via environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `TODOWAI_REPO_PATH` | `/vault` | Path to the git repository to serve (a Docker volume mount in the self-hosted deployment) |
| `TODOWAI_SUBFOLDER` | `todowai` | Where Todowai's own files live. Outside it, existing files can be read and edited (e.g. notes in a coexisting Obsidian vault), but not created or deleted by Todowai. Set once at startup, not re-picked per session. |
| `TODOWAI_UI_DIR` | `./static` | Path to the built web UI's static assets |
| `PORT` | `8080` | HTTP port to listen on |
| `TODOWAI_REMOTE_URL` | _(none)_ | Optional git remote to sync with. Empty means no sync — see below. |
| `TODOWAI_REMOTE_USERNAME` / `TODOWAI_REMOTE_TOKEN` | _(empty)_ | Credentials for the remote above, if it needs them (e.g. a GitHub PAT) |
| `TODOWAI_SYNC_AUTHOR_NAME` / `TODOWAI_SYNC_AUTHOR_EMAIL` | `Todowai Sync` / `todowai-sync@example.invalid` | Identity used only for a synthetic merge commit a non-fast-forward pull can produce — unrelated to the commit form's per-commit author fields |
| `TODOWAI_PUSH_DEBOUNCE_MS` | `4000` | How long a push waits after a commit, coalescing several commits made in quick succession into one push |
| `TODOWAI_BACKGROUND_PULL_INTERVAL_MS` | `300000` (5 min) | How often to pull in the background, in addition to once on startup |

`.git/` and `.obsidian/` are always off-limits — rejected on any read/write, and never listed or staged — regardless of subfolder configuration.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/repository` | Snapshot: folder name, subfolder, files, history, pending changes |
| `GET` | `/api/repository/file?path=...` | Read a file's contents |
| `PUT` | `/api/repository/file` | Write a file (`{ path, content }`), returns the updated snapshot |
| `POST` | `/api/repository/commit` | Stage and commit every pending change (`{ message, authorName, authorEmail }`); schedules a debounced push |
| `PUT` | `/api/sync/remote` | Set the remote config (`{ url, username, token }`), or `null` to clear it — overrides the `TODOWAI_REMOTE_*` env vars without a restart, in-memory only |
| `GET` | `/api/sync/status` | Current sync status (`synced` / `offline` / `conflict` / `error`) and a message |
| `POST` | `/api/sync/pull` | Pull immediately (in addition to on startup and the background interval) |
| `POST` | `/api/sync/push` | Push (`{ immediate }`, default `true`) — `immediate: false` uses the same debounce as a commit |

Everything else falls back to serving the web UI's static assets (hash-based client routing means the server never needs to handle deep paths itself).

Sync never blocks a request or throws into the UI — a pull/push failure (no network, a merge conflict, no remote configured) always comes back as a normal `SyncResult`, never a crash. A merge conflict aborts cleanly back to the pre-merge state (local work untouched, just unsynced) rather than leaving the working tree full of conflict markers with no resolution UI to handle them yet — that's issue #13's job.

## Docker

Build and run from the repo root (the image bundles both this service and the web UI build):

```bash
docker build -t todowai .
docker run -p 8080:8080 -v /path/to/your/vault:/vault todowai
```

Then open `http://localhost:8080`.
