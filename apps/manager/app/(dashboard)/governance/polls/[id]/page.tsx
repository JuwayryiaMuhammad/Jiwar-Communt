'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { codeText, inLocale, optionText, turnoutText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffGovernancePoll } from '@/lib/queries';
import ar from '@/messages/ar/gov-polls';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-polls';
import codesEn from '@/messages/en/gov-codes';

type Option = StaffGovernancePoll['options'][number];
type RollCall = NonNullable<StaffGovernancePoll['rollCall']>[number];

/** One poll of the owners (ADR 0051): its question, turnout and result. */
export default function GovernancePollPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const poll = useQuery({ queryKey: keys.governancePoll(id), queryFn: () => fetchers.governancePoll(id), enabled: allowed });
  const [cancelling, setCancelling] = useState(false);
  const cancel = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/governance/polls/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show(t('cancelled'));
        setCancelling(false);
      },
    },
  );
  const back = <Back href="/governance/polls" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('pollTitle')} />
        <ForbiddenState />
      </>
    );
  const p = poll.data;
  const total = p ? p.options.reduce((n, o) => n + (o.votes ?? 0), 0) : 0;
  const answerOf = (optionId: string) => {
    const o = p?.options.find((x) => x.id === optionId);
    return o ? optionText(g, locale, o) : '—';
  };
  return (
    <>
      <PageHeader
        back={back}
        title={p ? `${p.reference} · ${inLocale(locale, p.titleEn, p.titleAr)}` : t('pollTitle')}
        description={
          p
            ? t('subtitle', { ballot: p.secret ? 'secret' : 'open', from: f.dateTime(p.opensAt), to: f.dateTime(p.closesAt) })
            : undefined
        }
        actions={
          p && (p.status === 'scheduled' || p.status === 'open') ? (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              {t('cancelPoll')}
            </Button>
          ) : null
        }
      />
      <QueryState query={poll}>
        {p ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={p.status} />
                  {p.cancelReasonCode ? ` · ${label(p.cancelReasonCode)}` : ''}
                </dd>
                <dt>{t('about2')}</dt>
                <dd>{inLocale(locale, p.bodyEn, p.bodyAr)}</dd>
                <dt>{t('col.turnout')}</dt>
                <dd>{turnoutText(g, p.turnout, p.electorate)}</dd>
                <dt>{t('quorum')}</dt>
                <dd>{t('quorumValue', { pct: f.percent(p.quorumPct / 100) })}</dd>
                <dt>{t('toPass')}</dt>
                <dd>{t(p.kind === 'yes_no' ? 'passValueYesNo' : 'passValue', { pct: f.percent(p.thresholdPct / 100) })}</dd>
                <dt>{t('putBy')}</dt>
                <dd>{p.authorSide === 'board' ? t('by.board') : t('by.management')}</dd>
                {p.result ? (
                  <>
                    <dt>{t('resultLabel')}</dt>
                    <dd>
                      <StatusBadge status={p.result} /> {codeText(g, 'result', p.result)}
                      {p.winningOptionId ? ` · ${answerOf(p.winningOptionId)}` : ''}
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <Card flush>
              <CardHeader title={t('answersTitle')}>
                {p.status === 'closed' ? null : <span className="t-secondary">{t('countsHidden')}</span>}
              </CardHeader>
              <DataTable<Option>
                rows={p.options}
                rowKey={(o) => o.id}
                columns={[
                  { key: 'o', header: t('col.answer'), cell: (o) => optionText(g, locale, o) },
                  { key: 'v', header: t('col.votes'), cell: (o) => (o.votes === null ? '—' : f.number(o.votes)) },
                  {
                    key: 's',
                    header: t('col.share'),
                    cell: (o) => (o.votes === null ? '—' : f.percent(total ? o.votes / total : 0)),
                  },
                ]}
              />
            </Card>
            {p.rollCall ? (
              <Card flush>
                <CardHeader title={t('rollCall')}>
                  <span className="t-secondary">{t('rollCallNote')}</span>
                </CardHeader>
                <DataTable<RollCall>
                  rows={p.rollCall}
                  rowKey={(r) => r.unitCode}
                  empty={t('noUnitVoted')}
                  columns={[
                    { key: 'u', header: t('col.unit'), cell: (r) => <span className="t-mono ltr">{r.unitCode}</span> },
                    { key: 'c', header: t('col.answer'), cell: (r) => f.list(r.choice.map(answerOf)) },
                  ]}
                />
              </Card>
            ) : null}
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t('cancelTitle')}
        description={t('cancelDescription')}
        codes={REASON_CODES.governancePollCancel}
        confirmLabel={t('cancelPoll')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
    </>
  );
}
