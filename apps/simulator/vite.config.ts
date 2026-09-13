import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * Workspace packages are aliased to their SOURCE rather than a built bundle.
 *
 * It means editing a component in `packages/ui` hot-reloads here instantly with
 * no build step and no watch process — which is the main reason this repo has
 * no build orchestration tooling at all.
 */
const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@ocpp/contracts': pkg('contracts'),
      '@ocpp/ocpp': pkg('ocpp'),
      '@ocpp/ui': pkg('ui'),
      '@ocpp/api-client': pkg('api-client'),
      '@ocpp/mocks': pkg('mocks'),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    strictPort: false,
  },
  build: {
    // A source map costs nothing here and turns an unreadable production stack
    // trace into a real file and line.
    sourcemap: true,
  },
});
