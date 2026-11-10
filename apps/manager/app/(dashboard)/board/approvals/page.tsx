'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { approvalStatus } from '@/components/governance/board-ui';
import { codeText } from '@/components/governance/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Approval, type ApprovalFilter } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-inbox';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-inbox';
import codesEn from '@/messages/en/gov-codes';

const VIEWS = ['pending', 'approved', 'implemented', 'rejected', 'withdrawn'] as const satisfies readonly ApprovalFilter[];

/** The board's inbox (ADR 0055): what awaits it, what awaits the management, and the history. */
export default function BoardInboxPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [status, setStatus] = useState<ApprovalFilter>('pending');
  const list = useCursorList(keys.boardInbox(status), (cursor) => fetchers.boardInbox(status, cursor), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('inboxTitle')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('inboxTitle')} description={t('inboxDescription')} />
      <div className="toolbar">
        <Segmented<ApprovalFilter>
          label={c('status')}
          value={status}
          onChange={setStatus}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Approval>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={t('nothing')}
            columns={[
              { key: 'r', header: t('col.request'), cell: (a) => <Link href={`/board/approvals/${a.id}`}>{a.reference}</Link> },
              { key: 't', header: c('type'), cell: (a) => codeText(g, 'approvalType', a.type) },
              { key: 'c', header: t('col.cost'), cell: (a) => (a.cost ? fmt.money(a.cost) : '—') },
              {
                key: 'd',
                header: t('col.deadline'),
                cell: (a) => (a.overdue ? t('deadlineOverdue', { when: fmt.dateTime(a.deadlineAt) }) : fmt.dateTime(a.deadlineAt)),
              },
              { key: 's', header: c('status'), cell: (a) => <StatusBadge status={approvalStatus(a)} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
