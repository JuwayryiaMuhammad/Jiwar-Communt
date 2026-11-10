'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { codeText } from '@/components/governance/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardAppealStatus, type StaffBoardAppeal } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-appeals';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-appeals';
import codesEn from '@/messages/en/gov-codes';

const VIEWS = ['pending', 'upheld', 'overturned', 'withdrawn'] as const satisfies readonly BoardAppealStatus[];

/**
 * Appeals to the board (ADR 0055), as the management, a party to them,
 * sees them: where each stands and the board's reasons; never the grounds
 * or the deliberation.
 */
export default function StaffBoardAppealsPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const [status, setStatus] = useState<BoardAppealStatus>('pending');
  const list = useCursorList(keys.staffBoardAppeals(status), (cursor) => fetchers.staffBoardAppeals(status, cursor), { enabled: allowed });
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
        <Segmented<BoardAppealStatus>
          label={c('status')}
          value={status}
          onChange={setStatus}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffBoardAppeal>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={t('nothing')}
            columns={[
              { key: 'r', header: t('col.appeal'), cell: (a) => <Link href={`/governance/board-appeals/${a.id}`}>{a.reference}</Link> },
              { key: 'k', header: t('col.of'), cell: (a) => codeText(g, 'appealKind', a.kind) },
              // A complaint about the management never names its unit to the staff (ADR 0059).
              { key: 'u', header: t('col.unit'), cell: (a) => (a.unitCode ? <span className="t-mono ltr">{a.unitCode}</span> : '—') },
              {
                key: 'd',
                header: t('col.deadline'),
                cell: (a) => (a.overdue ? t('deadlineOverdue', { when: f.dateTime(a.deadlineAt) }) : f.dateTime(a.deadlineAt)),
              },
              { key: 's', header: c('status'), cell: (a) => <StatusBadge status={a.status} /> },
              {
                key: 'e',
                header: t('col.effect'),
                cell: (a) =>
                  a.effect === 'follow_up' && !a.followedUpAt ? (
                    <strong>{codeText(g, 'effect', 'follow_up')}</strong>
                  ) : a.effect ? (
                    codeText(g, 'effect', a.effect)
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
