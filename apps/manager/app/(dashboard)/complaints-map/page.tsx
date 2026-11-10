'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplaintsMap } from '@/lib/queries';
import ar from '@/messages/ar/complaints-map';
import en from '@/messages/en/complaints-map';

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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('tickets.dispatch');
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 24 * 3_600_000)));
  const map = useQuery({ queryKey: keys.complaintsMap(from, to), queryFn: () => fetchers.complaintsMap(from, to), enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const most = Math.max(1, ...(map.data?.buildings ?? []).map((b) => b.total));
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="form__row" style={{ marginBottom: 12 }}>
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={map}>
        <Card flush>
          <DataTable<Building>
            rows={map.data?.buildings ?? []}
            rowKey={(b) => b.buildingId}
            empty={t('emptyBuildings')}
            columns={[
              {
                key: 'name',
                header: c('building'),
                cell: (b) => (
                  <Link className="table__link" href={`/maintenance?buildingId=${b.buildingId}`}>
                    {b.name}
                  </Link>
                ),
              },
              {
                key: 'bubble',
                header: t('tickets'),
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
                    {f.number(b.total)}
                  </span>
                ),
              },
              { key: 'open', header: t('open'), cell: (b) => f.number(b.open) },
              { key: 'residents', header: t('fromResidents'), cell: (b) => f.number(b.residents) },
              {
                key: 'categories',
                header: t('most'),
                cell: (b) => b.categories.map((x) => `${label(x.categoryKey)} ${f.number(x.count)}`).join(' · ') || '—',
              },
              { key: 'at', header: t('position'), cell: (b) => <span className="ltr">{at(b.latitude, b.longitude)}</span> },
            ]}
          />
        </Card>
        <PageHeader title={t('areasTitle')} description={t('areasDescription')} />
        <Card flush>
          <DataTable<Area>
            rows={map.data?.areas ?? []}
            rowKey={(x) => x.commonAreaId}
            empty={t('emptyAreas')}
            columns={[
              { key: 'code', header: t('area'), cell: (x) => <span className="ltr">{x.code}</span> },
              { key: 'kind', header: c('kind'), cell: (x) => label(x.kind) },
              { key: 'total', header: t('tickets'), cell: (x) => f.number(x.total) },
              { key: 'open', header: t('open'), cell: (x) => f.number(x.open) },
              { key: 'at', header: t('position'), cell: (x) => <span className="ltr">{at(x.latitude, x.longitude)}</span> },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
