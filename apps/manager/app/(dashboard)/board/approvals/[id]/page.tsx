'use client';

import { QueryState } from '@jiwar/api/react';
import { ForbiddenState, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Back } from '@/components/community/bits';
import { ApprovalPackage, Motions, SubjectCard } from '@/components/governance/board-ui';
import { APPROVAL_TYPE_TEXT } from '@/components/governance/matters';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/** One request as the board decides it (ADR 0055): the package, its subject, the motions and votes. */
export default function BoardApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const q = useQuery({ queryKey: keys.boardApproval(id), queryFn: () => fetchers.boardApproval(id), enabled: allowed });
  const back = <Back href="/board/approvals" label="The board’s inbox" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Request" />
        <ForbiddenState />
      </>
    );
  const a = q.data;
  return (
    <>
      <PageHeader back={back} title={a ? `${a.reference} · ${APPROVAL_TYPE_TEXT[a.type]}` : 'Request'} />
      <QueryState query={q}>
        {a ? (
          <div className="stack">
            <ApprovalPackage a={a} />
            <SubjectCard title="What it is about" subject={a.subject} />
            <Motions matter="approval" matterId={a.id} pending={a.status === 'pending'} motions={a.motions} />
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
