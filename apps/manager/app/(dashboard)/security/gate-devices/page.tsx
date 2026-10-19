'use client';

import { formatDateTime, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { deviceState, notCarriedText } from '@/components/security/offline-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GateDevice, type GateDeviceFilter } from '@/lib/queries';
import { useNow } from '@/lib/use-now';

/** The compound's own alert minutes, when the reader may see the settings; else the default. */
function useAlertMinutes(enabled: boolean): number {
  const settings = useQuery({ queryKey: keys.gateSettings, queryFn: fetchers.gateSettings, enabled, retry: false });
  return settings.data?.offlineSyncAlertMinutes ?? 15;
}

/** Revoke, once, with a reason: it downloads nothing more; what it uploads is quarantined. */
function Revoke({ d, onClose }: { d: GateDevice; onClose: () => void }) {
  const toast = useToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const revoke = useAction(
    (reasonCode: (typeof REASON_CODES.gateDeviceRevoke)[number]) =>
      unwrap(
        api.POST('/api/v1/staff/gate/devices/{id}/revoke', {
          params: { path: { id: d.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { reasonCode },
        }),
      ),
    {
      invalidate: [keys.gateDevicesAll],
      onDone: () => {
        toast.show('Revoked: it downloads nothing more, and what it uploads waits for you in Offline flags.');
        onClose();
      },
    },
  );
  return (
    <ReasonCodeDialog
      open
      onClose={onClose}
      title={`Revoke ${d.label ?? 'this device'}?`}
      description={
        d.pendingCount
          ? `It said it still holds ${d.pendingCount} action${d.pendingCount === 1 ? '' : 's'}: whatever it uploads after this is quarantined for you to accept or reject.`
          : 'Whatever it uploads after this is quarantined for you to accept or reject.'
      }
      codes={REASON_CODES.gateDeviceRevoke}
      confirmLabel="Revoke"
      danger
      pending={revoke.isPending}
      error={<ErrorAlert error={revoke.error} />}
      onConfirm={(reasonCode) => revoke.mutate(reasonCode as (typeof REASON_CODES.gateDeviceRevoke)[number])}
    />
  );
}

function DeviceDetail({ id, onClose, onRevoke }: { id: string; onClose: () => void; onRevoke: (d: GateDevice) => void }) {
  const detail = useQuery({ queryKey: keys.gateDevice(id), queryFn: () => fetchers.gateDevice(id), refetchInterval: 30_000 });
  const d = detail.data;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={d?.label ?? 'Gate device'}
      footer={
        <>
          {d && d.status === 'active' ? (
            <Button variant="danger" onClick={() => onRevoke(d)}>Revoke</Button>
          ) : null}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <QueryState query={detail} rows={6}>
        {d ? (
          <dl className="dl">
            <dt>Enrolled</dt>
            <dd>{d.enrolledBy.fullName ?? 'An erased account'} · {formatDateTime(d.enrolledAt)}</dd>
            <dt>Last seen</dt>
            <dd>{d.lastSeenAt ? formatDateTime(d.lastSeenAt) : '—'}</dd>
            <dt>Last upload</dt>
            <dd>{d.lastUploadAt ? formatDateTime(d.lastUploadAt) : '—'}</dd>
            <dt>Bundle</dt>
            <dd>
              {d.bundleVersion ? `No. ${d.bundleVersion}, until ${formatDateTime(d.bundleValidUntil)}` : 'None yet'}
              {d.onShift ? ' · on shift' : ''}
            </dd>
            <dt>Actions</dt>
            <dd>
              Received through {d.ackedSeq} of {d.maxSeq}
              {d.missingActions ? ` · ${d.missingActions} missing` : ''}
              {d.pendingCount !== null ? ` · ${d.pendingCount} still on the device` : ''}
            </dd>
            <dt>Flags</dt>
            <dd>
              {d.openFlags ? <Link href={`/security/offline-flags?device=${d.id}`}>{d.openFlags} to look at</Link> : 'None open'}
            </dd>
            {notCarriedText(d.notCarried) ? (
              <>
                <dt>Not offline</dt>
                <dd>{notCarriedText(d.notCarried)}</dd>
              </>
            ) : null}
            {d.revokedAt ? (
              <>
                <dt>Revoked</dt>
                <dd>
                  {d.revokedBy?.fullName ?? '—'} · {formatDateTime(d.revokedAt)} · {d.revokeReasonCode}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </QueryState>
    </Dialog>
  );
}

/**
 * Gate devices (ADR 0057): the phones the gate works offline on. A guard
 * enrols one; here the management sees whether each syncs — when it was
 * last seen, its bundle, its sequence, what is missing and its open flags
 * — and revokes one it does not recognise or that was lost.
 */
export default function GateDevicesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('gate_devices.manage');
  const params = useSearchParams();
  const [status, setStatus] = useState<GateDeviceFilter>('active');
  const [open, setOpen] = useState<string | null>(params.get('device'));
  const [revoking, setRevoking] = useState<GateDevice | null>(null);
  const now = useNow(30_000);
  const alertMinutes = useAlertMinutes(allowed && can('gate.manage'));
  const list = useCursorList(keys.gateDevices(status), (c) => fetchers.gateDevices(status, c), {
    enabled: allowed,
    refetchInterval: 60_000,
  });

  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Gate devices" />
        <ForbiddenState />
      </>
    );

  return (
    <>
      <PageHeader
        title="Gate devices"
        description="The phones the gate works on without network. See that each syncs; revoke one that was lost or that you do not recognise."
      />
      <div className="toolbar">
        <Segmented<GateDeviceFilter>
          label="Devices shown"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'revoked', label: 'Revoked' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<GateDevice>
            rows={list.rows}
            rowKey={(d) => d.id}
            empty="No gate device"
            columns={[
              {
                key: 'device',
                header: 'Device',
                cell: (d) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(d.id)}>
                    {d.label ?? `Device ${d.id.slice(-6)}`}
                  </Button>
                ),
              },
              {
                key: 'state',
                header: 'Now',
                cell: (d) => {
                  const s = deviceState(d, now, alertMinutes);
                  return <Badge tone={s.tone}>{s.text}</Badge>;
                },
              },
              { key: 'seen', header: 'Last seen', cell: (d) => (d.lastSeenAt ? <span title={formatDateTime(d.lastSeenAt)}>{relativeTime(d.lastSeenAt)}</span> : '—') },
              { key: 'pending', header: 'On the device', cell: (d) => (d.pendingCount ?? '—').toString() },
              { key: 'enrolled', header: 'Enrolled by', cell: (d) => d.enrolledBy.fullName ?? 'An erased account' },
              {
                key: 'revoke',
                header: '',
                cell: (d) =>
                  d.status === 'active' ? (
                    <Button size="sm" variant="danger" onClick={() => setRevoking(d)}>Revoke</Button>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <DeviceDetail id={open} onClose={() => setOpen(null)} onRevoke={setRevoking} /> : null}
      {revoking ? <Revoke d={revoking} onClose={() => setRevoking(null)} /> : null}
    </>
  );
}
