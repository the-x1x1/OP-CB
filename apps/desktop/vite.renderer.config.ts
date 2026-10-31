/**
 * Vite config for the browser dev/demo build of the renderer shell
 * (`pnpm --filter @opcb/desktop dev:browser`). The Electron build is driven by
 * electron-vite (main/preload owned by the desktop-platform workstream) and reuses the
 * same renderer root. Workspace packages are consumed as TypeScript source via the
 * tsconfig `paths` aliases below.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { VITE_PUBLIC_DIR } from './scripts/renderer-assets.mjs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const pkg = (name: string) => path.join(repoRoot, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  root: path.join(here, 'src', 'renderer'),
  publicDir: VITE_PUBLIC_DIR,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@opcb/ui/base.css': path.join(repoRoot, 'packages', 'ui', 'src', 'base.css'),
      '@opcb/ui': pkg('ui'),
      '@opcb/ipc-contract': pkg('ipc-contract'),
      '@opcb/render-core': pkg('render-core'),
      '@opcb/world-model': pkg('world-model'),
      '@opcb/source-health': pkg('source-health'),
      '@opcb/provider-sdk': pkg('provider-sdk'),
      '@opcb/telemetry': pkg('telemetry'),
    },
  },
  server: { port: 5178, strictPort: true },
  build: { outDir: path.join(here, 'out', 'renderer'), emptyOutDir: true, target: 'chrome128', sourcemap: true },
});
