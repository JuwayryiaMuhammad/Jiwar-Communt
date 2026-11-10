'use client';

import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocalName } from '@/components/facilities/bits';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FacilityUsageReport } from '@/lib/queries';
import ar from '@/messages/ar/fac-bans';
import en from '@/messages/en/fac-bans';

type Row = FacilityUsageReport['facilities'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** How the bookable facilities are used (ADR 0067), for who sets them up or works the bookings. */
export default function FacilityUsagePage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const localName = useLocalName();
  const { ready, can } = usePermissions();
  const allowed = can('facilities.manage') || can('bookings.handle');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 24 * 3_600_000)));
  const report = useQuery({
    queryKey: keys.facilityUsage(from, to),
    queryFn: () => fetchers.facilityUsage(from, to),
    enabled: allowed,
  });
  const [csvError, setCsvError] = useState<unknown>(null);
  // The report gives whole percentages: 42 is 42%.
  const pct = (n: number | null) => (n === null ? '—' : f.percent(n / 100, 0));
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('usage.title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('usage.title')}
        description={t('usage.description')}
        actions={
          <Button
            onClick={() =>
              download('/api/v1/staff/facility-usage/export', { from, to }, `facility-usage-${from}-${to}.csv`).catch(setCsvError)
            }
          >
            {t('usage.export')}
          </Button>
        }
      />
      <ErrorAlert error={csvError} />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={report}>
          <DataTable<Row>
            rows={report.data?.facilities ?? []}
            rowKey={(r) => r.facilityId}
            empty={t('usage.empty')}
            columns={[
              { key: 'n', header: t('col.facility'), cell: (r) => localName(r) },
              { key: 'c', header: t('usage.confirmed'), cell: (r) => f.number(r.bookings.confirmed) },
              { key: 'x', header: t('usage.cancelled'), cell: (r) => f.number(r.bookings.cancelled) },
              { key: 'ns', header: t('usage.noShows'), cell: (r) => `${f.number(r.noShows)} (${pct(r.noShowRate)})` },
              { key: 'u', header: t('usage.use'), cell: (r) => pct(r.use) },
              { key: 'o', header: t('usage.openHours'), cell: (r) => f.number(Math.round(r.openMinutes / 60)) },
              { key: 'p', header: t('usage.atPeak'), cell: (r) => pct(r.peakShare) },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
