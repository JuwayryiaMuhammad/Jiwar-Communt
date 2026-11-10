'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT, type Format } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/fin-collector-visits';
import en from '@/messages/en/fin-collector-visits';

type Visit = Schema<'CollectorVisitView'>;
type Filter = 'open' | Visit['status'];
const KEY = ['finance', 'collector-visits'] as const;
const SETTINGS = ['finance', 'collector-settings'] as const;
const windowText = (f: Format, v: Visit) => `${f.dateTime(v.windowStartsAt)} – ${f.time(v.windowEndsAt)}`;

function Assign({ visit, onClose }: { visit: Visit; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const collectors = useQuery({ queryKey: ['finance', 'collectors'], queryFn: () => unwrap(api.GET('/api/v1/staff/collectors')) });
  const [collectorId, setCollectorId] = useState('');
  const assign = useAction(
    () => unwrap(api.POST('/api/v1/staff/collector-visits/{id}/assign', { params: { path: { id: visit.id } }, body: { collectorId } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('assigned'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('assignTitle', { unit: visit.unitCode })}
      description={windowText(f, visit)}
      onSubmit={() => collectorId && assign.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={assign.isPending} disabled={!collectorId}>
            {t('assign')}
          </Button>
        </>
      }
    >
      <QueryState query={collectors}>
        <div className="form">
          <Field label={t('collector')} hint={t('collectorHint')} error={fieldError(assign.error, 'collectorId')}>
            {(p) => (
              <Select {...p} value={collectorId} onChange={(e) => setCollectorId(e.target.value)}>
                <option value="">{t('choose')}</option>
                {collectors.data?.data.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.fullName ?? k.id}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ErrorAlert error={assign.error} />
        </div>
      </QueryState>
    </Dialog>
  );
}

function CallOff({ visit, onClose }: { visit: Visit; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [code, setCode] = useState('');
  const cancel = useAction(
    () => unwrap(api.POST('/api/v1/staff/collector-visits/{id}/cancel', { params: { path: { id: visit.id } }, body: { reasonCode: code } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('calledOff'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('callOffTitle', { unit: visit.unitCode })}
      onSubmit={() => code && cancel.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{t('keepIt')}</Button>
          <Button type="submit" variant="danger" loading={cancel.isPending} disabled={!code}>
            {t('callOff')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('reason')} error={fieldError(cancel.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">{t('choose')}</option>
              {REASON_CODES.collectorVisitCancel.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={cancel.error} />
      </div>
    </Dialog>
  );
}

/** What a collector may take above what a unit owes (ADR 0069). */
function Margin() {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const settings = useQuery({ queryKey: SETTINGS, queryFn: () => unwrap(api.GET('/api/v1/staff/finance/collector-settings')) });
  const [margin, setMargin] = useState('');
  useEffect(() => {
    if (settings.data) setMargin(settings.data.collectorMargin);
  }, [settings.data]);
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/finance/collector-settings', { body: { collectorMargin: margin.trim() } })), {
    invalidate: [SETTINGS],
    onDone: () => toast.show(t('marginSaved')),
  });
  const valid = /^\d{1,4}(\.\d{1,2})?$/.test(margin.trim()) && Number(margin) <= 1000;
  return (
    <Card>
      <CardHeader title={t('marginTitle')} />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field label={t('marginLabel')} hint={t('marginHint')} error={fieldError(save.error, 'collectorMargin')}>
              {(p) => <Input {...p} inputMode="decimal" className="ltr" value={margin} onChange={(e) => setMargin(e.target.value)} />}
            </Field>
            <div>
              <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
                {c('save')}
              </Button>
            </div>
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

/**
 * Collector visits (ADR 0069): residents ask for a collector in a window;
 * the staff who keep payments give each to a collector, who records the
 * cash taken — an office payment with its receipt — or why it failed.
 */
export default function CollectorVisitsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('finance.payments');
  const [filter, setFilter] = useState<Filter>('open');
  const filters: { value: Filter; label: string }[] = [
    { value: 'open', label: t('filter.open') },
    { value: 'collected', label: label('collected') },
    { value: 'failed', label: label('failed') },
    { value: 'cancelled', label: t('filter.cancelled') },
  ];
  const list = useQuery({
    queryKey: [...KEY, filter],
    queryFn: () => unwrap(api.GET('/api/v1/staff/collector-visits', { params: { query: filter === 'open' ? {} : { status: filter } } })),
    enabled: allowed,
  });
  const [assigning, setAssigning] = useState<Visit | null>(null);
  const [cancelling, setCancelling] = useState<Visit | null>(null);
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
      <div className="stack">
        <Segmented label={c('status')} value={filter} onChange={setFilter} options={filters} />
        <Card flush>
          <QueryState query={list}>
            <DataTable<Visit>
              rows={list.data?.data}
              rowKey={(v) => v.id}
              empty={t('none')}
              columns={[
                { key: 'u', header: c('unit'), cell: (v) => <span className="t-mono ltr">{v.unitCode}</span> },
                { key: 'b', header: c('building'), cell: (v) => v.building ?? '—' },
                { key: 'w', header: t('col.window'), cell: (v) => windowText(f, v) },
                { key: 'e', header: t('col.expected'), cell: (v) => (v.expectedAmount ? f.money(v.expectedAmount) : '—') },
                {
                  key: 's',
                  header: c('status'),
                  cell: (v) => <Badge tone={v.status === 'collected' ? 'green' : v.status === 'failed' ? 'error' : 'beige'}>{label(v.status)}</Badge>,
                },
                { key: 'r', header: t('col.why'), cell: (v) => (v.failReason ? label(v.failReason) : v.cancelReason ? label(v.cancelReason) : '—') },
                {
                  key: 'a',
                  header: '',
                  className: 'table__actions',
                  cell: (v) =>
                    v.status === 'requested' || v.status === 'assigned' ? (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <Button size="sm" variant="primary" onClick={() => setAssigning(v)}>
                          {v.assigned ? t('reassign') : t('assign')}
                        </Button>
                        <Button size="sm" onClick={() => setCancelling(v)}>
                          {t('callOff')}
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
        <Margin />
      </div>
      {assigning ? <Assign visit={assigning} onClose={() => setAssigning(null)} /> : null}
      {cancelling ? <CallOff visit={cancelling} onClose={() => setCancelling(null)} /> : null}
    </>
  );
}
