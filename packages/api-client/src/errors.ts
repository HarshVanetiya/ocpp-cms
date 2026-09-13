import type { ApiErrorCode } from '@ocpp/contracts';

/**
 * One error class for the whole client.
 *
 * Components should never need to know whether a failure was a 404, a network
 * drop or a schema mismatch — they need to know "can I retry?" and "what do I
 * tell the user?". Everything below normalises into those two questions.
 */
export class ApiClientError extends Error {
  readonly code: ApiErrorCode | 'NETWORK' | 'TIMEOUT' | 'SCHEMA' | 'ABORTED';
  readonly status: number | null;
  readonly details: Array<{ field: string; message: string }>;
  readonly requestId: string | null;
  /** The endpoint id from the registry, so errors are traceable to a route. */
  readonly endpoint: string | null;

  constructor(init: {
    message: string;
    code: ApiClientError['code'];
    status?: number | null;
    details?: Array<{ field: string; message: string }>;
    requestId?: string | null;
    endpoint?: string | null;
    cause?: unknown;
  }) {
    super(init.message, { cause: init.cause });
    this.name = 'ApiClientError';
    this.code = init.code;
    this.status = init.status ?? null;
    this.details = init.details ?? [];
    this.requestId = init.requestId ?? null;
    this.endpoint = init.endpoint ?? null;
  }

  /** Worth trying again automatically. */
  get retryable() {
    return (
      this.code === 'NETWORK' ||
      this.code === 'TIMEOUT' ||
      this.code === 'RATE_LIMITED' ||
      (this.status !== null && this.status >= 500)
    );
  }

  /** The backend is not answering at all — distinct from "answered with an error". */
  get isOffline() {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT';
  }

  /** The route exists in the contract but your backend has not built it yet. */
  get isNotImplemented() {
    return this.status === 404 || this.status === 501;
  }

  /**
   * A sentence to put on screen. Never the raw message from the server for
   * 5xx — those leak stack traces and mean nothing to an operator.
   */
  get userMessage() {
    switch (this.code) {
      case 'NETWORK':
        return 'Cannot reach the backend. Is it running?';
      case 'TIMEOUT':
        return 'The backend took too long to respond.';
      case 'UNAUTHORIZED':
        return 'Your session has expired. Sign in again.';
      case 'FORBIDDEN':
        return 'You do not have permission to do that.';
      case 'NOT_FOUND':
        return 'That no longer exists.';
      case 'VALIDATION_FAILED':
        return this.details[0]?.message ?? 'Some fields need fixing.';
      case 'STATION_OFFLINE':
        return 'The station is offline, so the command could not be delivered.';
      case 'COMMAND_TIMEOUT':
        return 'The station did not answer in time.';
      case 'COMMAND_REJECTED':
        return 'The station rejected the command.';
      case 'PAYMENT_DECLINED':
        return 'The payment was declined.';
      case 'RATE_LIMITED':
        return 'Too many requests. Slow down a moment.';
      case 'SCHEMA':
        return 'The backend sent data in an unexpected shape.';
      default:
        return 'Something went wrong.';
    }
  }
}

/**
 * Turn a Zod failure into a readable list.
 *
 * This is the payoff for validating responses: instead of `undefined is not an
 * object` three components deep, you get "stations.0.status: expected one of
 * online|offline, received 'Online'" pointing straight at the bug in your
 * backend. Worth the handful of milliseconds.
 */
export function schemaError(endpoint: string, issues: Array<{ path: PropertyKey[]; message: string }>) {
  const details = issues.slice(0, 8).map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
  return new ApiClientError({
    message: `Response from ${endpoint} did not match the contract`,
    code: 'SCHEMA',
    endpoint,
    details,
  });
}
