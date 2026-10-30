'use client';

import { ErrorAlert, QueryState } from '@jiwar/api/react';
import { Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FacilityUsageReport } from '@/lib/queries';

type Row = FacilityUsageReport['facilities'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);

/** How the bookable facilities are used (ADR 0067), for who sets them up or works the bookings. */
export default function FacilityUsagePage() {
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
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Facility use" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Facility use"
        description="Bookings by status, booked time over the time each facility was open (minus closures), no-shows and the peak share."
        actions={
          <Button
            onClick={() =>
              download('/api/v1/staff/facility-usage/export', { from, to }, `facility-usage-${from}-${to}.csv`).catch(setCsvError)
            }
          >
            Export CSV
          </Button>
        }
      />
      <ErrorAlert error={csvError} />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={report}>
          <DataTable<Row>
            rows={report.data?.facilities ?? []}
            rowKey={(r) => r.facilityId}
            empty="No bookable facility"
            columns={[
              { key: 'n', header: 'Facility', cell: (r) => r.nameEn },
              { key: 'c', header: 'Confirmed', cell: (r) => r.bookings.confirmed },
              { key: 'x', header: 'Cancelled', cell: (r) => r.bookings.cancelled },
              { key: 'ns', header: 'No-shows', cell: (r) => `${r.noShows} (${pct(r.noShowRate)})` },
              { key: 'u', header: 'Use', cell: (r) => pct(r.use) },
              { key: 'o', header: 'Open hours', cell: (r) => Math.round(r.openMinutes / 60) },
              { key: 'p', header: 'At peak', cell: (r) => pct(r.peakShare) },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
