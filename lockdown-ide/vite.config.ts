import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const electronOutDir = path.join(rootDir, 'dist-electron');

export default defineConfig({
  // The renderer lives in src/ (src/index.html is the entry point).
  root: path.join(rootDir, 'src'),
  // Relative asset URLs so the production build can be served from the
  // custom lockdown:// protocol instead of file://.
  base: './',
  publicDir: false,
  build: {
    outDir: path.join(rootDir, 'dist'),
    emptyOutDir: true,
    // Monaco's language workers are large by nature; don't warn about them.
    chunkSizeWarningLimit: 10_000,
  },
  // Monaco workers are ES modules.
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
  plugins: [
    electron({
      main: {
        entry: path.join(rootDir, 'electron/main.ts'),
        onstart({ startup }) {
          // vite-plugin-electron passes --no-sandbox by default. Keep the
          // Chromium sandbox on everywhere except Linux, where a fresh
          // node_modules install has no SUID sandbox helper and would crash.
          // Pass the project root explicitly: Electron is spawned from Vite's root (src/).
          const args = process.platform === 'linux' ? [rootDir, '--no-sandbox'] : [rootDir];
          return startup(args).then(() => undefined);
        },
        // Unminified: the main process is small and easier to audit this way.
        vite: { build: { outDir: electronOutDir, minify: false } },
      },
      preload: {
        input: path.join(rootDir, 'electron/preload.ts'),
        vite: {
          build: {
            outDir: electronOutDir,
            minify: false,
            // Sandboxed preloads must be CommonJS; name the file accordingly.
            rolldownOptions: { output: { entryFileNames: '[name].cjs' } },
          },
        },
      },
    }),
  ],
});
