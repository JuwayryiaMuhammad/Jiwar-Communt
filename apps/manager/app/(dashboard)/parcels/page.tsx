'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  Segmented,
  Select,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Parcel, type ParcelCarrier, type ParcelFilters, type ParcelStatus } from '@/lib/queries';
import ar from '@/messages/ar/gate-parcels';
import en from '@/messages/en/gate-parcels';

const CARRIERS: ParcelCarrier[] = ['aramex', 'dhl', 'fedex', 'ups', 'bosta', 'mylerz', 'egypt_post', 'amazon', 'noon', 'jumia', 'talabat', 'other'];
const NAMED = ['dhl', 'ups', 'fedex', 'egypt_post'] as const;

/** A carrier's name in the page's language: the few written their own way here, the shared words for the rest. */
function useCarrier() {
  const t = useT(en, ar);
  const label = useLabel();
  return (c: ParcelCarrier) => ((NAMED as readonly string[]).includes(c) ? t(`carrier.${c as (typeof NAMED)[number]}`) : label(c));
}

/** The API's `rejected` is the unit refusing the parcel: one word for it everywhere. */
function ParcelStatusBadge({ status }: { status: ParcelStatus }) {
  const t = useT(en, ar);
  return status === 'rejected' ? <Badge tone="error">{t('refused')}</Badge> : <StatusBadge status={status} />;
}
const VIEWS = ['held', 'handed_over', 'rejected', 'returned', 'all'] as const;
type View = (typeof VIEWS)[number];

function ParcelDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const carrier = useCarrier();
  const parcel = useQuery({ queryKey: keys.parcel(id), queryFn: () => fetchers.parcel(id) });
  const p = parcel.data;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={p ? t('parcelTitle', { number: p.number, unit: p.unitCode }) : t('col.parcel')}
      description={p ? t('parcelDescription', { carrier: carrier(p.carrier), pieces: p.pieces }) : undefined}
      footer={<Button onClick={onClose}>{c('close')}</Button>}
    >
      <QueryState query={parcel} rows={4}>
        {p ? (
          <div className="stack">
            <dl className="dl">
              <dt>{c('status')}</dt>
              <dd>
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <ParcelStatusBadge status={p.status} />
                  {p.status === 'held' ? <span className="t-secondary">{t('heldDays', { days: p.heldDays })}</span> : null}
                  {p.unclaimable ? <Badge tone="terracotta">{t('nobodyCanClaim')}</Badge> : null}
                </span>
              </dd>
              <dt>{t('receivedAt')}</dt>
              <dd>{f.dateTime(p.receivedAt)}</dd>
              {p.handedOverAt ? (
                <>
                  <dt>{t('handedOver')}</dt>
                  <dd>{f.dateTime(p.handedOverAt)}</dd>
                </>
              ) : null}
              {p.rejectedAt ? (
                <>
                  <dt>{t('refusedByUnit')}</dt>
                  <dd>
                    {f.dateTime(p.rejectedAt)}
                    {p.rejectReason ? ` · ${label(p.rejectReason)}` : ''}
                  </dd>
                </>
              ) : null}
              {p.returnedAt ? (
                <>
                  <dt>{t('returnedToCarrier')}</dt>
                  <dd>
                    {f.dateTime(p.returnedAt)}
                    {p.returnReason ? ` · ${label(p.returnReason)}` : ''}
                  </dd>
                </>
              ) : null}
              <dt>{t('reminders')}</dt>
              <dd>
                {p.reminded ? t('unitReminded') : t('noReminder')}
                {p.heldLongNotified ? ` · ${t('heldLongTold')}` : ''}
              </dd>
            </dl>
            <div className="stack stack--sm">
              <strong>{t('whatHappened')}</strong>
              <ol className="timeline" style={{ padding: 0 }}>
                {p.events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className={`timeline__item${e.kind === 'rejected' || e.kind === 'returned' ? ' timeline__item--warn' : ''}`}>
                    <div className="timeline__title">{label(e.kind)}</div>
                    <div className="timeline__meta">
                      {f.dateTime(e.at)} · {t(`by.${e.actorSide}`)}
                      {e.method ? ` · ${label(e.method)}` : ''}
                      {e.reasonCode ? ` · ${label(e.reasonCode)}` : ''}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <p className="t-secondary">{t('noNames')}</p>
          </div>
        ) : null}
      </QueryState>
    </Dialog>
  );
}

