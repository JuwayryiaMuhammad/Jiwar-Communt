'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Card, DataTable, Field, ForbiddenState, Input, PageHeader, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { nameOf } from '@/components/assets/format';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PlanCalendarEntry } from '@/lib/queries';
import ar from '@/messages/ar/assets-plans';
import en from '@/messages/en/assets-plans';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The planned work due across every plan (ADR 0076): the dates already
 * generated, with their status and work order, and the ones still to come.
 * Up to 93 days at a time.
 */
export default function PlanCalendarPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('assets.read');
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(new Date(Date.now() + 30 * 24 * 3_600_000)));
  const calendar = useQuery({
    queryKey: keys.planCalendar(from, to),
    queryFn: () => fetchers.planCalendar(from, to),
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('calendarTitle')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('calendarTitle')} description={t('calendarDescription')} />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('to')} hint={t('toHint')}>
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
      </div>
      <Card flush>
        <QueryState query={calendar}>
          <DataTable<PlanCalendarEntry>
            rows={calendar.data?.data ?? []}
            rowKey={(e) => `${e.planId}:${e.dueOn}`}
            empty={t('noWork')}
            columns={[
              {
                key: 'due',
                header: t('col.due'),
                cell: (e) => (
                  <>
                    <span>{fmt.day(e.dueOn)}</span>
                    {/* ADR 0084: a holiday flags the date; it is not moved. */}
                    {e.holiday ? (
                      <>
                        {' '}
                        <Badge tone="terracotta">{t('holiday', { name: nameOf(fmt.locale, e.holiday) })}</Badge>
                      </>
                    ) : null}
                  </>
                ),
              },
              {
                key: 'asset',
                header: t('col.asset'),
                cell: (e) => (
                  <Link className="table__link" href={`/assets/${e.assetId}`}>
                    {e.assetCode}
                  </Link>
                ),
              },
              { key: 'title', header: t('col.work'), cell: (e) => e.title },
              { key: 'priority', header: t('col.priority'), cell: (e) => label(e.priority) },
              {
                key: 'status',
                header: t('col.status'),
                cell: (e) => (e.status === 'projected' ? <Badge plain>{t('toCome')}</Badge> : <Badge>{label(e.status)}</Badge>),
              },
              {
                key: 'ticket',
                header: t('col.workOrder'),
                cell: (e) =>
                  e.ticketId ? (
                    <Link className="table__link" href={`/maintenance/${e.ticketId}`}>
                      {t('open')}
                    </Link>
                  ) : (
                    <span className="t-secondary">—</span>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
