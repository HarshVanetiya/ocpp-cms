import {
  CONNECTOR_STATUS_LABEL,
  CONNECTOR_STATUS_TONE,
  CONNECTOR_TYPE_LABEL,
  PROTOCOL_LABEL,
  type ConnectorStatus,
  type ConnectorType,
  type Protocol,
  type SessionStatus,
  type StationStatus,
} from '@ocpp/contracts';
import { Badge, StatusDot, cn, type Tone } from '@ocpp/ui';

/**
 * Status rendering, in one place.
 *
 * The temptation is to write `{station.status}` in each table and colour it
 * inline. Do that and within a week two screens disagree about whether
 * `suspended_evse` is amber or red. Centralise it once.
 */

const CONNECTOR_TONE: Record<ReturnType<() => string>, Tone> = {} as never;

function toneFor(status: ConnectorStatus): Tone {
  switch (CONNECTOR_STATUS_TONE[status]) {
    case 'ok':
      return 'accent';
    case 'busy':
      return 'info';
    case 'warn':
      return 'warn';
    case 'danger':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function ConnectorStatusBadge({
  status,
  className,
}: {
  status: ConnectorStatus;
  className?: string;
}) {
  const tone = toneFor(status);
  // A filled dot means energy is actually moving. A ring means it is not.
  // Carrying that distinction in the shape as well as the colour means it
  // survives being printed, screenshotted or seen by a colourblind operator.
  const moving = status === 'charging';
  return (
    <Badge
      tone={tone}
      dot={moving ? 'solid' : 'hollow'}
      className={cn(moving && 'bg-accent text-accent-ink border-accent font-semibold', className)}
    >
      {CONNECTOR_STATUS_LABEL[status]}
    </Badge>
  );
}

const STATION_TONE: Record<StationStatus, Tone> = {
  online: 'accent',
  offline: 'neutral',
  pending: 'info',
  rejected: 'danger',
  unavailable: 'neutral',
};

const STATION_LABEL: Record<StationStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  pending: 'Pending boot',
  rejected: 'Rejected',
  unavailable: 'Out of service',
};

export function StationStatusBadge({ status }: { status: StationStatus }) {
  return (
    <Badge tone={STATION_TONE[status]} dot={status === 'online' ? 'solid' : 'hollow'}>
      {STATION_LABEL[status]}
    </Badge>
  );
}

/**
 * Protocol version.
 *
 * Colour-coded consistently across all three apps: mint for 1.6J, blue for
 * 2.0.1. Once you have stared at a mixed frame log for five minutes, the
 * colour is faster to read than the text.
 */
export function ProtocolBadge({
  protocol,
  size = 'md',
}: {
  protocol: Protocol;
  size?: 'sm' | 'md';
}) {
  const short = protocol === 'ocpp1.6' ? '1.6J' : '2.0.1';
  if (size === 'sm') {
    return (
      <span
        title={PROTOCOL_LABEL[protocol]}
        className={cn(
          'font-mono text-[10px] font-semibold',
          protocol === 'ocpp1.6' ? 'text-c1' : 'text-c2',
        )}
        style={{ color: protocol === 'ocpp1.6' ? 'var(--color-c1)' : 'var(--color-c2)' }}
      >
        {short}
      </span>
    );
  }
  return (
    <Badge tone={protocol === 'ocpp1.6' ? 'accent' : 'info'} mono>
      {short}
    </Badge>
  );
}

const SESSION_TONE: Record<SessionStatus, Tone> = {
  pending: 'info',
  active: 'accent',
  suspended: 'warn',
  completed: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
};

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return (
    <Badge tone={SESSION_TONE[status]} dot={status === 'active' ? 'pulse' : 'hollow'}>
      {status[0].toUpperCase() + status.slice(1)}
    </Badge>
  );
}

export function ConnectorTypeLabel({ type }: { type: ConnectorType }) {
  return <span className="text-ink-2">{CONNECTOR_TYPE_LABEL[type]}</span>;
}

/** A compact row of coloured pips summarising a station's connectors. */
export function ConnectorPips({
  statuses,
  className,
}: {
  statuses: ConnectorStatus[];
  className?: string;
}) {
  if (statuses.length === 0) {
    return <span className="text-xs text-ink-3">No connectors</span>;
  }
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {statuses.map((s, i) => (
        <StatusDot
          key={i}
          tone={toneFor(s)}
          filled={s === 'charging' || s === 'faulted'}
          label={CONNECTOR_STATUS_LABEL[s]}
        />
      ))}
    </span>
  );
}

export { toneFor as connectorTone, CONNECTOR_TONE };
