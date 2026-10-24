'use client';

import { formatDate, formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, ForbiddenState, PageHeader } from '@jiwar/ui';
import Link from 'next/link';
import { objectionState } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardPublication } from '@/lib/queries';
import { useNow } from '@/lib/use-now';

const STATE_TEXT: Record<string, string> = {
  open: 'Taking objections',
  closed: 'Its days have passed',
  answered: 'Answered',
};

/**
 * The board's decisions and the owners' objections to them (ADR 0059), a
 * sitting member's page: each decision, until when it takes objections and
 * whether the board answered. The objections themselves are on its page.
 */
export default function BoardObjectionsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const now = useNow(60_000);
  const list = useCursorList(keys.ownersPublications, (c) => fetchers.ownersPublications(c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Objections" />
        <ForbiddenState />
      </>
    );
  // Minutes and archived decisions take none.
  const decisions = (list.rows ?? []).filter((p) => p.objections !== null);
  return (
    <>
      <PageHeader
        title="Objections"
        description="Owners may object to a decision of the board within the compound’s objection days. The board answers once, with its reasons, to every objector; then the decision takes no more."
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<BoardPublication>
            rows={decisions}
            rowKey={(p) => p.id}
            empty="No decision takes objections"
            columns={[
              {
                key: 't',
                header: 'Decision',
                cell: (p) => <Link href={`/board/objections/${p.id}`}>{p.titleEn ?? p.titleAr ?? 'A decision'}</Link>,
              },
              { key: 'd', header: 'Decided on', cell: (p) => formatDate(p.decidedOn) },
              { key: 'u', header: 'Objections until', cell: (p) => (p.objections ? formatDateTime(p.objections.until) : '—') },
              {
                key: 's',
                header: 'State',
                cell: (p) => {
                  const state = objectionState(p.objections, new Date(now));
                  return state ? STATE_TEXT[state] : '—';
                },
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
