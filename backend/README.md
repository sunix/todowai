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
| `TODOWAI_AI_PROVIDER` | _(none)_ | Optional AI provider for #17's capture-filing assist: `anthropic`, `openai`, `gemini`, `mistral`, `groq`, or `ollama`. Empty/unrecognized means AI features are simply unavailable until configured via Settings. |
| `TODOWAI_AI_API_KEY` | _(empty)_ | Credential for the provider above. Not needed for `ollama` (a local, unauthenticated server). |
| `TODOWAI_AI_MODEL` | _(none)_ | Model name to request. Optional for `anthropic` (defaults to `claude-opus-5`); required for every other provider — there's no safe default model ID to guess for those. |
| `TODOWAI_AI_BASE_URL` | _(provider default)_ | Overrides the provider's default endpoint — mainly for `ollama` (a different host/port) or a self-hosted OpenAI-compatible server. |
| `TODOWAI_AI_MAX_COMPLETION_TOKENS` | `8192` | Ceiling on the model's response length for every AI feature. Raise it if a capture-classify response gets truncated (an "EOF while parsing a string" error); lower it to cap cost/latency. |

`.git/` and `.obsidian/` are always off-limits — rejected on any read/write, and never listed or staged — regardless of subfolder configuration.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/repository` | Snapshot: folder name, subfolder, files, history, pending changes |
| `GET` | `/api/repository/file?path=...` | Read a file's contents |
| `PUT` | `/api/repository/file` | Write a file (`{ path, content }`), returns the updated snapshot |
| `POST` | `/api/repository/commit` | Stage and commit every pending change (`{ message, authorName, authorEmail }`); schedules a debounced push |
| `GET` | `/api/sync/remote` | The configured remote, if any — `{ url, username, configured }`. Never includes the token. |
| `PUT` | `/api/sync/remote` | Set the remote config (`{ url, username, token }`), or `null` to clear it — overrides the `TODOWAI_REMOTE_*` env vars without a restart, in-memory only. An empty `token` on an otherwise non-empty update preserves whatever token was already configured rather than wiping it (so Settings can pre-fill `url`/`username` from the GET above without risking the token). |
| `GET` | `/api/sync/remotes` | Remotes already configured in `.git/config` (`[{ name, url }]`, e.g. `origin`) — read-only, for the UI to suggest instead of requiring the URL to be retyped |
| `GET` | `/api/sync/status` | Current sync status (`synced` / `offline` / `conflict` / `error`) and a message |
| `POST` | `/api/sync/pull` | Pull immediately (in addition to on startup and the background interval) |
| `POST` | `/api/sync/push` | Push (`{ immediate }`, default `true`) — `immediate: false` uses the same debounce as a commit |
| `GET` | `/api/sync/conflict` | The real conflict (if any) still pending resolution — `{ files: [...] }`, or `null` when clean |
| `POST` | `/api/sync/conflict/resolve` | Resolve a pending conflict (`{ resolutions: [{ path, keep: "mine" \| "theirs" }] }`, one entry per conflicted file), then pushes the result |
| `GET` | `/api/ai/config` | The configured AI provider, if any — `{ provider, model, baseUrl, maxCompletionTokens, configured }`. Never includes the API key. |
| `PUT` | `/api/ai/config` | Set the AI provider config (`{ provider, apiKey, model, baseUrl, maxCompletionTokens }`), or `null` to clear it — overrides the `TODOWAI_AI_*` env vars without a restart, in-memory only. An empty `apiKey` on an otherwise non-empty update preserves whatever key was already configured rather than wiping it, same as `/api/sync/remote`'s token handling. |
| `POST` | `/api/ai/classify` | Propose a type/title/content classification for a captured note (`{ text }`) via the configured provider — `400` if none is configured |

Everything else falls back to serving the web UI's static assets (hash-based client routing means the server never needs to handle deep paths itself).

Sync never blocks a request or throws into the UI — a pull/push failure (no network, a merge conflict, no remote configured) always comes back as a normal `SyncResult`, never a crash. Non-overlapping concurrent edits (different files, or non-overlapping hunks) merge automatically with no user action, whether that's discovered via a background pull or a rejected push retried through the same 3-way merge. A genuine overlapping edit aborts cleanly back to the pre-merge state (local work untouched, just unsynced) and surfaces the conflicted file(s) via `/api/sync/conflict` for a keep-mine/keep-theirs resolution through `/api/sync/conflict/resolve` — a full diff/merge editor is out of scope for v1.

## Docker

Build and run from the repo root (the image bundles both this service and the web UI build):

```bash
docker build -t todowai .
docker run -p 8080:8080 -v /path/to/your/vault:/vault todowai
```

Then open `http://localhost:8080`.
