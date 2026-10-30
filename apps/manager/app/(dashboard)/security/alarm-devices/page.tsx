'use client';

import { fieldError, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Device = Schema<'AlarmDeviceView'>;
type Status = 'active' | 'retired' | 'all';
const KEY = ['security', 'alarm-devices'] as const;
const STATUSES: { value: Status; label: string }[] = [
  { value: 'active', label: 'In service' },
  { value: 'retired', label: 'Retired' },
  { value: 'all', label: 'All' },
];
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');

/** A wearable registered, or renamed: the vendor’s id and a label. */
function DeviceDialog({ device, onClose }: { device?: Device; onClose: () => void }) {
  const toast = useToast();
  const [deviceRef, setDeviceRef] = useState('');
  const [name, setName] = useState(device?.label ?? '');
  const save = useAction(
    () =>
      device
        ? unwrap(api.PATCH('/api/v1/staff/gate/alarm-devices/{id}', { params: { path: { id: device.id } }, body: { label: name.trim() } }))
        : unwrap(api.POST('/api/v1/staff/gate/alarm-devices', { body: { deviceRef: deviceRef.trim(), label: name.trim() } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(device ? 'Renamed.' : 'Registered: a guard on shift may pair it now.');
        onClose();
      },
    },
  );
  const ok = name.trim() !== '' && (device !== undefined || deviceRef.trim() !== '');
  return (
    <Dialog
      open
      onClose={onClose}
      title={device ? `Rename ${device.label}` : 'Register a guard-down wearable'}
      description={device ? undefined : 'By the vendor’s own id for it. A guard pairs it for their shift; its fall, stillness or panic raises their SOS.'}
      onSubmit={() => ok && save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ok}>
            {device ? 'Rename' : 'Register'}
          </Button>
        </>
      }
    >
      <div className="form">
        {device ? null : (
          <Field label="The vendor’s device id" error={fieldError(save.error, 'deviceRef')}>
            {(p) => <Input {...p} maxLength={120} value={deviceRef} onChange={(e) => setDeviceRef(e.target.value)} />}
          </Field>
        )}
        <Field label="Label" hint="What the guards call it: a colour, a number." error={fieldError(save.error, 'label')}>
          {(p) => <Input {...p} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/**
 * Guard-down wearables (ADR 0068), `gate_devices.manage`: the vendor’s
 * devices the guards pair for their shift. An alarm from a paired one
 * raises the guard’s SOS from their post; from one nobody wears, the
 * control room hears of it.
 */
export default function AlarmDevicesPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('gate_devices.manage');
  const [status, setStatus] = useState<Status>('active');
  const list = useQuery({
    queryKey: [...KEY, status],
    queryFn: () => unwrap(api.GET('/api/v1/staff/gate/alarm-devices', { params: { query: { status } } })),
    enabled: allowed,
  });
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [retiring, setRetiring] = useState<Device | null>(null);
  const retire = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/gate/alarm-devices/{id}/retire', { params: { path: { id: retiring!.id } }, body: { reasonCode } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Retired: its pairing ended.');
        setRetiring(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Alarm wearables" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Alarm wearables"
        description="The guard-down devices the guards wear on shift."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
            Register
          </Button>
        }
      />
      <div className="stack">
        <Segmented label="Status" value={status} onChange={setStatus} options={STATUSES} />
        <Card flush>
          <QueryState query={list}>
            <DataTable<Device>
              rows={list.data?.data}
              rowKey={(d) => d.id}
              empty="No wearables"
              columns={[
                { key: 'l', header: 'Label', cell: (d) => d.label },
                { key: 'r', header: 'Vendor id', cell: (d) => <span className="t-mono">{d.deviceRef}</span> },
                {
                  key: 'p',
                  header: 'Worn by',
                  cell: (d) => (d.pairing ? `${d.pairing.guard.fullName ?? 'A guard'} since ${formatDateTime(d.pairing.pairedAt)}` : '—'),
                },
                {
                  key: 's',
                  header: 'Status',
                  cell: (d) =>
                    d.status === 'retired' ? <Badge tone="beige">Retired{d.retireReason ? `: ${label(d.retireReason)}` : ''}</Badge> : <Badge tone="green">In service</Badge>,
                },
                {
                  key: 'a',
                  header: '',
                  className: 'table__actions',
                  cell: (d) =>
                    d.status === 'active' ? (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <Button size="sm" onClick={() => setRenaming(d)}>
                          Rename
                        </Button>
                        <Button size="sm" onClick={() => setRetiring(d)}>
                          Retire
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
      </div>
      {adding ? <DeviceDialog onClose={() => setAdding(false)} /> : null}
      {renaming ? <DeviceDialog device={renaming} onClose={() => setRenaming(null)} /> : null}
      <ReasonCodeDialog
        open={retiring !== null}
        onClose={() => {
          setRetiring(null);
          retire.reset();
        }}
        title={retiring ? `Retire ${retiring.label}?` : ''}
        description="Its pairing ends now. An alarm from it later reaches the control room only."
        codes={REASON_CODES.alarmDeviceRetire}
        confirmLabel="Retire"
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={(code) => retire.mutate(code)}
      />
    </>
  );
}
