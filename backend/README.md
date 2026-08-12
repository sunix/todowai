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
| `TODOWAI_UI_DIR` | `./static` | Path to the built web UI's static assets |
| `PORT` | `8080` | HTTP port to listen on |

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/repository` | Snapshot: folder name, files, history, pending changes |
| `GET` | `/api/repository/file?path=...` | Read a file's contents |
| `PUT` | `/api/repository/file` | Write a file (`{ path, content }`), returns the updated snapshot |
| `POST` | `/api/repository/commit` | Stage and commit every pending change (`{ message, authorName, authorEmail }`) |

Everything else falls back to serving the web UI's static assets (hash-based client routing means the server never needs to handle deep paths itself).

Scope note: subfolder configuration and vault-access rules (`.obsidian`/`.git` exclusion, create/delete confined to a configured subfolder) are issue #60's job, not implemented here yet. Remote git sync (pull/push) is issue #62's job.

## Docker

Build and run from the repo root (the image bundles both this service and the web UI build):

```bash
docker build -t todowai .
docker run -p 8080:8080 -v /path/to/your/vault:/vault todowai
```

Then open `http://localhost:8080`.

Every PR also gets its own preview image published to GHCR automatically — comment `/preview` on the PR and look for the "Backend preview image published!" comment with a ready-to-run `docker run` command (see #66).
