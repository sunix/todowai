# Todowai — App

Vite + TypeScript PWA shell. No UI framework, to keep things simple to wrap later with Tauri (desktop and mobile — see [`specification/decisions.md`](../specification/decisions.md), ADR-001).

Still contains its own in-browser git/filesystem code for now (from the now-superseded #10/#11/#12 — see ADR-001); it's being swapped to call the [`backend/`](../backend/) Rust service instead (see issue #61).

## Local development

```bash
npm install
npm run dev       # dev server with hot reload
npm run build     # production build (dist/), generates the PWA manifest + service worker
npm run preview   # serve the production build locally
```
