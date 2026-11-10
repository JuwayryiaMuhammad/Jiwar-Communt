'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/sec-alarm-devices';
import en from '@/messages/en/sec-alarm-devices';

type Device = Schema<'AlarmDeviceView'>;
type Status = 'active' | 'retired' | 'all';
const KEY = ['security', 'alarm-devices'] as const;

/** A wearable registered, or renamed: the vendor’s id and a label. */
function DeviceDialog({ device, onClose }: { device?: Device; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(device ? t('renamed') : t('registered'));
        onClose();
      },
    },
  );
  const ok = name.trim() !== '' && (device !== undefined || deviceRef.trim() !== '');
  return (
    <Dialog
      open
      onClose={onClose}
      title={device ? t('renameTitle', { label: device.label }) : t('registerTitle')}
      description={device ? undefined : t('registerDescription')}
      onSubmit={() => ok && save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ok}>
            {device ? t('rename') : t('register')}
          </Button>
        </>
      }
    >
      <div className="form">
        {device ? null : (
          <Field label={t('deviceId')} error={fieldError(save.error, 'deviceRef')}>
            {(p) => <Input {...p} maxLength={120} value={deviceRef} onChange={(e) => setDeviceRef(e.target.value)} />}
          </Field>
        )}
        <Field label={t('label')} hint={t('labelHint')} error={fieldError(save.error, 'label')}>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('gate_devices.manage');
  const [status, setStatus] = useState<Status>('active');
  const statuses: { value: Status; label: string }[] = [
    { value: 'active', label: t('status.active') },
    { value: 'retired', label: t('status.retired') },
    { value: 'all', label: c('all') },
  ];
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
        toast.show(t('retired'));
        setRetiring(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
            {t('register')}
          </Button>
        }
      />
      <div className="stack">
        <Segmented label={c('status')} value={status} onChange={setStatus} options={statuses} />
        <Card flush>
          <QueryState query={list}>
            <DataTable<Device>
              rows={list.data?.data}
              rowKey={(d) => d.id}
              empty={t('empty')}
              columns={[
                { key: 'l', header: t('col.label'), cell: (d) => d.label },
                { key: 'r', header: t('col.vendorId'), cell: (d) => <span className="t-mono ltr">{d.deviceRef}</span> },
                {
                  key: 'p',
                  header: t('col.wornBy'),
                  cell: (d) =>
                    d.pairing ? t('wornSince', { guard: d.pairing.guard.fullName ?? t('aGuard'), since: f.dateTime(d.pairing.pairedAt) }) : '—',
                },
                {
                  key: 's',
                  header: c('status'),
                  cell: (d) =>
                    d.status === 'retired' ? (
                      <Badge tone="beige">{d.retireReason ? t('retiredBadgeWithReason', { reason: label(d.retireReason) }) : t('retiredBadge')}</Badge>
                    ) : (
                      <Badge tone="green">{t('inService')}</Badge>
                    ),
                },
                {
                  key: 'a',
                  header: '',
                  className: 'table__actions',
                  cell: (d) =>
                    d.status === 'active' ? (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <Button size="sm" onClick={() => setRenaming(d)}>
                          {t('rename')}
                        </Button>
                        <Button size="sm" onClick={() => setRetiring(d)}>
                          {t('retire')}
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
        title={retiring ? t('retireTitle', { label: retiring.label }) : ''}
        description={t('retireDescription')}
        codes={REASON_CODES.alarmDeviceRetire}
        confirmLabel={t('retire')}
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={(code) => retire.mutate(code)}
      />
    </>
  );
}
