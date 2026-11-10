'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, ForbiddenState, PageHeader, StatusBadge, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Back } from '@/components/community/bits';
import { codeText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-appeals';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-appeals';
import codesEn from '@/messages/en/gov-codes';

/** One appeal to the board, the management's side (ADR 0055): the outcome, its reasons, the follow-up. */
export default function StaffBoardAppealPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const q = useQuery({ queryKey: keys.staffBoardAppeal(id), queryFn: () => fetchers.staffBoardAppeal(id), enabled: allowed });
  const followed = useAction(
    () => unwrap(api.POST('/api/v1/staff/governance/board-appeals/{id}/followed-up', { params: { path: { id } } })),
    { invalidate: [keys.governanceAll], onDone: () => toast.show(t('followedToast')) },
  );
  const back = <Back href="/governance/board-appeals" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('appealTitle')} />
        <ForbiddenState />
      </>
    );
  const a = q.data;
  const toFollow = a?.effect === 'follow_up' && !a.followedUpAt;
  return (
    <>
      <PageHeader
        back={back}
        title={
          a
            ? a.unitCode
              ? t('headingUnit', { reference: a.reference, kind: codeText(g, 'appealKind', a.kind), unit: a.unitCode })
              : `${a.reference} · ${codeText(g, 'appealKind', a.kind)}`
            : t('appealTitle')
        }
        actions={
          toFollow ? (
            <Button variant="primary" loading={followed.isPending} onClick={() => followed.mutate(undefined)}>
              {t('markFollowed')}
            </Button>
          ) : null
        }
      />
      <QueryState query={q}>
        {a ? (
          <Card>
            <dl className="dl">
              <dt>{c('status')}</dt>
              <dd>
                <StatusBadge status={a.status} /> {codeText(g, 'appealStatus', a.status)}
                {a.overdue ? ` · ${t('pastDeadline')}` : ''}
              </dd>
              <dt>{t('lodged')}</dt>
              <dd>{f.dateTime(a.lodgedAt)}</dd>
              <dt>{t('deadline')}</dt>
              <dd>{f.dateTime(a.deadlineAt)}</dd>
              {a.withdrawnAt ? (
                <>
                  <dt>{t('withdrawn')}</dt>
                  <dd>{f.dateTime(a.withdrawnAt)}</dd>
                </>
              ) : null}
              {a.decision ? (
                <>
                  <dt>{t('decided')}</dt>
                  <dd>
                    {f.dateTime(a.decision.decidedAt)} · {codeText(g, 'appealStatus', a.decision.outcome)}
                  </dd>
                  <dt>{t('reasons')}</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.rationale}</dd>
                </>
              ) : null}
              {a.effect ? (
                <>
                  <dt>{t('effect')}</dt>
                  <dd>
                    {codeText(g, 'effect', a.effect)}
                    {a.followedUpAt ? ` · ${t('followedUp', { when: f.dateTime(a.followedUpAt) })}` : ''}
                  </dd>
                </>
              ) : null}
              {a.kind === 'management_appeal' && can('appeals.decide') ? (
                <>
                  <dt>{t('managementDecision')}</dt>
                  <dd>
                    <Link href={`/appeals/${a.subjectId}`}>{t('openAppeal')}</Link>
                    {toFollow ? ` ${t('openAppealFollow')}` : ''}
                  </dd>
                </>
              ) : null}
              {a.kind === 'management_complaint' ? (
                <>
                  <dt>{t('complaint')}</dt>
                  <dd>
                    {t('complaintOwn')}
                    {toFollow ? ` ${t('complaintFollow')}` : ''}
                  </dd>
                </>
              ) : null}
              {a.kind === 'invoice_dispute' && can('finance.invoice') ? (
                <>
                  <dt>{t('dispute')}</dt>
                  <dd>
                    <Link href={`/finance/disputes?open=${a.subjectId}`}>{t('openDispute')}</Link>
                    {toFollow ? ` ${t('openDisputeFollow')}` : ''}
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
