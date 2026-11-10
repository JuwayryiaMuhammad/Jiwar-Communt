'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplianceCalendar } from '@/lib/queries';
import ar from '@/messages/ar/compliance-calendar';
import en from '@/messages/en/compliance-calendar';

type Entry = ComplianceCalendar['entries'][number];

/**
 * The compliance calendar (ADR 0087): the items' due days and the vendors'
 * papers expiring, by day; 90 days by default, a year at most.
 */
export default function ComplianceCalendarPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('compliance.manage');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const cal = useQuery({ queryKey: keys.complianceCalendar(period), queryFn: () => fetchers.complianceCalendar(period), enabled: allowed });
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
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={cal}>
          <DataTable<Entry>
            rows={cal.data?.entries ?? []}
            rowKey={(e) => e.id}
            empty={t('none')}
            columns={[
              { key: 'd', header: t('col.day'), cell: (e) => f.day(e.day) },
              {
                key: 'w',
                header: t('col.what'),
                cell: (e) =>
                  e.source === 'compliance' && e.itemId ? (
                    <Link className="table__link" href={`/compliance/${e.itemId}`}>
                      {e.title}
                    </Link>
                  ) : e.vendorId ? (
                    <Link className="table__link" href={`/vendors/${e.vendorId}`}>
                      {t('vendorPaper', { vendor: e.vendorName ?? '', kind: label(e.kind) })}
                    </Link>
                  ) : (
                    '—'
                  ),
              },
              { key: 'k', header: t('col.kind'), cell: (e) => label(e.kind) },
              { key: 's', header: t('col.state'), cell: (e) => label(e.state) },
            ]}
          />
          {cal.data?.truncated ? <p className="t-secondary">{t('truncated')}</p> : null}
        </QueryState>
      </Card>
    </>
  );
}
