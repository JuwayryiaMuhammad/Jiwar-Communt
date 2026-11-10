'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardHeader, DataTable, ForbiddenState, PageHeader, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { codeText } from '@/components/governance/logic';
import { boardWorkFetchers, boardWorkKeys, type ManagerHandover } from '@/lib/board-work';
import { download } from '@/lib/download';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/gov-board-reports';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-reports';
import codesEn from '@/messages/en/gov-codes';

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
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board') || can('governance.manage');
  const pack = useQuery({ queryKey: boardWorkKeys.pack, queryFn: boardWorkFetchers.pack, enabled: allowed, retry: false });
  const handovers = useCursorList(boardWorkKeys.handovers, (c) => boardWorkFetchers.handovers(c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('handoverTitle')} />
        <ForbiddenState />
      </>
    );
  const c = (pack.data?.contents ?? {}) as Pack;
  const lines = [
    ...(c.approvals?.pending ?? []).map((r) => t('pack.pending', { reference: r.reference, type: codeText(g, 'approvalType', r.type) })),
    ...(c.approvals?.awaitingImplementation ?? []).map((r) =>
      t('pack.toImplement', { reference: r.reference, type: codeText(g, 'approvalType', r.type) }),
    ),
    ...(c.appeals?.pending ?? []).map((a) => t('pack.appeal', { reference: a.reference, kind: codeText(g, 'appealKind', a.kind) })),
    ...(c.openActions ?? []).map((a) => t('pack.action', { meeting: a.meetingReference, title: a.title, day: f.day(a.dueOn) })),
    ...(c.sections?.contracts?.ending ?? []).map((x) => t('pack.contract', { code: x.code, kind: label(x.kind), day: f.day(x.endsOn) })),
  ];
  return (
    <>
      <PageHeader
        title={t('handoverTitle')}
        description={t('handoverDescription')}
        actions={
          pack.data ? (
            <Button
              onClick={() => download('/api/v1/board/handover-pack/pdf', {}, 'handover-pack.pdf').catch(() => toast.show(t('pdfFailed')))}
            >
              {t('packPdf')}
            </Button>
          ) : undefined
        }
      />
      <Card>
        <CardHeader title={t('packTitle')} />
        {pack.isError ? (
          <p className="t-secondary">{t('noPack')}</p>
        ) : pack.data ? (
          <>
            <p className="t-secondary">
              {t('packWritten', {
                when: f.dateTime(pack.data.generatedAt),
                objections: c.objectionsUnanswered ?? 0,
                proposals: c.agendaProposalsOpen ?? 0,
              })}
            </p>
            {lines.length ? (
              <ul>
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <p>{t('nothingOpen')}</p>
            )}
          </>
        ) : null}
      </Card>
      <Card flush>
        <CardHeader title={t('managersTitle')} />
        <QueryState query={handovers}>
          <DataTable<ManagerHandover>
            rows={handovers.rows}
            rowKey={(h) => h.id}
            empty={t('noneDelivered')}
            columns={[
              { key: 'n', header: t('col.manager'), cell: (h) => h.fullName ?? '—' },
              { key: 'd', header: t('col.delivered'), cell: (h) => (h.deliveredAt ? f.dateTime(h.deliveredAt) : '—') },
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
