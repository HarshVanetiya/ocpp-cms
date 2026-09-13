import { ws } from 'msw';
import { world } from '../world';

/**
 * The mock realtime channel.
 *
 * MSW can intercept WebSockets as well as HTTP, so learn mode gets a genuinely
 * live feed rather than polling. Everything the world simulation emits is
 * forwarded to any client that subscribed to a matching topic.
 *
 * Note this deliberately implements the SAME subscription protocol the contract
 * describes — `{type:'subscribe', topics:[...]}` — so the client code you write
 * against the mock is the code that works against your real gateway.
 */

const coreLink = ws.link('*/api/v1/realtime');
const simLink = ws.link('*/sim/v1/stream');

/** Does an event's topic match what a client asked for? */
function matches(topics: Set<string>, event: { type: string; data: unknown }): boolean {
  if (topics.size === 0) return false;
  const data = event.data as Record<string, unknown>;
  const stationId = typeof data?.stationId === 'string' ? data.stationId : null;
  const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : null;

  if (event.type === 'ocpp.message') {
    return topics.has('ocpp') || (stationId !== null && topics.has(`ocpp:${stationId}`));
  }
  if (event.type === 'station.status' || event.type === 'connector.status') {
    return topics.has('stations') || (stationId !== null && topics.has(`station:${stationId}`));
  }
  if (event.type.startsWith('session.') || event.type === 'meter.value') {
    return (
      topics.has('sessions') ||
      (sessionId !== null && topics.has(`session:${sessionId}`)) ||
      (stationId !== null && topics.has(`station:${stationId}`))
    );
  }
  if (event.type === 'system.log') return topics.has('logs');
  if (event.type === 'activity') return topics.has('activity');
  if (event.type === 'command.update' || event.type === 'payment.update') {
    return topics.has('stations') || (stationId !== null && topics.has(`station:${stationId}`));
  }
  return false;
}

export const realtimeHandlers = [
  coreLink.addEventListener('connection', ({ client }) => {
    const topics = new Set<string>();

    const unsubscribe = world.subscribe((event) => {
      if (!matches(topics, event)) return;
      client.send(JSON.stringify(event));
    });

    client.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      let frame: { type?: string; topics?: string[]; t?: number };
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }

      if (frame.type === 'subscribe' && Array.isArray(frame.topics)) {
        frame.topics.forEach((t) => topics.add(t));
        client.send(
          JSON.stringify({
            type: 'subscribed',
            at: new Date().toISOString(),
            data: { topics: [...topics] },
          }),
        );
      } else if (frame.type === 'unsubscribe' && Array.isArray(frame.topics)) {
        frame.topics.forEach((t) => topics.delete(t));
      } else if (frame.type === 'ping') {
        client.send(
          JSON.stringify({
            type: 'pong',
            at: new Date().toISOString(),
            data: { t: frame.t ?? Date.now() },
          }),
        );
      }
    });

    client.addEventListener('close', unsubscribe);
  }),

  simLink.addEventListener('connection', ({ client }) => {
    const unsubscribe = world.subscribeSim((event) => {
      client.send(JSON.stringify(event));
    });

    client.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      try {
        const frame = JSON.parse(raw) as { type?: string; t?: number };
        if (frame.type === 'ping') {
          client.send(
            JSON.stringify({
              type: 'pong',
              at: new Date().toISOString(),
              data: { t: frame.t ?? Date.now() },
            }),
          );
        }
      } catch {
        // Ignore anything unparseable.
      }
    });

    client.addEventListener('close', unsubscribe);
  }),
];
