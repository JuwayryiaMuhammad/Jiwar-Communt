'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CapitalPlan } from '@/lib/queries';
import ar from '@/messages/ar/ops-capital-plans';
import en from '@/messages/en/ops-capital-plans';

/**
 * The capital plans (ADR 0086): one a year, for this year or the next
 * five; seeded from the register's replacements due that year, put to the
 * board once, and locked once it approves.
 */
export default function CapitalPlansPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const router = useRouter();
  const { ready, can } = usePermissions();
  const allowed = can('assets.manage');
  const plans = useQuery({ queryKey: keys.capitalPlansAll, queryFn: fetchers.capitalPlans, enabled: allowed });
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [seed, setSeed] = useState(true);
  const create = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/capital-plans', { body: { year: Number(year), seed } })),
    { invalidate: [keys.capitalPlansAll], onDone: (p) => router.push(`/capital-plans/${p.id}`) },
  );
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
      <Card>
        <div className="form__row" style={{ padding: 12 }}>
          <Field label={t('year')} error={fieldError(create.error, 'year')}>
            {(p) => <Input {...p} inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />}
          </Field>
          <Checkbox label={t('seed')} checked={seed} onChange={(e) => setSeed(e.target.checked)} />
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate(undefined)}>
            {t('draw')}
          </Button>
        </div>
        <ErrorAlert error={create.error} />
      </Card>
      <QueryState query={plans}>
        <Card flush>
          <DataTable<CapitalPlan>
            rows={plans.data?.data ?? []}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              { key: 'year', header: t('col.year'), cell: (p) => <Link href={`/capital-plans/${p.id}`}>{p.year}</Link> },
              { key: 'lines', header: t('col.lines'), cell: (p) => fmt.number(p.lines.length) },
              { key: 'total', header: t('col.total'), cell: (p) => fmt.money(p.total) },
              {
                key: 'status',
                header: t('col.status'),
                cell: (p) => (
                  <Badge tone={p.status === 'approved' ? 'green' : p.status === 'submitted' ? 'terracotta' : 'beige'}>
                    {t(`status.${p.status}`)}
                  </Badge>
                ),
              },
            ]}
          />
        </Card>
      </QueryState>
    </>
  );
}
