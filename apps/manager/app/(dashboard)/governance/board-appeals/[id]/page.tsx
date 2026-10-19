'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, ForbiddenState, PageHeader, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Back } from '@/components/community/bits';
import { APPEAL_KIND_TEXT, APPEAL_STATUS_TEXT, EFFECT_TEXT } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/** One appeal to the board, the management's side (ADR 0055): the outcome, its reasons, the follow-up. */
export default function StaffBoardAppealPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const q = useQuery({ queryKey: keys.staffBoardAppeal(id), queryFn: () => fetchers.staffBoardAppeal(id), enabled: allowed });
  const followed = useAction(
    () => unwrap(api.POST('/api/v1/staff/governance/board-appeals/{id}/followed-up', { params: { path: { id } } })),
    { invalidate: [keys.governanceAll], onDone: () => toast.show('Marked followed up.') },
  );
  const back = <Back href="/governance/board-appeals" label="Appeals to the board" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Appeal" />
        <ForbiddenState />
      </>
    );
  const a = q.data;
  const toFollow = a?.effect === 'follow_up' && !a.followedUpAt;
  return (
    <>
      <PageHeader
        back={back}
        title={a ? `${a.reference} · ${APPEAL_KIND_TEXT[a.kind]} · unit ${a.unitCode}` : 'Appeal'}
        actions={
          toFollow ? (
            <Button variant="primary" loading={followed.isPending} onClick={() => followed.mutate(undefined)}>
              Mark followed up
            </Button>
          ) : null
        }
      />
      <QueryState query={q}>
        {a ? (
          <Card>
            <dl className="dl">
              <dt>Status</dt>
              <dd>
                <StatusBadge status={a.status} /> {APPEAL_STATUS_TEXT[a.status]}
                {a.overdue ? ' · past its deadline' : ''}
              </dd>
              <dt>Lodged</dt>
              <dd>{formatDateTime(a.lodgedAt)}</dd>
              <dt>Board’s deadline</dt>
              <dd>{formatDateTime(a.deadlineAt)}</dd>
              {a.withdrawnAt ? (
                <>
                  <dt>Withdrawn</dt>
                  <dd>{formatDateTime(a.withdrawnAt)}</dd>
                </>
              ) : null}
              {a.decision ? (
                <>
                  <dt>Decided</dt>
                  <dd>
                    {formatDateTime(a.decision.decidedAt)} · {APPEAL_STATUS_TEXT[a.decision.outcome]}
                  </dd>
                  <dt>The board’s reasons</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.rationale}</dd>
                </>
              ) : null}
              {a.effect ? (
                <>
                  <dt>Effect</dt>
                  <dd>
                    {EFFECT_TEXT[a.effect]}
                    {a.followedUpAt ? ` · followed up ${formatDateTime(a.followedUpAt)}` : ''}
                  </dd>
                </>
              ) : null}
              {a.kind === 'invoice_dispute' && can('finance.invoice') ? (
                <>
                  <dt>The dispute</dt>
                  <dd>
                    <Link href={`/finance/disputes?open=${a.subjectId}`}>Open it in Disputes</Link>
                    {toFollow ? ' to credit the invoice, then mark this followed up.' : ''}
                  </dd>
                </>
              ) : null}
            </dl>
            <ErrorAlert error={followed.error} />
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
