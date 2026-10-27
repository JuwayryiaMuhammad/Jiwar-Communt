'use client';

import { formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, ButtonLink, Card, CardBody, CardHeader, DataTable, Field, Input, PageHeader, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { rateText, seriesText } from '@/components/assets/format';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PlanEvent, type PlanOccurrence } from '@/lib/queries';

type Open = 'defer' | 'skip' | 'off' | { occurrence: PlanOccurrence } | null;

export default function PlanPage() {
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
    { ...refresh, onDone: done('The next due date moved.') },
  );
  const skip = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/plans/{id}/skip', { params: { path: { id } }, body: { reasonCode } })),
    { ...refresh, onDone: done('Skipped.') },
  );
  const off = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/plans/{id}/deactivate', { params: { path: { id } }, body: { reasonCode } })),
    { ...refresh, onDone: done('The plan is off.') },
  );
  const on = useAction(() => unwrap(api.POST('/api/v1/maintenance/plans/{id}/reactivate', { params: { path: { id } } })), {
    ...refresh,
    onDone: () => toast.show('The plan is on again.'),
  });
  const deferOne = useAction(
    ({ occurrenceId, reasonCode }: { occurrenceId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/plan-occurrences/{id}/defer', { params: { path: { id: occurrenceId } }, body: { toDate, reasonCode } }),
      ),
    { ...refresh, onDone: done('Its due date moved.') },
  );
  const p = plan.data;
  const manage = can('assets.manage');
  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/maintenance-plans" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Planned maintenance
          </ButtonLink>
        }
        title={p ? <span className="row" style={{ gap: 12 }}>{p.title}{!p.active ? <Badge tone="beige">Off</Badge> : null}</span> : 'Plan'}
        description={p ? (p.trigger === 'usage' ? `By usage: every ${p.usageInterval} of ${p.metricKey}` : seriesText(p)) : undefined}
        actions={
          p && manage ? (
            <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {p.active && p.nextDueOn ? <Button onClick={() => setOpen('defer')}>Move next due</Button> : null}
              {p.active && p.nextDueOn ? <Button onClick={() => setOpen('skip')}>Skip next</Button> : null}
              {p.active ? (
                <Button variant="danger" onClick={() => setOpen('off')}>
                  Turn off
                </Button>
              ) : (
                <Button loading={on.isPending} onClick={() => on.mutate()}>
                  Turn on
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
                <CardHeader title="Due dates" />
                <QueryState query={occurrences}>
                  <DataTable<PlanOccurrence>
                    rows={occurrences.rows}
                    rowKey={(o) => o.id}
                    empty="None yet"
                    columns={[
                      { key: 'd', header: 'Due', cell: (o) => formatDate(o.dueOn) },
                      { key: 's', header: 'Status', cell: (o) => humanize(o.status) },
                      {
                        key: 'w',
                        header: 'Work order',
                        cell: (o) =>
                          o.ticketId ? (
                            <Link className="table__link" href={`/maintenance/${o.ticketId}`}>
                              Open
                            </Link>
                          ) : (
                            '—'
                          ),
                      },
                      { key: 'o', header: 'On time', cell: (o) => (o.onTime === null ? '—' : o.onTime ? 'Yes' : 'Late') },
                      {
                        key: 'x',
                        header: <span className="visually-hidden">Actions</span>,
                        className: 'table__actions',
                        cell: (o) =>
                          manage && o.status === 'open' ? (
                            <Button size="sm" onClick={() => setOpen({ occurrence: o })}>
                              Move
                            </Button>
                          ) : null,
                      },
                    ]}
                  />
                  <LoadMore query={occurrences} />
                </QueryState>
              </Card>
              <Card flush>
                <CardHeader title="History" />
                <QueryState query={events}>
                  <DataTable<PlanEvent>
                    rows={events.rows}
                    rowKey={(e) => e.id}
                    columns={[
                      { key: 'w', header: 'When', width: 170, cell: (e) => formatDateTime(e.occurredAt) },
                      {
                        key: 'k',
                        header: 'What',
                        cell: (e) =>
                          `${humanize(e.kind)}${e.toValue && e.kind !== 'updated' ? ` ${e.toValue}` : ''}${e.reasonCode ? ` (${humanize(e.reasonCode).toLowerCase()})` : ''}`,
                      },
                    ]}
                  />
                  <LoadMore query={events} />
                </QueryState>
              </Card>
            </div>
            <div className="stack">
              <Card flush>
                <CardHeader title="Record" />
                <CardBody>
                  <dl className="dl">
                    <dt>Asset</dt>
                    <dd>
                      <Link className="table__link" href={`/assets/${p.assetId}`}>
                        Open the asset
                      </Link>
                    </dd>
                    <dt>Next due</dt>
                    <dd>{p.nextDueOn ? formatDate(p.nextDueOn) : '—'}</dd>
                    <dt>Opens</dt>
                    <dd>{p.leadDays} days before</dd>
                    <dt>On time within</dt>
                    <dd>{p.graceDays} days after</dd>
                    <dt>Done</dt>
                    <dd>
                      {p.stats.done} · on time {rateText(p.stats.done ? p.stats.onTime / p.stats.done : null)}
                    </dd>
                    <dt>Open</dt>
                    <dd>
                      {p.stats.open}
                      {p.stats.overdue ? <Badge tone="error">{p.stats.overdue} overdue</Badge> : null}
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
        title={typeof open === 'object' && open ? 'Move this due date' : 'Move the next due date'}
        codes={REASON_CODES.planDefer}
        confirmLabel="Move"
        ready={toDate !== ''}
        pending={defer.isPending || deferOne.isPending}
        error={<ErrorAlert error={defer.error ?? deferOne.error} />}
        onConfirm={(c) =>
          typeof open === 'object' && open ? deferOne.mutate({ occurrenceId: open.occurrence.id, reasonCode: c }) : defer.mutate(c)
        }
      >
        <Field label="To">{(f) => <Input {...f} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />}</Field>
      </ReasonCodeDialog>
      <ReasonCodeDialog
        open={open === 'skip'}
        onClose={close}
        title="Skip the next due date"
        codes={REASON_CODES.planSkip}
        confirmLabel="Skip"
        pending={skip.isPending}
        error={<ErrorAlert error={skip.error} />}
        onConfirm={(c) => skip.mutate(c)}
      />
      <ReasonCodeDialog
        open={open === 'off'}
        onClose={close}
        title="Turn the plan off"
        description="Nothing new comes due; work orders already open stay."
        codes={REASON_CODES.planDeactivate}
        confirmLabel="Turn off"
        danger
        pending={off.isPending}
        error={<ErrorAlert error={off.error} />}
        onConfirm={(c) => off.mutate(c)}
      />
    </>
  );
}
