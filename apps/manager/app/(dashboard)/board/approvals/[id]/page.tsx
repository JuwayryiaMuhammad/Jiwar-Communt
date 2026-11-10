'use client';

import { QueryState } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { ForbiddenState, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Back } from '@/components/community/bits';
import { ApprovalPackage, Motions, SubjectCard } from '@/components/governance/board-ui';
import { codeText } from '@/components/governance/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-inbox';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-inbox';
import codesEn from '@/messages/en/gov-codes';

/** One request as the board decides it (ADR 0055): the package, its subject, the motions and votes. */
export default function BoardApprovalPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const q = useQuery({ queryKey: keys.boardApproval(id), queryFn: () => fetchers.boardApproval(id), enabled: allowed });
  const back = <Back href="/board/approvals" label={t('inboxTitle')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('request')} />
        <ForbiddenState />
      </>
    );
  const a = q.data;
  return (
    <>
      <PageHeader back={back} title={a ? `${a.reference} · ${codeText(g, 'approvalType', a.type)}` : t('request')} />
      <QueryState query={q}>
        {a ? (
          <div className="stack">
            <ApprovalPackage a={a} />
            <SubjectCard title={t('about')} subject={a.subject} />
            <Motions matter="approval" matterId={a.id} pending={a.status === 'pending'} motions={a.motions} />
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
