import { coreHandlers } from './core';
import { simHandlers } from './sim';
import { realtimeHandlers } from './realtime';

export const handlers = [...coreHandlers, ...simHandlers, ...realtimeHandlers];
export { resetBreakers } from './resolver';
