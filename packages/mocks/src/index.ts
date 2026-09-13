/**
 * @ocpp/mocks — the learn-mode backend.
 *
 * Three pieces:
 *   - deterministic fixtures (`seed*.ts`) so the fleet is the same every reload;
 *   - a small world simulation (`world.ts`) that ticks, so the UI is genuinely
 *     live rather than static;
 *   - MSW handlers (`handlers/`) that try YOUR backend first and only fall back
 *     to mock data for routes you have not built yet.
 *
 * Imported dynamically and only when `VITE_LEARN_MODE=true`, so none of it
 * reaches a production bundle.
 */
export { startMocks, stopMocks, type StartMocksOptions } from './browser';
export { handlers, resetBreakers } from './handlers';
export { world } from './world';
export { rng, createRng } from './random';
export { priceSession } from './seed-sessions';
export { SIM_SCENARIOS } from './seed-sim';
