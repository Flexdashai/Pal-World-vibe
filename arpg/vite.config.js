import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The ARPG is a self-contained project rooted at arpg/. node_modules resolves
// upward to the repository root, so `three` is shared with the sibling project
// and there is nothing extra to install.
export default defineConfig({
  root: resolve(import.meta.dirname),
  // Bind IPv4 explicitly: the default `localhost` resolves to ::1 on some hosts,
  // which the capture harness (127.0.0.1) cannot reach.
  // `hmr: false` when the capture harness owns the server (MN_NO_HMR=1): a file
  // saved by a concurrently-working agent otherwise reloads the page mid-capture
  // and playwright fails with "Execution context was destroyed".
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    hmr: process.env.MN_NO_HMR ? false : undefined,
    fs: { allow: [resolve(import.meta.dirname, '..')] },
  },
  preview: { host: '127.0.0.1', port: 4273 },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
