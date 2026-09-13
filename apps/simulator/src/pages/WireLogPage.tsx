import { useState } from 'react';
import { useApiQuery } from '@ocpp/api-client';
import { Panel, SegmentedControl } from '@ocpp/ui';
import { WireLogPane } from '../components/WireLogPane';

/**
 * The full-width wire log.
 *
 * Same component as the side pane, given the whole window — for when you are
 * reading a conversation rather than glancing at one.
 */
export default function WireLogPage() {
  const [stationId, setStationId] = useState<string | 'all'>('all');
  const stations = useApiQuery('listSimStations', { query: { pageSize: 100 } });

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <SegmentedControl
          label="Station"
          size="sm"
          value={stationId}
          onChange={setStationId}
          options={[
            { value: 'all', label: 'All stations' },
            ...(stations.data?.data ?? []).slice(0, 6).map((s) => ({
              value: s.id,
              label: s.identity,
            })),
          ]}
        />
        <p className="ml-auto max-w-prose text-[12px] text-ink-3">
          Frames are shown from the <strong className="text-ink-2">station&apos;s</strong> point of
          view: outbound means leaving the charger for your CSMS.
        </p>
      </div>

      <Panel padded={false} className="flex min-h-0 flex-grow flex-col overflow-hidden">
        <WireLogPane stationId={stationId === 'all' ? null : stationId} title="All frames" />
      </Panel>
    </div>
  );
}
