import { HttpResponse, bypass, delay, http, type HttpResponseResolver } from 'msw';
import { SERVICE_BASE_PATH, endpointPath, type EndpointDef, type EndpointId } from '@ocpp/contracts';
import { endpoints } from '@ocpp/contracts';

/**
 * BACKEND-FIRST MOCKING — the idea that makes learn mode worth having.
 *
 * A normal mock backend is all-or-nothing: either you use the mocks and your
 * real code is never exercised, or you use your backend and the UI is broken
 * until all ninety endpoints exist.
 *
 * This does neither. For every request, in order:
 *
 *   1. Forward it to YOUR backend, untouched.
 *   2. If your backend answers with anything other than "I do not have this
 *      route" (404 / 501), return that answer verbatim — successes AND errors.
 *      Your validation errors, your 403s, your 500s all reach the UI.
 *   3. Only if your backend is unreachable, or genuinely does not know the
 *      route, serve mock data and stamp `x-ocpp-served-by: mock` so the UI can
 *      show which parts of the screen are not real yet.
 *
 * The effect: on day one every screen works on mocks. The moment you implement
 * `GET /api/v1/stations`, the stations table switches to your data on the next
 * refresh, while the rest of the app keeps working. You build the backend one
 * endpoint at a time and never once look at a broken page.
 */

/* ------------------------------------------------------------------ *
 * Circuit breaker
 * ------------------------------------------------------------------ */

/**
 * When the backend is not running, every request would wait for a connection
 * failure. On localhost that is fast, but against a remote or firewalled host
 * it can be seconds — per request — which makes the whole app feel broken.
 *
 * So: after three consecutive failures, stop trying for ten seconds. This is a
 * circuit breaker, and it is the same pattern you want between your own
 * services later. Worth recognising by name.
 */
class Breaker {
  private failures = 0;
  private openUntil = 0;

  get isOpen() {
    return Date.now() < this.openUntil;
  }

  recordSuccess() {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= 3) {
      this.openUntil = Date.now() + 10_000;
      this.failures = 0;
    }
  }
}

const breakers: Record<'core' | 'sim', Breaker> = { core: new Breaker(), sim: new Breaker() };

/** Reset both breakers — the UI calls this from a "retry backend" button. */
export function resetBreakers() {
  breakers.core = new Breaker();
  breakers.sim = new Breaker();
}

/* ------------------------------------------------------------------ *
 * Latency
 * ------------------------------------------------------------------ */

/**
 * Mock responses are delayed slightly on purpose.
 *
 * An instant mock hides every loading state you wrote, and you discover the
 * missing spinner only when you point the app at a real backend. A 90–260ms
 * jitter keeps them honest without making the app feel slow.
 */
async function simulateLatency() {
  await delay(90 + Math.random() * 170);
}

/* ------------------------------------------------------------------ *
 * The resolver factory
 * ------------------------------------------------------------------ */

export type MockContext = {
  request: Request;
  params: Record<string, string | readonly string[]>;
  url: URL;
  /** Parsed JSON body, or null. Read once and reused. */
  body: unknown;
};

export type MockProducer = (ctx: MockContext) => unknown | Promise<unknown>;

function jsonMock(data: unknown, status = 200) {
  return HttpResponse.json(data as Record<string, unknown>, {
    status,
    // The client reads this header to decide whether a screen is live yet.
    headers: { 'x-ocpp-served-by': 'mock' },
  });
}

export function mockError(code: string, message: string, status = 400) {
  return HttpResponse.json(
    { error: { code, message } },
    { status, headers: { 'x-ocpp-served-by': 'mock' } },
  );
}

function makeResolver(def: EndpointDef, produce: MockProducer): HttpResponseResolver {
  const breaker = breakers[def.service];

  return async ({ request, params }) => {
    // ---- 1. try the real backend ----
    if (!breaker.isOpen) {
      try {
        // `bypass` marks the request so MSW does not intercept its own fetch —
        // without it this recurses until the tab dies.
        const forwarded = await fetch(bypass(request.clone()));

        if (forwarded.status !== 404 && forwarded.status !== 501) {
          breaker.recordSuccess();
          // Return the backend's answer untouched, including its errors. No
          // `x-ocpp-served-by` header means "this was real".
          return forwarded;
        }
        // 404/501 means "route not built yet" — fall through to the mock.
        breaker.recordSuccess();
      } catch {
        // Connection refused, DNS failure, CORS. Backend is not there.
        breaker.recordFailure();
      }
    }

    // ---- 2. serve the mock ----
    await simulateLatency();

    let body: unknown = null;
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      try {
        body = await request.clone().json();
      } catch {
        body = null;
      }
    }

    try {
      const data = await produce({
        request,
        params: params as Record<string, string | readonly string[]>,
        url: new URL(request.url),
        body,
      });
      if (data instanceof Response) return data;
      return jsonMock(data);
    } catch (err) {
      if (err instanceof Response) return err;
      return mockError(
        'INTERNAL',
        err instanceof Error ? err.message : 'Mock handler failed',
        500,
      );
    }
  };
}

/**
 * Register a mock for one endpoint from the registry.
 *
 * Taking the endpoint id rather than a URL string means a route can never be
 * mocked at a path the real client does not call — the two are generated from
 * the same source.
 */
export function mock(id: EndpointId, produce: MockProducer) {
  const def = endpoints[id] as EndpointDef;
  // MSW uses the same `:param` syntax the registry does, so the path needs no
  // translation. The leading `*` matches whatever origin the app is pointed at.
  const path = `*${endpointPath(def)}`;
  const method = def.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  return http[method](path, makeResolver(def, produce));
}

export { SERVICE_BASE_PATH };

/* ------------------------------------------------------------------ *
 * Query helpers
 * ------------------------------------------------------------------ */

export function readPage(url: URL) {
  return {
    page: Number(url.searchParams.get('page') ?? 1),
    pageSize: Math.min(200, Number(url.searchParams.get('pageSize') ?? 25)),
    search: (url.searchParams.get('search') ?? '').trim().toLowerCase(),
    sort: url.searchParams.get('sort') ?? undefined,
  };
}

/** Slice an array into the standard `{ data, meta }` envelope. */
export function paginate<T>(items: T[], url: URL) {
  const { page, pageSize } = readPage(url);
  const total = items.length;
  const start = (page - 1) * pageSize;
  return {
    data: items.slice(start, start + pageSize),
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

/** Cursor pagination for the log feeds, using the row index as the cursor. */
export function cursorPage<T>(items: T[], url: URL) {
  const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
  const cursor = Number(url.searchParams.get('cursor') ?? 0);
  const slice = items.slice(cursor, cursor + limit);
  const next = cursor + limit;
  return {
    data: slice,
    meta: {
      nextCursor: next < items.length ? String(next) : null,
      hasMore: next < items.length,
    },
  };
}

export function matchesSearch(haystack: Array<string | null | undefined>, needle: string) {
  if (!needle) return true;
  return haystack.some((h) => (h ?? '').toLowerCase().includes(needle));
}