/** How long a parcel waits before its residents, then management, are told. */
function HoldingPeriodsDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.parcelSettings, queryFn: fetchers.parcelSettings });
  const [reminder, setReminder] = useState('');
  const [manager, setManager] = useState('');
  useEffect(() => {
    if (settings.data) {
      setReminder(String(settings.data.parcelReminderDays));
      setManager(String(settings.data.parcelManagerDays));
    }
  }, [settings.data]);
  const saved = settings.data;
  const changes = saved
    ? {
        ...(Number(reminder) !== saved.parcelReminderDays ? { parcelReminderDays: Number(reminder) } : {}),
        ...(Number(manager) !== saved.parcelManagerDays ? { parcelManagerDays: Number(manager) } : {}),
      }
    : {};
  const dirty = Object.keys(changes).length > 0;
  // The one cross-field rule, said before the API has to.
  const inverted = reminder !== '' && manager !== '' && Number(manager) <= Number(reminder);
  const save = useAction(() => unwrap(api.PATCH('/api/v1/parcel-settings', { body: changes })), {
    invalidate: [keys.parcelSettings],
    onDone: () => {
      toast.show(t('periodsSaved'));
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('periodsTitle')}
      description={t('periodsDescription')}
      onSubmit={() => dirty && !inverted && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || inverted}>
            {c('save')}
          </Button>
        </>
      }
    >
      <QueryState query={settings} rows={2}>
        <div className="form">
          <Field label={t('remindAfter')} hint={t('rangeHint', { min: 1, max: 30 })} error={fieldError(save.error, 'parcelReminderDays')}>
            {(p) => <Input {...p} type="number" min={1} max={30} value={reminder} onChange={(e) => setReminder(e.target.value)} />}
          </Field>
          <Field
            label={t('tellAfter')}
            hint={t('managerHint', { min: 2, max: 90 })}
            error={fieldError(save.error, 'parcelManagerDays') ?? (inverted ? t('moreThanReminder') : undefined)}
          >
            {(p) => <Input {...p} type="number" min={2} max={90} value={manager} onChange={(e) => setManager(e.target.value)} />}
          </Field>
          <ErrorAlert error={save.error} />
        </div>
      </QueryState>
    </Dialog>
  );
}

/**
 * Every parcel at the gate (ADR 0035), without names. Guards receive and
 * hand over; this is management's read of what is waiting and for how long.
 */
export default function ParcelsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const carrier = useCarrier();
  const [view, setView] = useState<View>('held');
  const [carrierFilter, setCarrierFilter] = useState<ParcelCarrier | ''>('');
  const [unitCode, setUnitCode] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  // A notification about a parcel links here with `?parcel=`.
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('parcel');
    if (linked) setOpen(linked);
  }, []);
  const [settings, setSettings] = useState(false);
  const filters: ParcelFilters = { status: view === 'all' ? '' : (view as ParcelStatus), carrier: carrierFilter, unitCode: unitCode.trim() };
  const { ready, can } = usePermissions();
  const allowed = can('parcels.manage');
  const list = useCursorList(keys.parcels(filters), (cursor) => fetchers.parcels(filters, cursor), { refetchInterval: 120_000, enabled: allowed });

  // The list and the holding periods both need `parcels.manage`.
  if (ready && !allowed) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={<Button onClick={() => setSettings(true)}>{t('holdingPeriods')}</Button>}
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: v === 'all' ? c('all') : t(`view.${v}`) }))}
        />
        <Field label={t('carrier')}>
          {(p) => (
            <Select {...p} value={carrierFilter} onChange={(e) => setCarrierFilter(e.target.value as ParcelCarrier | '')}>
              <option value="">{t('anyCarrier')}</option>
              {CARRIERS.map((k) => (
                <option key={k} value={k}>
                  {carrier(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('unitCode')}>
          {(p) => <Input {...p} placeholder={t('unitCodePlaceholder')} dir="ltr" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Parcel>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={view === 'held' ? t('emptyHeld') : t('empty')}
            emptyHint={view === 'held' ? t('emptyHeldHint') : undefined}
            columns={[
              {
                key: 'number',
                header: t('col.parcel'),
                cell: (p) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(p.id)}>
                    {p.number}
                  </Button>
                ),
              },
              { key: 'unit', header: c('unit'), cell: (p) => p.unitCode },
              { key: 'carrier', header: t('col.carrier'), cell: (p) => carrier(p.carrier) },
              { key: 'pieces', header: t('col.pieces'), cell: (p) => <span className="t-num">{f.number(p.pieces)}</span> },
              {
                key: 'status',
                header: c('status'),
                cell: (p) => (
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <ParcelStatusBadge status={p.status} />
                    {p.status === 'held' && p.heldLongNotified ? <Badge tone="error">{t('heldLong')}</Badge> : null}
                    {p.status === 'held' && p.reminded && !p.heldLongNotified ? <Badge plain>{t('reminded')}</Badge> : null}
                    {p.unclaimable ? <Badge tone="terracotta">{t('unclaimable')}</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'held',
                header: t('col.atGate'),
                cell: (p) =>
                  p.status === 'held' ? <span className="t-num">{t('daysShort', { days: f.number(p.heldDays) })}</span> : <span className="t-secondary">—</span>,
              },
              {
                key: 'received',
                header: t('col.received'),
                cell: (p) => (
                  <span title={f.dateTime(p.receivedAt)} style={{ whiteSpace: 'nowrap' }}>
                    {f.relative(p.receivedAt)}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <ParcelDialog id={open} onClose={() => setOpen(null)} /> : null}
      {settings ? <HoldingPeriodsDialog onClose={() => setSettings(false)} /> : null}
    </>
  );
}
