import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    // isomorphic-git (and its dependencies) assume a Node-like environment —
    // they reference `Buffer` and `process` directly, which don't exist as
    // browser globals. Without this, reading any existing git object (e.g.
    // commit history, or committing onto a non-empty repo) throws
    // `ReferenceError: Buffer is not defined` at runtime.
    nodePolyfills({
      include: ['buffer', 'process'],
    }),
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
});
