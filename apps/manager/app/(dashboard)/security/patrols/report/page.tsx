'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { addDays, nameIn, postNameIn, today } from '@/components/security/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PatrolReport } from '@/lib/queries';
import ar from '@/messages/ar/guard-patrol-report';
import en from '@/messages/en/guard-patrol-report';

type Row = PatrolReport['routes'][number];

/** The patrol report (ADR 0052): per route over a period. */
export default function PatrolReportPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('patrols.manage') || can('guard_reports.read');
  const [from, setFrom] = useState(addDays(today(), -6));
  const [to, setTo] = useState(today());
  const report = useQuery({
    queryKey: keys.patrolReport({ from, to }),
    queryFn: () => fetchers.patrolReport({ from, to }),
    enabled: allowed && from !== '' && to !== '',
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const n = (v: number | null | undefined) => <span className="t-num">{fmt.number(v)}</span>;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('to')}>{(p) => <Input {...p} type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={report}>
          <DataTable<Row>
            rows={report.data?.routes}
            rowKey={(r) => r.route.id}
            empty={t('empty')}
            columns={[
              { key: 'route', header: t('col.route'), cell: (r) => <span className="table__primary">{nameIn(r.route, locale)}</span> },
              { key: 'post', header: t('col.post'), cell: (r) => postNameIn(r.post, locale) },
              { key: 'scheduled', header: t('col.scheduled'), cell: (r) => n(r.scheduled) },
              { key: 'adhoc', header: t('col.adhoc'), cell: (r) => n(r.adhoc) },
              { key: 'done', header: t('col.done'), cell: (r) => n(r.done) },
              { key: 'late', header: t('col.late'), cell: (r) => n(r.late) },
              { key: 'missed', header: t('col.missed'), cell: (r) => n(r.missed) },
              { key: 'incomplete', header: t('col.incomplete'), cell: (r) => n(r.incomplete) },
              { key: 'manual', header: t('col.manual'), cell: (r) => n(r.manualScans) },
              { key: 'suspect', header: t('col.suspect'), cell: (r) => n(r.suspectScans) },
              { key: 'offline', header: t('col.offline'), cell: (r) => n(r.lateScans) },
              { key: 'avg', header: t('col.avg'), cell: (r) => fmt.number(r.avgMinutes) },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
