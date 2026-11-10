'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { codeText } from '@/components/governance/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardAppealStatus, type StaffBoardAppeal } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-inbox';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-inbox';
import codesEn from '@/messages/en/gov-codes';

const VIEWS = ['pending', 'upheld', 'overturned', 'withdrawn'] as const satisfies readonly BoardAppealStatus[];

/** Appeals to the board (ADR 0055): staff decisions a unit asked the board to review. */
export default function BoardAppealsPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [status, setStatus] = useState<BoardAppealStatus>('pending');
  const list = useCursorList(keys.boardAppeals(status), (cursor) => fetchers.boardAppeals(status, cursor), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('appealsTitle')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('appealsTitle')} description={t('appealsDescription')} />
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
              { key: 'r', header: t('col.appeal'), cell: (a) => <Link href={`/board/appeals/${a.id}`}>{a.reference}</Link> },
              { key: 'k', header: t('col.of'), cell: (a) => codeText(g, 'appealKind', a.kind) },
              { key: 'u', header: c('unit'), cell: (a) => <span className="t-mono">{a.unitCode}</span> },
              { key: 'l', header: t('col.lodged'), cell: (a) => fmt.dateTime(a.lodgedAt) },
              {
                key: 'd',
                header: t('col.deadline'),
                cell: (a) => (a.overdue ? t('deadlineOverdue', { when: fmt.dateTime(a.deadlineAt) }) : fmt.dateTime(a.deadlineAt)),
              },
              { key: 's', header: c('status'), cell: (a) => <StatusBadge status={a.status} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
