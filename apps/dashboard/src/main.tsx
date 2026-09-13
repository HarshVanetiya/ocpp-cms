import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { LEARN_MODE, createQueryClient, getRealtimeClient, probeBackend } from '@ocpp/api-client';
import { App } from './App';
import './styles.css';

/**
 * Boot order matters.
 *
 * 1. In learn mode, start the mock service worker BEFORE React renders.
 *    If React renders first, the queries it fires on mount race the worker's
 *    registration and some of them escape un-intercepted — you get a confusing
 *    half-mocked first paint.
 * 2. Probe the real backend once, so the sidebar indicator is correct
 *    immediately rather than after the first failed request.
 * 3. Open the realtime connection.
 *
 * The dynamic import is deliberate, and so is the redundant-looking
 * `import.meta.env.DEV` in front of `LEARN_MODE`.
 *
 * `LEARN_MODE` already includes that check, but it is an imported binding, and
 * the bundler will not fold an imported constant into this `if` early enough
 * to stop the chunk being EMITTED. It correctly makes the branch unreachable,
 * so nothing ever loads it — but a 580 kB file of mock fixtures still lands in
 * `dist/` and gets deployed.
 *
 * Writing `import.meta.env.DEV` literally here is inlined to `false` at this
 * exact spot, so the whole condition folds before chunking and `@ocpp/mocks`
 * never becomes a chunk at all. Verify after a build by listing each app's
 * `dist/assets` directory: there should be no orphaned `src-*.js` file that
 * nothing else references.
 */
async function bootstrap() {
  if (import.meta.env.DEV && LEARN_MODE) {
    const { startMocks } = await import('@ocpp/mocks');
    await startMocks();
  }

  void probeBackend();
  getRealtimeClient().connect();

  const queryClient = createQueryClient();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
