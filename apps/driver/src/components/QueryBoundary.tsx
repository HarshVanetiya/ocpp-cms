import type { ReactNode } from 'react';
import { AlertTriangle, PlugZap, RefreshCw, ServerCrash } from 'lucide-react';
import { ApiClientError, LEARN_MODE } from '@ocpp/api-client';
import { Button, EmptyState, Panel, Skeleton } from '@ocpp/ui';

/**
 * One place that decides what a screen looks like while it is loading, when it
 * has failed, and when it is empty.
 *
 * Without this, every page grows its own slightly different spinner and its own
 * `{error && <div>{error.message}</div>}`, and the honest error states are the
 * first thing to be skipped. Making the good behaviour the easy behaviour is
 * how you get it consistently.
 */
export interface QueryBoundaryProps<T> {
  isLoading: boolean;
  error: ApiClientError | null;
  data: T | undefined;
  /** Treat this as empty and show the empty state instead of children. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeleton?: ReactNode;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}

export function QueryBoundary<T>({
  isLoading,
  error,
  data,
  isEmpty,
  empty,
  skeleton,
  onRetry,
  children,
}: QueryBoundaryProps<T>) {
  if (isLoading && data === undefined) {
    return <>{skeleton ?? <DefaultSkeleton />}</>;
  }

  if (error) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  if (data === undefined) return <>{skeleton ?? <DefaultSkeleton />}</>;

  if (isEmpty?.(data)) {
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  }

  return <>{children(data)}</>;
}

function DefaultSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

/**
 * The error state does the single most useful thing it can for someone
 * building a backend: it distinguishes "your server is not running", "you have
 * not built this route yet" and "your route returned the wrong shape", and
 * tells them what to do about each.
 */
export function ErrorState({ error, onRetry }: { error: ApiClientError; onRetry?: () => void }) {
  if (error.isOffline) {
    return (
      <Panel>
        <EmptyState
          icon={<PlugZap />}
          title="Backend not reachable"
          description={
            <>
              Nothing is answering at the API URL. Start your backend, or run{' '}
              <code className="rounded-xs bg-surface-2 px-1 py-0.5 font-mono text-[12px]">
                npm run dev:learn
              </code>{' '}
              to work against the mock backend instead.
            </>
          }
          action={
            onRetry && (
              <Button icon={<RefreshCw />} onClick={onRetry}>
                Try again
              </Button>
            )
          }
        />
      </Panel>
    );
  }

  if (error.isNotImplemented) {
    return (
      <Panel>
        <EmptyState
          icon={<ServerCrash />}
          title="This endpoint is not built yet"
          description={
            <>
              Your backend answered <strong>{error.status}</strong> for{' '}
              <code className="rounded-xs bg-surface-2 px-1 py-0.5 font-mono text-[12px]">
                {error.endpoint}
              </code>
              .{' '}
              {LEARN_MODE
                ? 'Learn mode would normally fall back to mock data here — this route returned a real error instead.'
                : 'Implement it, or run npm run dev:learn to see the screen with mock data.'}
            </>
          }
          action={
            onRetry && (
              <Button icon={<RefreshCw />} onClick={onRetry}>
                Try again
              </Button>
            )
          }
        />
      </Panel>
    );
  }

  if (error.code === 'SCHEMA') {
    return (
      <Panel>
        <EmptyState
          icon={<AlertTriangle />}
          title="Response did not match the contract"
          description={
            <span className="flex flex-col gap-2">
              <span>
                Your backend answered, but the body is not the shape{' '}
                <code className="font-mono text-[12px]">{error.endpoint}</code> promises.
              </span>
              <span className="flex flex-col gap-1 rounded-sm border border-line-soft bg-surface-2 p-2.5 text-left font-mono text-[11.5px]">
                {error.details.map((d) => (
                  <span key={d.field}>
                    <span className="text-danger">{d.field}</span>
                    <span className="text-ink-3"> — {d.message}</span>
                  </span>
                ))}
              </span>
            </span>
          }
          action={
            onRetry && (
              <Button icon={<RefreshCw />} onClick={onRetry}>
                Try again
              </Button>
            )
          }
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <EmptyState
        icon={<AlertTriangle />}
        title={error.userMessage}
        description={
          error.details.length > 0
            ? error.details.map((d) => `${d.field}: ${d.message}`).join(' · ')
            : `${error.code}${error.status ? ` · HTTP ${error.status}` : ''}`
        }
        action={
          onRetry && (
            <Button icon={<RefreshCw />} onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    </Panel>
  );
}
