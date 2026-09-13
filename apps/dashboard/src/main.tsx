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
 * The dynamic import is deliberate: `LEARN_MODE` is statically false in a
 * production build, so the bundler removes this whole branch and `@ocpp/mocks`
 * never reaches the output.
 */
async function bootstrap() {
  if (LEARN_MODE) {
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
