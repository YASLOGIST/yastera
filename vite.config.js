import { defineConfig } from 'vite';

// The app is served through a proxied preview host (e.g. https://5173-<sandbox>.e2b.app),
// so the dev server must bind on all interfaces and accept that forwarded Host header.
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.e2b.app', 'localhost'],
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: ['.e2b.app', 'localhost'],
  },
});
