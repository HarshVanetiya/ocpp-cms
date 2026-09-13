import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { world } from './world';

/**
 * Starting the mock backend.
 *
 * Called only from `main.tsx` under `if (LEARN_MODE)`, so the entire package —
 * MSW, the fixtures, the world simulation — is tree-shaken out of a production
 * build. Nothing here ships in `npm run build`.
 */

let worker: ReturnType<typeof setupWorker> | null = null;

export interface StartMocksOptions {
  /** How often the world advances. Lower feels livelier, costs more CPU. */
  tickMs?: number;
  /** Log every mocked request to the console. */
  quiet?: boolean;
}

export async function startMocks(options: StartMocksOptions = {}) {
  if (worker) return worker;

  worker = setupWorker(...handlers);

  await worker.start({
    // Requests we have no handler for go straight to the network. Without
    // this, MSW warns loudly about every font and source map.
    onUnhandledRequest: 'bypass',
    quiet: options.quiet ?? true,
    serviceWorker: {
      url: '/mockServiceWorker.js',
      options: { scope: '/' },
    },
  });

  world.start(options.tickMs ?? 2000);

  // A single, clearly-marked banner rather than per-request noise.
  console.info(
    '%c LEARN MODE %c Mock backend running. Every request tries your real backend first and only falls back here.',
    'background:#05ae78;color:#0d1116;font-weight:700;padding:2px 6px;border-radius:4px',
    'color:inherit',
  );

  return worker;
}

export function stopMocks() {
  world.stop();
  worker?.stop();
  worker = null;
}
