import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Todowai',
        short_name: 'Todowai',
        description: 'A privacy-first AI-assisted note and task companion for deciding what to do next.',
        theme_color: '#14161b',
        background_color: '#14161b',
        display: 'standalone',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  server: {
    // The production image serves the built UI and the API from the same origin (see
    // backend/src/main.rs), so the app code just uses relative /api/... paths. This proxy
    // makes that work in local dev too — `npm run dev` talks to Vite's own dev server, which
    // has no /api routes of its own, so anything under /api is forwarded to a backend running
    // locally via `cargo run` (see backend/README.md) instead of 404ing.
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
