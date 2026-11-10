'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { deviceStateIn, notCarriedTextIn } from '@/components/security/offline-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GateDevice, type GateDeviceFilter } from '@/lib/queries';
import { useNow } from '@/lib/use-now';
import ar from '@/messages/ar/sec-gate-devices';
import en from '@/messages/en/sec-gate-devices';

/** The compound's own alert minutes, when the reader may see the settings; else the default. */
function useAlertMinutes(enabled: boolean): number {
  const settings = useQuery({ queryKey: keys.gateSettings, queryFn: fetchers.gateSettings, enabled, retry: false });
  return settings.data?.offlineSyncAlertMinutes ?? 15;
}

/** Revoke, once, with a reason: it downloads nothing more; what it uploads is quarantined. */
function Revoke({ d, onClose }: { d: GateDevice; onClose: () => void }) {
  const t = useT(en, ar);
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
        toast.show(t('revoked'));
        onClose();
      },
    },
  );
  return (
    <ReasonCodeDialog
      open
      onClose={onClose}
      title={t('revokeTitle', { label: d.label ?? t('thisDevice') })}
      description={d.pendingCount ? t('revokeDescriptionPending', { n: d.pendingCount }) : t('revokeDescription')}
      codes={REASON_CODES.gateDeviceRevoke}
      confirmLabel={t('revoke')}
      danger
      pending={revoke.isPending}
      error={<ErrorAlert error={revoke.error} />}
      onConfirm={(reasonCode) => revoke.mutate(reasonCode as (typeof REASON_CODES.gateDeviceRevoke)[number])}
    />
  );
}

function DeviceDetail({ id, onClose, onRevoke }: { id: string; onClose: () => void; onRevoke: (d: GateDevice) => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const detail = useQuery({ queryKey: keys.gateDevice(id), queryFn: () => fetchers.gateDevice(id), refetchInterval: 30_000 });
  const d = detail.data;
  const notCarried = d ? notCarriedTextIn(d.notCarried, locale) : null;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={d?.label ?? t('detailTitle')}
      footer={
        <>
          {d && d.status === 'active' ? (
            <Button variant="danger" onClick={() => onRevoke(d)}>
              {t('revoke')}
            </Button>
          ) : null}
          <Button onClick={onClose}>{c('close')}</Button>
        </>
      }
    >
      <QueryState query={detail} rows={6}>
        {d ? (
          <dl className="dl">
            <dt>{t('enrolled')}</dt>
            <dd>
              {d.enrolledBy.fullName ?? t('erasedAccount')} · {f.dateTime(d.enrolledAt)}
            </dd>
            <dt>{t('col.lastSeen')}</dt>
            <dd>{d.lastSeenAt ? f.dateTime(d.lastSeenAt) : '—'}</dd>
            <dt>{t('lastUpload')}</dt>
            <dd>{d.lastUploadAt ? f.dateTime(d.lastUploadAt) : '—'}</dd>
            <dt>{t('bundle')}</dt>
            <dd>
              {d.bundleVersion ? t('bundleValue', { version: d.bundleVersion, until: f.dateTime(d.bundleValidUntil) }) : t('bundleNone')}
              {d.onShift ? t('onShiftSuffix') : ''}
            </dd>
            <dt>{t('actionsLabel')}</dt>
            <dd>
              {t('received', { acked: f.number(d.ackedSeq), max: f.number(d.maxSeq) })}
              {d.missingActions ? t('missing', { n: f.number(d.missingActions) }) : ''}
              {d.pendingCount !== null ? t('stillOnDevice', { n: f.number(d.pendingCount) }) : ''}
            </dd>
            <dt>{t('flags')}</dt>
            <dd>
              {d.openFlags ? <Link href={`/security/offline-flags?device=${d.id}`}>{t('flagsToLook', { n: f.number(d.openFlags) })}</Link> : t('flagsNone')}
            </dd>
            {notCarried ? (
              <>
                <dt>{t('notOffline')}</dt>
                <dd>{notCarried}</dd>
              </>
            ) : null}
            {d.revokedAt ? (
              <>
                <dt>{t('revokedLabel')}</dt>
                <dd>
                  {d.revokedBy?.fullName ?? '—'} · {f.dateTime(d.revokedAt)} · {label(d.revokeReasonCode)}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('gate_devices.manage');
  const params = useSearchParams();
  const [status, setStatus] = useState<GateDeviceFilter>('active');
  const [open, setOpen] = useState<string | null>(params.get('device'));
  const [revoking, setRevoking] = useState<GateDevice | null>(null);
  const now = useNow(30_000);
  const alertMinutes = useAlertMinutes(allowed && can('gate.manage'));
  const list = useCursorList(keys.gateDevices(status), (cursor) => fetchers.gateDevices(status, cursor), {
    enabled: allowed,
    refetchInterval: 60_000,
  });

  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<GateDeviceFilter>
          label={t('shown')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: t('filter.active') },
            { value: 'revoked', label: t('filter.revoked') },
            { value: 'all', label: c('all') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<GateDevice>
            rows={list.rows}
            rowKey={(d) => d.id}
            empty={t('empty')}
            columns={[
              {
                key: 'device',
                header: t('col.device'),
                cell: (d) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(d.id)}>
                    {d.label ?? t('deviceFallback', { id: d.id.slice(-6) })}
                  </Button>
                ),
              },
              {
                key: 'state',
                header: t('col.now'),
                cell: (d) => {
                  const s = deviceStateIn(d, now, alertMinutes, locale);
                  return <Badge tone={s.tone}>{s.text}</Badge>;
                },
              },
              {
                key: 'seen',
                header: t('col.lastSeen'),
                cell: (d) => (d.lastSeenAt ? <span title={f.dateTime(d.lastSeenAt)}>{f.relative(d.lastSeenAt)}</span> : '—'),
              },
              { key: 'pending', header: t('col.onDevice'), cell: (d) => (d.pendingCount === null ? '—' : f.number(d.pendingCount)) },
              { key: 'enrolled', header: t('col.enrolledBy'), cell: (d) => d.enrolledBy.fullName ?? t('erasedAccount') },
              {
                key: 'revoke',
                header: '',
                cell: (d) =>
                  d.status === 'active' ? (
                    <Button size="sm" variant="danger" onClick={() => setRevoking(d)}>
                      {t('revoke')}
                    </Button>
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
