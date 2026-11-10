'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Card, ForbiddenState, PageHeader, StatusBadge, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Back } from '@/components/community/bits';
import { Attachments, Motions, SubjectCard } from '@/components/governance/board-ui';
import { codeText } from '@/components/governance/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-inbox';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-inbox';
import codesEn from '@/messages/en/gov-codes';

/** One appeal as the board decides it (ADR 0055): the grounds, the decision appealed, the motions. */
export default function BoardAppealPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const q = useQuery({ queryKey: keys.boardAppeal(id), queryFn: () => fetchers.boardAppeal(id), enabled: allowed });
  const back = <Back href="/board/appeals" label={t('appealsTitle')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('appeal')} />
        <ForbiddenState />
      </>
    );
  const a = q.data;
  return (
    <>
      <PageHeader
        back={back}
        title={a ? t('appealTitle', { reference: a.reference, kind: codeText(g, 'appealKind', a.kind), unit: a.unitCode }) : t('appeal')}
      />
      <QueryState query={q}>
        {a ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={a.status} /> {codeText(g, 'appealStatus', a.status)}
                  {a.overdue ? ` · ${t('pastDeadline')}` : ''}
                </dd>
                <dt>{t('lodged')}</dt>
                <dd>{fmt.dateTime(a.lodgedAt)}</dd>
                <dt>{t('deadline')}</dt>
                <dd>{fmt.dateTime(a.deadlineAt)}</dd>
                <dt>{t('grounds')}</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{a.grounds ?? t('groundsErased')}</dd>
                <dt>{t('attachments')}</dt>
                <dd>
                  <Attachments items={a.attachments} />
                </dd>
                {a.decision ? (
                  <>
                    <dt>{t('decided')}</dt>
                    <dd>
                      {fmt.dateTime(a.decision.decidedAt)} · {codeText(g, 'appealStatus', a.decision.outcome)}
                    </dd>
                    <dt>{t('rationale')}</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.rationale}</dd>
                  </>
                ) : null}
                {a.effect ? (
                  <>
                    <dt>{t('effect')}</dt>
                    <dd>
                      {codeText(g, 'effect', a.effect)}
                      {a.followedUpAt ? ` · ${t('followedUp', { when: fmt.dateTime(a.followedUpAt) })}` : ''}
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <SubjectCard title={t('appealed')} subject={a.subject} />
            <Motions matter="appeal" matterId={a.id} pending={a.status === 'pending'} motions={a.motions} />
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
