# Todowai — App

Vite + TypeScript PWA shell. No UI framework, to keep things simple to wrap later with Tauri (desktop and mobile — see [`specification/decisions.md`](../specification/decisions.md), ADR-001).

Talks to the [`backend/`](../backend/) Rust service for all git/filesystem operations via relative `/api/...` requests — no in-browser git engine (the old File System Access API + isomorphic-git approach from the superseded #10/#11/#12 is gone, see ADR-001).

## Local development

The dev server proxies `/api/...` to a backend running locally on port 8080 (see `vite.config.ts` and [`backend/README.md`](../backend/README.md)) — start that first (`cargo run` in `backend/`, pointed at a test repo via `TODOWAI_REPO_PATH`), then:

```bash
npm install
npm run dev       # dev server with hot reload, proxying /api to the local backend
npm run build     # production build (dist/), generates the PWA manifest + service worker
npm run preview   # serve the production build locally
```

`npm run build`'s output (`dist/`) is what the backend's Docker image bundles and serves directly — see the root [`Dockerfile`](../Dockerfile).
