'use client';

import { humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplaintsMap } from '@/lib/queries';

type Building = ComplaintsMap['buildings'][number];
type Area = ComplaintsMap['areas'][number];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (lat: number | null, lng: number | null) => (lat === null || lng === null ? '—' : `${lat.toFixed(5)}, ${lng.toFixed(5)}`);

/**
 * Where the tickets are (ADR 0081): per building and per common area, with
 * their positions where the register has them. Counts only: a building
 * opens the ticket list filtered by it.
 */
export default function ComplaintsMapPage() {
  const { ready, can } = usePermissions();
  const allowed = can('tickets.dispatch');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 24 * 3_600_000)));
  const map = useQuery({ queryKey: keys.complaintsMap(from, to), queryFn: () => fetchers.complaintsMap(from, to), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Complaints map" />
        <ForbiddenState />
      </>
    );
  const most = Math.max(1, ...(map.data?.buildings ?? []).map((b) => b.total));
  return (
    <>
      <PageHeader
        title="Complaints map"
        description="The tickets of each building’s units and of each common area over the period, cancelled ones left out. No unit, ticket or person is shown here."
      />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={map}>
        <Card flush>
          <DataTable<Building>
            rows={map.data?.buildings ?? []}
            rowKey={(b) => b.buildingId}
            empty="No building in the register"
            columns={[
              {
                key: 'name',
                header: 'Building',
                cell: (b) => (
                  <Link className="table__link" href={`/maintenance?buildingId=${b.buildingId}`}>
                    {b.name}
                  </Link>
                ),
              },
              {
                key: 'bubble',
                header: 'Tickets',
                cell: (b) => (
                  <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        borderRadius: '50%',
                        background: 'var(--color-terracotta, #c4673f)',
                        width: 8 + 24 * (b.total / most),
                        height: 8 + 24 * (b.total / most),
                      }}
                    />
                    {b.total}
                  </span>
                ),
              },
              { key: 'open', header: 'Open', cell: (b) => b.open },
              { key: 'residents', header: 'From residents', cell: (b) => b.residents },
              {
                key: 'categories',
                header: 'Most',
                cell: (b) => b.categories.map((c) => `${humanize(c.categoryKey)} ${c.count}`).join(' · ') || '—',
              },
              { key: 'at', header: 'Position', cell: (b) => at(b.latitude, b.longitude) },
            ]}
          />
        </Card>
        <PageHeader title="Common areas" description="Their own tickets and their assets’." />
        <Card flush>
          <DataTable<Area>
            rows={map.data?.areas ?? []}
            rowKey={(x) => x.commonAreaId}
            empty="No common area had a ticket in this period"
            columns={[
              { key: 'code', header: 'Area', cell: (x) => x.code },
              { key: 'kind', header: 'Kind', cell: (x) => humanize(x.kind) },
              { key: 'total', header: 'Tickets', cell: (x) => x.total },
              { key: 'open', header: 'Open', cell: (x) => x.open },
              { key: 'at', header: 'Position', cell: (x) => at(x.latitude, x.longitude) },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
