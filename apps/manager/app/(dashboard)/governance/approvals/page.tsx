'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { approvalStatus } from '@/components/governance/board-ui';
import { codeText } from '@/components/governance/logic';
import { RaiseApproval } from '@/components/governance/raise';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Approval, type ApprovalFilter } from '@/lib/queries';
import ar from '@/messages/ar/gov-approvals';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-approvals';
import codesEn from '@/messages/en/gov-codes';

const VIEWS = ['pending', 'approved', 'implemented', 'rejected', 'withdrawn'] as const satisfies readonly ApprovalFilter[];

/** Matters raised for the board (ADR 0055), as the management follows them: never a motion or a vote. */
export default function ApprovalsPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('governance.approvals');
  const [status, setStatus] = useState<ApprovalFilter>('pending');
  const [raising, setRaising] = useState(false);
  const list = useCursorList(keys.approvals(status), (cursor) => fetchers.approvals(status, cursor), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setRaising(true)}>
            {t('raise')}
          </Button>
        }
      />
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
              { key: 'r', header: t('col.request'), cell: (a) => <Link href={`/governance/approvals/${a.id}`}>{a.reference}</Link> },
              { key: 't', header: c('type'), cell: (a) => codeText(g, 'approvalType', a.type) },
              { key: 'c', header: t('col.cost'), cell: (a) => (a.cost ? f.money(a.cost) : '—') },
              {
                key: 'm',
                header: t('col.raised'),
                cell: (a) => (a.raisedByMe ? t('raisedByYou', { when: f.dateTime(a.raisedAt) }) : f.dateTime(a.raisedAt)),
              },
              {
                key: 'd',
                header: t('col.deadline'),
                cell: (a) => (a.overdue ? t('deadlineOverdue', { when: f.dateTime(a.deadlineAt) }) : f.dateTime(a.deadlineAt)),
              },
              { key: 's', header: c('status'), cell: (a) => <StatusBadge status={approvalStatus(a)} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {raising ? <RaiseApproval onClose={() => setRaising(false)} /> : null}
    </>
  );
}
