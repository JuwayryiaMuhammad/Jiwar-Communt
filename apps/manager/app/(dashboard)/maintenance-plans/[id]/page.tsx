'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, ButtonLink, Card, CardBody, CardHeader, DataTable, Field, Input, PageHeader, ReasonCodeDialog, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { seriesText } from '@/components/assets/format';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PlanEvent, type PlanOccurrence } from '@/lib/queries';
import formatAr from '@/messages/ar/assets-format';
import ar from '@/messages/ar/assets-plans';
import formatEn from '@/messages/en/assets-format';
import en from '@/messages/en/assets-plans';

type Open = 'defer' | 'skip' | 'off' | { occurrence: PlanOccurrence } | null;

export default function PlanPage() {
  const t = useT(en, ar);
  const tf = useT(formatEn, formatAr);
  const fmt = useFormat();
  const label = useLabel();
  const { id } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const toast = useToast();
  const plan = useQuery({ queryKey: keys.plan(id), queryFn: () => fetchers.plan(id) });
  const occurrences = useCursorList(keys.planPart(id, 'occurrences'), (c) => fetchers.planOccurrences(id, c));
  const events = useCursorList(keys.planPart(id, 'events'), (c) => fetchers.planEvents(id, c));
  const [open, setOpen] = useState<Open>(null);
  const [toDate, setToDate] = useState('');
  const refresh = { invalidate: [keys.plan(id), keys.plansAll] };
  const close = () => {
    setOpen(null);
    setToDate('');
    for (const a of [defer, skip, off, deferOne]) a.reset();
  };
  const done = (text: string) => () => {
    toast.show(text);
    close();
  };
  const defer = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/plans/{id}/defer', { params: { path: { id } }, body: { toDate, reasonCode } })),
    { ...refresh, onDone: done(t('moved')) },
  );
  const skip = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/plans/{id}/skip', { params: { path: { id } }, body: { reasonCode } })),
    { ...refresh, onDone: done(t('skipped')) },
  );
  const off = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/plans/{id}/deactivate', { params: { path: { id } }, body: { reasonCode } })),
    { ...refresh, onDone: done(t('planOff')) },
  );
  const on = useAction(() => unwrap(api.POST('/api/v1/maintenance/plans/{id}/reactivate', { params: { path: { id } } })), {
    ...refresh,
    onDone: () => toast.show(t('planOnAgain')),
  });
  const deferOne = useAction(
    ({ occurrenceId, reasonCode }: { occurrenceId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/plan-occurrences/{id}/defer', { params: { path: { id: occurrenceId } }, body: { toDate, reasonCode } }),
      ),
    { ...refresh, onDone: done(t('oneMoved')) },
  );
  const p = plan.data;
  const manage = can('assets.manage');
  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/maintenance-plans" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {t('title')}
          </ButtonLink>
        }
        title={
          p ? (
            <span className="row" style={{ gap: 12 }}>
              {p.title}
              {!p.active ? <Badge tone="beige">{t('off')}</Badge> : null}
            </span>
          ) : (
            t('plan')
          )
        }
        description={
          p ? (p.trigger === 'usage' ? t('byUsage', { interval: p.usageInterval, metric: p.metricKey }) : seriesText(tf, p)) : undefined
        }
        actions={
          p && manage ? (
            <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {p.active && p.nextDueOn ? <Button onClick={() => setOpen('defer')}>{t('moveNext')}</Button> : null}
              {p.active && p.nextDueOn ? <Button onClick={() => setOpen('skip')}>{t('skipNext')}</Button> : null}
              {p.active ? (
                <Button variant="danger" onClick={() => setOpen('off')}>
                  {t('turnOff')}
                </Button>
              ) : (
                <Button loading={on.isPending} onClick={() => on.mutate()}>
                  {t('turnOn')}
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
      <ErrorAlert error={on.error} />
      <QueryState query={plan}>
        {p ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title={t('dueDates')} />
                <QueryState query={occurrences}>
                  <DataTable<PlanOccurrence>
                    rows={occurrences.rows}
                    rowKey={(o) => o.id}
                    empty={t('noneYet')}
                    columns={[
                      { key: 'd', header: t('col.due'), cell: (o) => fmt.day(o.dueOn) },
                      { key: 's', header: t('col.status'), cell: (o) => label(o.status) },
                      {
                        key: 'w',
                        header: t('col.workOrder'),
                        cell: (o) =>
                          o.ticketId ? (
                            <Link className="table__link" href={`/maintenance/${o.ticketId}`}>
                              {t('open')}
                            </Link>
                          ) : (
                            '—'
                          ),
                      },
                      { key: 'o', header: t('col.onTime'), cell: (o) => (o.onTime === null ? '—' : o.onTime ? t('yes') : t('late')) },
                      {
                        key: 'x',
                        header: <span className="visually-hidden">{t('actions')}</span>,
                        className: 'table__actions',
                        cell: (o) =>
                          manage && o.status === 'open' ? (
                            <Button size="sm" onClick={() => setOpen({ occurrence: o })}>
                              {t('move')}
                            </Button>
                          ) : null,
                      },
                    ]}
                  />
                  <LoadMore query={occurrences} />
                </QueryState>
              </Card>
              <Card flush>
                <CardHeader title={t('history')} />
                <QueryState query={events}>
                  <DataTable<PlanEvent>
                    rows={events.rows}
                    rowKey={(e) => e.id}
                    columns={[
                      { key: 'w', header: t('col.when'), width: 170, cell: (e) => fmt.dateTime(e.occurredAt) },
                      {
                        key: 'k',
                        header: t('col.what'),
                        cell: (e) => (
                          <>
                            {label(e.kind)}
                            {e.toValue && e.kind !== 'updated' ? (
                              <>
                                {' '}
                                <bdi>{/^\d{4}-\d{2}-\d{2}$/.test(e.toValue) ? fmt.day(e.toValue) : e.toValue}</bdi>
                              </>
                            ) : null}
                            {e.reasonCode ? ` (${label(e.reasonCode)})` : null}
                          </>
                        ),
                      },
                    ]}
                  />
                  <LoadMore query={events} />
                </QueryState>
              </Card>
            </div>
            <div className="stack">
              <Card flush>
                <CardHeader title={t('record')} />
                <CardBody>
                  <dl className="dl">
                    <dt>{t('asset')}</dt>
                    <dd>
                      <Link className="table__link" href={`/assets/${p.assetId}`}>
                        {t('openAsset')}
                      </Link>
                    </dd>
                    <dt>{t('nextDue')}</dt>
                    <dd>{p.nextDueOn ? fmt.day(p.nextDueOn) : '—'}</dd>
                    <dt>{t('opens')}</dt>
                    <dd>{t('opensValue', { n: p.leadDays })}</dd>
                    <dt>{t('onTimeWithin')}</dt>
                    <dd>{t('graceValue', { n: p.graceDays })}</dd>
                    <dt>{t('done')}</dt>
                    <dd>{t('doneValue', { n: fmt.number(p.stats.done), rate: fmt.percent(p.stats.done ? p.stats.onTime / p.stats.done : null, 0) })}</dd>
                    <dt>{t('openCount')}</dt>
                    <dd>
                      {fmt.number(p.stats.open)}
                      {p.stats.overdue ? <Badge tone="error">{t('overdue', { n: fmt.number(p.stats.overdue) })}</Badge> : null}
                    </dd>
                  </dl>
                </CardBody>
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={open === 'defer' || (open !== null && typeof open === 'object')}
        onClose={close}
        title={typeof open === 'object' && open ? t('moveOneTitle') : t('moveNextTitle')}
        codes={REASON_CODES.planDefer}
        confirmLabel={t('move')}
        ready={toDate !== ''}
        pending={defer.isPending || deferOne.isPending}
        error={<ErrorAlert error={defer.error ?? deferOne.error} />}
        onConfirm={(c) =>
          typeof open === 'object' && open ? deferOne.mutate({ occurrenceId: open.occurrence.id, reasonCode: c }) : defer.mutate(c)
        }
      >
        <Field label={t('to')}>{(f) => <Input {...f} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />}</Field>
      </ReasonCodeDialog>
      <ReasonCodeDialog
        open={open === 'skip'}
        onClose={close}
        title={t('skipTitle')}
        codes={REASON_CODES.planSkip}
        confirmLabel={t('skip')}
        pending={skip.isPending}
        error={<ErrorAlert error={skip.error} />}
        onConfirm={(c) => skip.mutate(c)}
      />
      <ReasonCodeDialog
        open={open === 'off'}
        onClose={close}
        title={t('offTitle')}
        description={t('offDescription')}
        codes={REASON_CODES.planDeactivate}
        confirmLabel={t('turnOff')}
        danger
        pending={off.isPending}
        error={<ErrorAlert error={off.error} />}
        onConfirm={(c) => off.mutate(c)}
      />
    </>
  );
}
