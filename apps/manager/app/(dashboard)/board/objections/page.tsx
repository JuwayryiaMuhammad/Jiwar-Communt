'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, DataTable, ForbiddenState, PageHeader } from '@jiwar/ui';
import Link from 'next/link';
import { inLocale } from '@/components/governance/logic';
import { objectionState } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardPublication } from '@/lib/queries';
import { useNow } from '@/lib/use-now';
import ar from '@/messages/ar/gov-board-objections';
import en from '@/messages/en/gov-board-objections';

/**
 * The board's decisions and the owners' objections to them (ADR 0059), a
 * sitting member's page: each decision, until when it takes objections and
 * whether the board answered. The objections themselves are on its page.
 */
export default function BoardObjectionsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const now = useNow(60_000);
  const list = useCursorList(keys.ownersPublications, (c) => fetchers.ownersPublications(c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  // Minutes and archived decisions take none.
  const decisions = (list.rows ?? []).filter((p) => p.objections !== null);
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<BoardPublication>
            rows={decisions}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              {
                key: 't',
                header: t('col.decision'),
                cell: (p) => (
                  <Link href={`/board/objections/${p.id}`}>
                    {p.titleEn || p.titleAr ? inLocale(fmt.locale, p.titleEn, p.titleAr) : t('aDecision')}
                  </Link>
                ),
              },
              { key: 'd', header: t('col.decidedOn'), cell: (p) => fmt.day(p.decidedOn) },
              { key: 'u', header: t('col.until'), cell: (p) => (p.objections ? fmt.dateTime(p.objections.until) : '—') },
              {
                key: 's',
                header: t('col.state'),
                cell: (p) => {
                  const state = objectionState(p.objections, new Date(now));
                  return state ? t(`state.${state}`) : '—';
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
