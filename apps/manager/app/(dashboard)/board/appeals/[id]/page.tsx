'use client';

import { formatDateTime } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Card, ForbiddenState, PageHeader, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Back } from '@/components/community/bits';
import { Attachments, Motions, SubjectCard } from '@/components/governance/board-ui';
import { APPEAL_KIND_TEXT, APPEAL_STATUS_TEXT, EFFECT_TEXT } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/** One appeal as the board decides it (ADR 0055): the grounds, the decision appealed, the motions. */
export default function BoardAppealPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const q = useQuery({ queryKey: keys.boardAppeal(id), queryFn: () => fetchers.boardAppeal(id), enabled: allowed });
  const back = <Back href="/board/appeals" label="Appeals to the board" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Appeal" />
        <ForbiddenState />
      </>
    );
  const a = q.data;
  return (
    <>
      <PageHeader back={back} title={a ? `${a.reference} · ${APPEAL_KIND_TEXT[a.kind]} · unit ${a.unitCode}` : 'Appeal'} />
      <QueryState query={q}>
        {a ? (
          <div className="stack">
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
                <dt>Grounds</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{a.grounds ?? 'Removed: the appellant’s account was erased.'}</dd>
                <dt>Attachments</dt>
                <dd>
                  <Attachments items={a.attachments} />
                </dd>
                {a.decision ? (
                  <>
                    <dt>Decided</dt>
                    <dd>
                      {formatDateTime(a.decision.decidedAt)} · {APPEAL_STATUS_TEXT[a.decision.outcome]}
                    </dd>
                    <dt>Rationale</dt>
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
              </dl>
            </Card>
            <SubjectCard title="The decision appealed" subject={a.subject} />
            <Motions matter="appeal" matterId={a.id} pending={a.status === 'pending'} motions={a.motions} />
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
