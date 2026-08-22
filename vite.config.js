// Vite configuration for the normal build (what you deploy to Cloudflare Pages).
// "base: './'" makes all asset paths relative, so the built site works from any
// folder or sub-path without changes.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // Bind to the IPv4 loopback explicitly.
    // Without this, Vite listens on the IPv6 loopback ([::1]) only, and on a
    // machine where IPv6 is blocked (a VPN kill switch, for example) the dev
    // server becomes unreachable from every browser. Forcing 127.0.0.1 keeps
    // the address bar and the server on the same road.
    host: '127.0.0.1',
    port: 5173,
    open: false,
  },
});
