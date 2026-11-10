'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { effectText, kindText } from '@/components/appeals/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type DecisionAppeal, type DecisionAppealStatus } from '@/lib/queries';
import ar from '@/messages/ar/money-appeals';
import en from '@/messages/en/money-appeals';

const VIEWS = ['pending', 'overturned', 'upheld', 'withdrawn'] as const;

/**
 * Decision appeals (ADR 0059): residents' appeals of a staff decision about
 * their unit, decided by a manager who did not take it.
 */
export default function DecisionAppealsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('appeals.decide');
  const [status, setStatus] = useState<DecisionAppealStatus | ''>('pending');
  const list = useCursorList(keys.decisionAppeals(status), (cursor) => fetchers.decisionAppeals(status, cursor), { enabled: allowed });
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
        <Segmented<DecisionAppealStatus | ''>
          label={t('shown')}
          value={status}
          onChange={setStatus}
          options={[...VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) })), { value: '' as const, label: c('all') }]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<DecisionAppeal>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={status === 'pending' ? t('emptyPending') : t('empty')}
            columns={[
              {
                key: 'r',
                header: t('col.appeal'),
                cell: (a) => (
                  <Link className="table__link" href={`/appeals/${a.id}`}>
                    {a.reference}
                  </Link>
                ),
              },
              { key: 'k', header: t('col.of'), cell: (a) => kindText(t, a.kind) },
              { key: 'u', header: t('col.unit'), cell: (a) => <span className="t-mono">{a.unitCode}</span> },
              {
                key: 'l',
                header: t('col.lodged'),
                cell: (a) => <span title={fmt.dateTime(a.lodgedAt)}>{fmt.relative(a.lodgedAt)}</span>,
              },
              { key: 's', header: t('col.status'), cell: (a) => <StatusBadge status={a.status} /> },
              {
                key: 'e',
                header: t('col.effect'),
                cell: (a) =>
                  a.decision?.effect === 'follow_up' && !a.decision.followedUpAt ? (
                    <strong>{effectText(t, 'follow_up')}</strong>
                  ) : a.decision ? (
                    effectText(t, a.decision.effect)
                  ) : a.ownDecision ? (
                    t('ownDecision')
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
