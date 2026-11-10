'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AgendaProposal, type AgendaProposalStatus } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-agenda';
import en from '@/messages/en/gov-board-agenda';

const VIEWS = ['open', 'accepted', 'declined', 'withdrawn'] as const satisfies readonly AgendaProposalStatus[];

/**
 * The owners' proposals for the board's agenda (ADR 0059), a sitting
 * member's page: what waits for an answer, and the rest. Never who proposed.
 */
export default function BoardAgendaPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [status, setStatus] = useState<AgendaProposalStatus>('open');
  const list = useCursorList(keys.boardAgenda(status), (cursor) => fetchers.boardAgenda(status, cursor), { enabled: allowed });
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
        <Segmented<AgendaProposalStatus>
          label={c('status')}
          value={status}
          onChange={setStatus}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AgendaProposal>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('nothing')}
            columns={[
              {
                key: 't',
                header: t('col.proposal'),
                cell: (p) => <Link href={`/board/agenda/${p.id}`}>{p.title ?? t('titleErased')}</Link>,
              },
              { key: 'c', header: t('col.proposed'), cell: (p) => fmt.dateTime(p.createdAt) },
              { key: 's', header: c('status'), cell: (p) => <StatusBadge status={p.status} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
