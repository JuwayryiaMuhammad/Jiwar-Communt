'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, ForbiddenState, PageHeader, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Back } from '@/components/community/bits';
import { Motions } from '@/components/governance/board-ui';
import {
  matterOutcomeText,
  REPRESENTATIVE_ACTION_TEXT,
  REPRESENTATIVE_MATTER_STATUS_TEXT,
} from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/**
 * A matter about a building's representative (ADR 0059) as the board
 * decides it: whom it names, the motions and votes (whom it names is
 * recused), and what the decision did. Its raiser withdraws it while it waits.
 */
export default function BoardRepresentativeMatterPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const q = useQuery({
    queryKey: keys.boardRepresentativeMatter(id),
    queryFn: () => fetchers.boardRepresentativeMatter(id),
    enabled: allowed,
  });
  const withdraw = useAction(
    () => unwrap(api.POST('/api/v1/board/representatives/matters/{id}/withdraw', { params: { path: { id } } })),
    { invalidate: [keys.governanceAll], onDone: () => toast.show('Withdrawn. Its open motion closed with it.') },
  );
  const back = <Back href="/board/representatives" label="Representatives" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Matter" />
        <ForbiddenState />
      </>
    );
  const m = q.data;
  const pending = m?.status === 'pending';
  return (
    <>
      <PageHeader
        back={back}
        title={m ? `${REPRESENTATIVE_ACTION_TEXT[m.action]} · building ${m.building}` : 'Matter'}
        actions={
          m && pending && m.raisedByMe ? (
            <Button loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
              Withdraw
            </Button>
          ) : null
        }
      />
      <QueryState query={q}>
        {m ? (
          <div className="stack">
            <ErrorAlert error={withdraw.error} />
            <Card>
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={m.status} /> {REPRESENTATIVE_MATTER_STATUS_TEXT[m.status]}
                </dd>
                <dt>{m.action === 'appoint' ? 'Owner named' : 'Representative'}</dt>
                <dd>
                  {m.fullName ?? 'An erased account'}
                  {m.unitCode ? ` · unit ${m.unitCode}` : m.action === 'appoint' ? ' · owns no unit in the building now' : ''}
                </dd>
                <dt>Raised</dt>
                <dd>
                  {formatDateTime(m.raisedAt)}
                  {m.raisedByMe ? ' · by you' : ''}
                </dd>
                <dt>Board’s deadline</dt>
                <dd>{formatDateTime(m.deadlineAt)}</dd>
                {m.decision ? (
                  <>
                    <dt>Decided</dt>
                    <dd>
                      {formatDateTime(m.decision.decidedAt)} · {matterOutcomeText(m.decision)}
                    </dd>
                    <dt>Rationale</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>{m.decision.rationale}</dd>
                  </>
                ) : null}
                {m.withdrawnAt ? (
                  <>
                    <dt>Withdrawn</dt>
                    <dd>{formatDateTime(m.withdrawnAt)}</dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <Motions matter="representative" matterId={m.id} pending={pending} motions={m.motions} />
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
