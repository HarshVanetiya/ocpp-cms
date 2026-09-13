import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { LEARN_MODE, createQueryClient, getSimRealtimeClient, probeSimulator } from '@ocpp/api-client';
import { App } from './App';
import './styles.css';

async function bootstrap() {
  // The literal `import.meta.env.DEV` is what stops the mock chunk being
  // emitted at all, not just made unreachable. See apps/dashboard/src/main.tsx.
  if (import.meta.env.DEV && LEARN_MODE) {
    const { startMocks } = await import('@ocpp/mocks');
    await startMocks();
  }

  void probeSimulator();
  getSimRealtimeClient().connect();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
