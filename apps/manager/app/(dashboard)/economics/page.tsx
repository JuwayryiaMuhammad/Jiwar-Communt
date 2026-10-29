'use client';

import { humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Card, CardBody, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, Stat } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TechnicianStats } from '@/lib/queries';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);

/** What maintenance cost and how it went (ADR 0065): computed on read, by rule. */
export default function EconomicsPage() {
  const { ready, can } = usePermissions();
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)));
  const [to, setTo] = useState(iso(now));
  const economics = useQuery({ queryKey: keys.economics(from, to), queryFn: () => fetchers.economics(from, to), enabled: can('assets.manage') });
  const kpis = useQuery({ queryKey: keys.kpis(from, to), queryFn: () => fetchers.kpis(from, to), enabled: can('assets.manage') });
  const people = useQuery({
    queryKey: keys.technicianStats(from, to),
    queryFn: () => fetchers.technicianStats(from, to),
    enabled: can('tickets.dispatch'),
  });
  const names = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians, enabled: can('tickets.dispatch') });
  const nameOf = (id: string) => names.data?.data.find((t) => t.id === id)?.fullName ?? '—';
  if (ready && !can('assets.manage'))
    return (
      <>
        <PageHeader title="Economics" />
        <ForbiddenState />
      </>
    );
  const e = economics.data;
  const k = kpis.data;
  return (
    <>
      <PageHeader title="Economics" description="Spend, the plan ahead and how the work went, over the compound’s days." />
      <div className="toolbar">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(x) => setFrom(x.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(x) => setTo(x.target.value)} />}</Field>
      </div>
      <QueryState query={kpis}>
        {k ? (
          <div className="grid grid--stats">
            <Stat label="Planned work" value={pct(k.plannedShare)} hint={`${k.completedPlanned} planned, ${k.completedCorrective} repairs`} />
            <Stat label="Mean time to repair" value={k.mttrHours === null ? '—' : `${k.mttrHours} h`} />
            <Stat label="Mean time between failures" value={k.mtbfDays === null ? '—' : `${k.mtbfDays} days`} hint={`${k.failures} failures`} />
            <Stat label="Plans on time" value={pct(k.compliance)} hint={`${k.occurrencesOnTime} of ${k.occurrencesDue}`} />
          </div>
        ) : null}
      </QueryState>
      <QueryState query={economics}>
        {e ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title="Spend">
                  <span className="text-muted">
                    {e.spend.total} EGP · planned {e.spend.planned} · repairs {e.spend.corrective}
                  </span>
                </CardHeader>
                <DataTable
                  rows={e.byMonth}
                  rowKey={(m) => m.month}
                  empty="Nothing spent"
                  columns={[
                    { key: 'm', header: 'Month', cell: (m) => m.month },
                    { key: 'a', header: 'EGP', cell: (m) => m.amount },
                  ]}
                />
              </Card>
              <Card flush>
                <CardHeader title="What cost most" />
                <DataTable
                  rows={e.topAssets}
                  rowKey={(a) => a.assetId}
                  empty="No asset’s work cost anything"
                  columns={[
                    {
                      key: 'c',
                      header: 'Asset',
                      cell: (a) => (
                        <Link className="table__link" href={`/assets/${a.assetId}`}>
                          {a.code}
                        </Link>
                      ),
                    },
                    { key: 'a', header: 'EGP', cell: (a) => a.amount },
                  ]}
                />
              </Card>
            </div>
            <div className="stack">
              <Card flush>
                <CardHeader title="Replacements ahead" />
                <DataTable
                  rows={e.capitalPlan}
                  rowKey={(y) => String(y.year)}
                  empty="—"
                  columns={[
                    { key: 'y', header: 'Year', cell: (y) => y.year },
                    { key: 'a', header: 'EGP', cell: (y) => y.amount },
                    { key: 'n', header: 'Assets', cell: (y) => y.assets },
                  ]}
                />
                <CardBody>
                  <p className="text-muted">
                    Reserve: {e.reserve.annual} EGP a year, {e.reserve.accrued} EGP built up.
                  </p>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title="By category" />
                <DataTable
                  rows={e.byCategory}
                  rowKey={(c) => c.categoryKey}
                  empty="—"
                  columns={[
                    { key: 'c', header: 'Category', cell: (c) => humanize(c.categoryKey) },
                    { key: 'a', header: 'EGP', cell: (c) => c.amount },
                  ]}
                />
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
      {can('tickets.dispatch') ? (
        <Card flush>
          <CardHeader title="Technicians" />
          <QueryState query={people}>
            <DataTable<TechnicianStats>
              rows={people.data?.data ?? []}
              rowKey={(t) => t.technicianId}
              empty="No technician"
              columns={[
                { key: 'n', header: 'Technician', cell: (t) => nameOf(t.technicianId) },
                { key: 'c', header: 'Completed', cell: (t) => t.completed },
                { key: 'h', header: 'Hours to complete', cell: (t) => t.meanHoursToComplete ?? '—' },
                { key: 'b', header: 'Sent back', cell: (t) => t.sentBack },
                { key: 's', header: 'SLA met', cell: (t) => pct(t.slaAdherence) },
                { key: 'r', header: 'Rating', cell: (t) => (t.meanRating === null ? `— (${t.ratings})` : `${t.meanRating} (${t.ratings})`) },
                { key: 'i', header: 'In hand', cell: (t) => t.inHand },
              ]}
            />
          </QueryState>
        </Card>
      ) : null}
    </>
  );
}
