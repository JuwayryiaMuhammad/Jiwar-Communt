'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, ForbiddenState, PageHeader, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Back } from '@/components/community/bits';
import { Motions } from '@/components/governance/board-ui';
import { codeText } from '@/components/governance/logic';
import { matterOutcomeText } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/gov-representatives';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-representatives';
import codesEn from '@/messages/en/gov-codes';

/**
 * A matter about a building's representative (ADR 0059) as the board
 * decides it: whom it names, the motions and votes (whom it names is
 * recused), and what the decision did. Its raiser withdraws it while it waits.
 */
export default function BoardRepresentativeMatterPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const f = useFormat();
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
    { invalidate: [keys.governanceAll], onDone: () => toast.show(t('withdrawn')) },
  );
  const back = <Back href="/board/representatives" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('matterTitle')} />
        <ForbiddenState />
      </>
    );
  const m = q.data;
  const pending = m?.status === 'pending';
  const name = m?.fullName ?? t('erased');
  return (
    <>
      <PageHeader
        back={back}
        title={m ? t('matterHeading', { action: codeText(g, 'repAction', m.action), building: m.building }) : t('matterTitle')}
        actions={
          m && pending && m.raisedByMe ? (
            <Button loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
              {t('withdraw')}
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
                <dt>{t('status')}</dt>
                <dd>
                  <StatusBadge status={m.status} /> {codeText(g, 'repStatus', m.status)}
                </dd>
                <dt>{m.action === 'appoint' ? t('ownerNamed') : t('representative')}</dt>
                <dd>
                  {m.unitCode
                    ? t('ownerWithUnit', { name, unit: m.unitCode })
                    : m.action === 'appoint'
                      ? t('ownerNoUnit', { name })
                      : name}
                </dd>
                <dt>{t('raised')}</dt>
                <dd>{m.raisedByMe ? t('raisedByYou', { when: f.dateTime(m.raisedAt) }) : f.dateTime(m.raisedAt)}</dd>
                <dt>{t('deadline')}</dt>
                <dd>{f.dateTime(m.deadlineAt)}</dd>
                {m.decision ? (
                  <>
                    <dt>{t('decided')}</dt>
                    <dd>
                      {f.dateTime(m.decision.decidedAt)} · {matterOutcomeText(g, m.decision)}
                    </dd>
                    <dt>{t('rationale')}</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>{m.decision.rationale}</dd>
                  </>
                ) : null}
                {m.withdrawnAt ? (
                  <>
                    <dt>{t('withdrawnOn')}</dt>
                    <dd>{f.dateTime(m.withdrawnAt)}</dd>
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
