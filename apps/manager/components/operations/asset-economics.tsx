'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, CardBody, CardHeader, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/shell-operations';
import en from '@/messages/en/shell-operations';

/** What an asset cost and the rule's advice (ADR 0065): for who keeps the register. */
export function AssetEconomicsPanel({ id }: { id: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { can } = usePermissions();
  const e = useQuery({ queryKey: keys.assetEconomics(id), queryFn: () => fetchers.assetEconomics(id), enabled: can('assets.manage') });
  if (!can('assets.manage')) return null;
  const row = (name: string, value: string | null) => (
    <>
      <dt>{name}</dt>
      <dd>{value === null || value === '' ? '—' : value}</dd>
    </>
  );
  const d = e.data;
  return (
    <Card flush>
      <CardHeader title={t('economics')} />
      <CardBody>
        <QueryState query={e}>
          {d ? (
            <dl className="dl">
              {row(
                t('advice'),
                d.reasons.length
                  ? t('adviceWith', { advice: label(d.advice), reasons: fmt.list(d.reasons.map((r) => label(r).toLowerCase())) })
                  : label(d.advice),
              )}
              {row(
                t('spent'),
                t('spentSplit', {
                  total: fmt.money(d.cumulative.total),
                  corrective: fmt.money(d.cumulative.corrective),
                  planned: fmt.money(d.cumulative.planned),
                }),
              )}
              {row(t('lastYear'), fmt.money(d.lastYear))}
              {row(t('failures'), fmt.number(d.failures))}
              {row(t('mtbf'), d.mtbfDays === null ? null : fmt.number(d.mtbfDays))}
              {row(
                t('downtime'),
                d.downtimeCost
                  ? t('downtimeWithCost', { n: d.downtimeDays, cost: fmt.money(d.downtimeCost) })
                  : t('downtimeDays', { n: d.downtimeDays }),
              )}
              {row(t('replacementDue'), d.replacementYear === null ? null : String(d.replacementYear))}
              {row(t('reserve'), d.reserve ? t('reserveText', { annual: fmt.money(d.reserve.annual), accrued: fmt.money(d.reserve.accrued) }) : null)}
            </dl>
          ) : null}
        </QueryState>
      </CardBody>
    </Card>
  );
}

/** The contracts covering an asset now (ADR 0065): who to call. */
export function AssetContractsPanel({ id }: { id: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { can } = usePermissions();
  const list = useQuery({
    queryKey: [...keys.contractsAll, 'asset', id],
    queryFn: () => fetchers.contracts({ assetId: id, status: 'active' }),
    enabled: can('assets.manage'),
  });
  if (!can('assets.manage') || !list.data?.data.length) return null;
  return (
    <Card flush>
      <CardHeader title={t('underContract')} />
      <CardBody>
        {list.data.data.map((c) => (
          <p key={c.id}>
            <Link className="table__link" href={`/contracts/${c.id}`}>
              <bdi>{c.code}</bdi>
            </Link>{' '}
            · {c.vendorName}
            {c.vendorPhone ? (
              <>
                {' '}
                · <bdi>{c.vendorPhone}</bdi>
              </>
            ) : null}{' '}
            · {t('until', { day: fmt.day(c.endsOn) })}
          </p>
        ))}
      </CardBody>
    </Card>
  );
}
