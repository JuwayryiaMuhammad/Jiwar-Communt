'use client';

import { formatDateTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, ForbiddenState, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { boardWorkFetchers, boardWorkKeys, type ManagerHandover } from '@/lib/board-work';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';

type Pack = {
  approvals?: { pending?: { reference: string; type: string }[]; awaitingImplementation?: { reference: string; type: string }[] };
  appeals?: { pending?: { reference: string; kind: string }[] };
  openActions?: { meetingReference: string; title: string; dueOn: string }[];
  objectionsUnanswered?: number;
  agendaProposalsOpen?: number;
  sections?: { contracts?: { ending: { code: string; kind: string; endsOn: string }[] } };
};

/**
 * Handovers (ADR 0075): the pack the sitting board received when it started
 * to sit — what the board before left open — and the handovers managers
 * delivered when they left. References and days; never a name in the pack.
 */
export default function BoardHandoverPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board') || can('governance.manage');
  const pack = useQuery({ queryKey: boardWorkKeys.pack, queryFn: boardWorkFetchers.pack, enabled: allowed, retry: false });
  const handovers = useCursorList(boardWorkKeys.handovers, (c) => boardWorkFetchers.handovers(c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Handovers" />
        <ForbiddenState />
      </>
    );
  const c = (pack.data?.contents ?? {}) as Pack;
  const lines = [
    ...(c.approvals?.pending ?? []).map((r) => `${r.reference} · ${r.type} · awaiting the board`),
    ...(c.approvals?.awaitingImplementation ?? []).map((r) => `${r.reference} · ${r.type} · approved, to implement`),
    ...(c.appeals?.pending ?? []).map((a) => `${a.reference} · ${a.kind} · appeal awaiting the board`),
    ...(c.openActions ?? []).map((a) => `${a.meetingReference} · ${a.title} · due ${a.dueOn}`),
    ...(c.sections?.contracts?.ending ?? []).map((x) => `${x.code} · ${x.kind} · contract ends ${x.endsOn}`),
  ];
  return (
    <>
      <PageHeader
        title="Handovers"
        description="What the board before left open when this board started to sit, and the managers’ handovers."
        actions={
          pack.data ? (
            <Button
              onClick={() =>
                download('/api/v1/board/handover-pack/pdf', {}, 'handover-pack.pdf').catch(() => toast.show('The PDF could not be downloaded.'))
              }
            >
              Pack as PDF
            </Button>
          ) : undefined
        }
      />
      <Card>
        <CardHeader title="The board’s handover pack" />
        {pack.isError ? (
          <p className="t-secondary">No pack for this board: it started to sit before packs were written, or none sits.</p>
        ) : pack.data ? (
          <>
            <p className="t-secondary">
              Written {formatDateTime(pack.data.generatedAt)} · objections unanswered: {c.objectionsUnanswered ?? 0} · open
              proposals: {c.agendaProposalsOpen ?? 0}
            </p>
            {lines.length ? (
              <ul>
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <p>Nothing was left open.</p>
            )}
          </>
        ) : null}
      </Card>
      <Card flush>
        <CardHeader title="Managers’ handovers" />
        <QueryState query={handovers}>
          <DataTable<ManagerHandover>
            rows={handovers.rows}
            rowKey={(h) => h.id}
            empty="None delivered"
            columns={[
              { key: 'n', header: 'Manager', cell: (h) => h.fullName ?? '—' },
              { key: 'd', header: 'Delivered', cell: (h) => (h.deliveredAt ? formatDateTime(h.deliveredAt) : '—') },
              {
                key: 'p',
                header: '',
                cell: (h) => (
                  <Button size="sm" onClick={() => download(`/api/v1/board/manager-handovers/${h.id}/pdf`, {}, 'manager-handover.pdf')}>
                    PDF
                  </Button>
                ),
              },
            ]}
          />
          <LoadMore query={handovers} />
        </QueryState>
      </Card>
    </>
  );
}
