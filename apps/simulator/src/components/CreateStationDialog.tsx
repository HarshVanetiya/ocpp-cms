import { useState } from 'react';
import type { Protocol } from '@ocpp/contracts';
import { useApiMutation } from '@ocpp/api-client';
import { Button, Dialog, Field, Input, SegmentedControl, Select, useToast } from '@ocpp/ui';

/**
 * Creating virtual stations.
 *
 * `count` is the interesting field: it creates N stations with a numeric
 * suffix in one call. Spinning up 200 simulated chargers is how you find out
 * that your CSMS opens a database connection per WebSocket, which is the kind
 * of thing you would much rather learn here than in production.
 */
export function CreateStationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [identity, setIdentity] = useState('SIM-001');
  const [protocol, setProtocol] = useState<Protocol>('ocpp1.6');
  const [csmsUrl, setCsmsUrl] = useState('ws://localhost:3000/ocpp');
  const [connectorCount, setConnectorCount] = useState('2');
  const [maxPowerKw, setMaxPowerKw] = useState('22');
  const [count, setCount] = useState('1');

  const create = useApiMutation('createSimStation', {
    invalidates: ['listSimStations', 'simHealth'],
    onSuccess: (res) => {
      toast({
        tone: 'success',
        title: `Created ${res.data.length} station${res.data.length === 1 ? '' : 's'}`,
        description: 'Connect it to start speaking OCPP to your CSMS.',
      });
      onOpenChange(false);
    },
    onError: (e) => toast({ tone: 'error', title: 'Could not create', description: e.userMessage }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add virtual stations"
      description="These behave like real hardware: they open a WebSocket to your CSMS and speak nothing but OCPP."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() =>
              create.mutate({
                body: {
                  identity,
                  protocol,
                  csmsUrl,
                  connectorCount: Number(connectorCount) || 1,
                  maxPowerKw: Number(maxPowerKw) || 22,
                  count: Number(count) || 1,
                  powerType: Number(maxPowerKw) > 43 ? 'dc' : 'ac_3_phase',
                  connectorType: Number(maxPowerKw) > 43 ? 'iec_62196_t2_combo' : 'iec_62196_t2',
                },
              })
            }
          >
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Identity"
          hint="The last path segment of the WebSocket URL. Must be unique across your CSMS."
        >
          {({ id }) => (
            <Input id={id} mono value={identity} onChange={(e) => setIdentity(e.target.value)} />
          )}
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Protocol
          </span>
          <SegmentedControl
            label="Protocol"
            value={protocol}
            onChange={setProtocol}
            options={[
              { value: 'ocpp1.6', label: 'OCPP 1.6J' },
              { value: 'ocpp2.0.1', label: 'OCPP 2.0.1' },
            ]}
            className="self-start"
          />
        </div>

        <Field label="CSMS WebSocket URL" hint="The identity is appended by the simulator.">
          {({ id }) => (
            <Input id={id} mono value={csmsUrl} onChange={(e) => setCsmsUrl(e.target.value)} />
          )}
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="EVSEs">
            {({ id }) => (
              <Select
                id={id}
                value={connectorCount}
                onChange={(e) => setConnectorCount(e.target.value)}
                options={[1, 2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: String(n) }))}
              />
            )}
          </Field>
          <Field label="Max power">
            {({ id }) => (
              <Select
                id={id}
                value={maxPowerKw}
                onChange={(e) => setMaxPowerKw(e.target.value)}
                options={[7.4, 11, 22, 50, 150, 300].map((n) => ({
                  value: String(n),
                  label: `${n} kW`,
                }))}
              />
            )}
          </Field>
          <Field label="How many" hint="Suffixed -001, -002…">
            {({ id }) => (
              <Input
                id={id}
                inputMode="numeric"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
