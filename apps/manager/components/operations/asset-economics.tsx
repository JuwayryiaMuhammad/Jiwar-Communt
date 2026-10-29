'use client';

import { humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Card, CardBody, CardHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/** What an asset cost and the rule's advice (ADR 0065): for who keeps the register. */
export function AssetEconomicsPanel({ id }: { id: string }) {
  const { can } = usePermissions();
  const e = useQuery({ queryKey: keys.assetEconomics(id), queryFn: () => fetchers.assetEconomics(id), enabled: can('assets.manage') });
  if (!can('assets.manage')) return null;
  const row = (label: string, value: string | number | null) => (
    <>
      <dt>{label}</dt>
      <dd>{value === null || value === '' ? '—' : value}</dd>
    </>
  );
  return (
    <Card flush>
      <CardHeader title="Economics" />
      <CardBody>
        <QueryState query={e}>
          {e.data ? (
            <dl className="dl">
              {row('Advice', `${humanize(e.data.advice)}${e.data.reasons.length ? ` — ${e.data.reasons.map((r) => humanize(r).toLowerCase()).join('; ')}` : ''}`)}
              {row('Spent, ever', `${e.data.cumulative.total} EGP (corrective ${e.data.cumulative.corrective}, planned ${e.data.cumulative.planned})`)}
              {row('Last twelve months', `${e.data.lastYear} EGP`)}
              {row('Failures', e.data.failures)}
              {row('Mean days between failures', e.data.mtbfDays)}
              {row('Downtime', `${e.data.downtimeDays} days${e.data.downtimeCost ? ` · ${e.data.downtimeCost} EGP` : ''}`)}
              {row('Replacement due', e.data.replacementYear)}
              {row('Reserve', e.data.reserve ? `${e.data.reserve.annual} EGP a year · ${e.data.reserve.accrued} EGP built up` : null)}
            </dl>
          ) : null}
        </QueryState>
      </CardBody>
    </Card>
  );
}

/** The contracts covering an asset now (ADR 0065): who to call. */
export function AssetContractsPanel({ id }: { id: string }) {
  const { can } = usePermissions();
  const list = useQuery({
    queryKey: [...keys.contractsAll, 'asset', id],
    queryFn: () => fetchers.contracts({ assetId: id, status: 'active' }),
    enabled: can('assets.manage'),
  });
  if (!can('assets.manage') || !list.data?.data.length) return null;
  return (
    <Card flush>
      <CardHeader title="Under contract" />
      <CardBody>
        {list.data.data.map((c) => (
          <p key={c.id}>
            <Link className="table__link" href={`/contracts/${c.id}`}>
              {c.code}
            </Link>{' '}
            · {c.vendorName}
            {c.vendorPhone ? ` · ${c.vendorPhone}` : ''} · until {c.endsOn}
          </p>
        ))}
      </CardBody>
    </Card>
  );
}
