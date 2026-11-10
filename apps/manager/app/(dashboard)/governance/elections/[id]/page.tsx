'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Select,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { codeText, inLocale, seatsLeft, tieChoiceComplete, turnoutText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffGovernanceElection } from '@/lib/queries';
import ar from '@/messages/ar/gov-elections';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-elections';
import codesEn from '@/messages/en/gov-codes';

type Candidate = StaffGovernanceElection['candidates'][number];

function Certify({ election, onClose }: { election: StaffGovernanceElection; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const tied = election.candidates.filter((x) => x.outcome === 'tied');
  const remaining = seatsLeft(election.seats, election.candidates);
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const complete =
    !tied.length ||
    (tieChoiceComplete(
      chosen,
      tied.map((x) => x.id),
      remaining,
    ) &&
      reason !== '');
  const certify = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/governance/elections/{id}/certify', {
          params: { path: { id: election.id }, header: { 'Idempotency-Key': key } },
          body: tied.length ? { tieBreak: chosen, tieReasonCode: reason } : {},
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show(t('certified'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('certifyTitle', { reference: election.reference })}
      description={t('certifyDescription')}
      onSubmit={() => certify.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={certify.isPending} disabled={!complete}>
            {t('certify')}
          </Button>
        </>
      }
    >
      <div className="form">
        {tied.length ? (
          <>
            <p>{t('tie', { remaining })}</p>
            {tied.map((x) => (
              <Checkbox
                key={x.id}
                label={t('tiedCandidate', { name: x.fullName ?? '—', votes: x.votes ?? 0 })}
                checked={chosen.includes(x.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, x.id] : chosen.filter((y) => y !== x.id))}
              />
            ))}
            <Field label={t('howChose')}>
              {(p) => (
                <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">{t('choose')}</option>
                  {REASON_CODES.governanceTieBreak.map((code) => (
                    <option key={code} value={code}>
                      {label(code)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : null}
        <ErrorAlert error={certify.error} />
      </div>
    </Dialog>
  );
}

/** One election of the board (ADR 0051): its candidates, count and certification. */
export default function GovernanceElectionPage() {
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
  const election = useQuery({
    queryKey: keys.governanceElection(id),
    queryFn: () => fetchers.governanceElection(id),
    enabled: allowed,
  });
  const [certifying, setCertifying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [disqualifying, setDisqualifying] = useState<Candidate | null>(null);
  const cancel = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/governance/elections/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show(t('cancelled'));
        setCancelling(false);
      },
    },
  );
  const disqualify = useAction(
    (v: { candidateId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/governance/elections/{id}/candidates/{candidateId}/disqualify', {
          params: { path: { id, candidateId: v.candidateId } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show(t('disqualified'));
        setDisqualifying(null);
      },
    },
  );
  const back = <Back href="/governance/elections" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('electionTitle')} />
        <ForbiddenState />
      </>
    );
  const e = election.data;
  const live = e && !['certified', 'cancelled'].includes(e.phase);
  const beforeVoting = e && (e.phase === 'nominating' || e.phase === 'nominations_closed');
  const period = (from: string, to: string) => `${f.dateTime(from)} – ${f.dateTime(to)}`;
  return (
    <>
      <PageHeader
        back={back}
        title={e ? `${e.reference} · ${inLocale(locale, e.titleEn, e.titleAr)}` : t('electionTitle')}
        description={e ? t('summary', { seats: e.seats, months: e.termMonths }) : undefined}
        actions={
          e ? (
            <>
              {live ? (
                <Button variant="danger" onClick={() => setCancelling(true)}>
                  {t('cancel')}
                </Button>
              ) : null}
              {e.phase === 'closed' && e.electorate !== null && e.candidates.some((x) => x.outcome) ? (
                <Button variant="primary" onClick={() => setCertifying(true)}>
                  {t('certify')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <QueryState query={election}>
        {e ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>{t('phase')}</dt>
                <dd>
                  <StatusBadge status={e.phase} /> {codeText(g, 'phase', e.phase)}
                  {e.cancelReasonCode ? ` · ${label(e.cancelReasonCode)}` : ''}
                </dd>
                <dt>{t('nominations')}</dt>
                <dd>{period(e.nominationsOpenAt, e.nominationsCloseAt)}</dd>
                <dt>{t('voting')}</dt>
                <dd>{period(e.votingOpensAt, e.votingClosesAt)}</dd>
                <dt>{t('turnout')}</dt>
                <dd>{turnoutText(g, e.turnout, e.electorate)}</dd>
                {e.certifiedAt ? (
                  <>
                    <dt>{t('certifiedOn')}</dt>
                    <dd>
                      {e.tieReasonCode
                        ? t('certifiedLine', { when: f.dateTime(e.certifiedAt), reason: label(e.tieReasonCode) })
                        : f.dateTime(e.certifiedAt)}
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <Card flush>
              <CardHeader title={t('candidates')}>
                {e.phase === 'voting' ? <span className="t-secondary">{t('countsHidden')}</span> : null}
              </CardHeader>
              <DataTable<Candidate>
                rows={e.candidates}
                rowKey={(x) => x.id}
                empty={t('nobody')}
                columns={[
                  { key: 'n', header: t('col.candidate'), cell: (x) => x.fullName ?? <span className="t-secondary">{t('erased')}</span> },
                  { key: 'w', header: t('col.statement'), cell: (x) => x.statement ?? '—' },
                  {
                    key: 's',
                    header: c('status'),
                    cell: (x) => (
                      <>
                        <StatusBadge status={x.status} />
                        {x.reasonCode ? ` ${label(x.reasonCode)}` : ''}
                      </>
                    ),
                  },
                  { key: 'v', header: t('col.votes'), cell: (x) => (x.votes === null ? '—' : f.number(x.votes)) },
                  { key: 'o', header: t('col.outcome'), cell: (x) => (x.outcome ? codeText(g, 'outcome', x.outcome) : '—') },
                  {
                    key: 'a',
                    header: '',
                    cell: (x) =>
                      beforeVoting && x.status === 'nominated' ? (
                        <Button variant="text" onClick={() => setDisqualifying(x)}>
                          {t('disqualify')}
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </QueryState>
      {certifying && e ? <Certify election={e} onClose={() => setCertifying(false)} /> : null}
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t('cancelTitle')}
        codes={REASON_CODES.governanceElectionCancel}
        confirmLabel={t('cancelConfirm')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
      <ReasonCodeDialog
        open={disqualifying !== null}
        onClose={() => setDisqualifying(null)}
        title={disqualifying?.fullName ? t('disqualifyNamed', { name: disqualifying.fullName }) : t('disqualifyThis')}
        description={t('disqualifyDescription')}
        codes={REASON_CODES.governanceCandidateDisqualify}
        confirmLabel={t('disqualify')}
        danger
        pending={disqualify.isPending}
        error={<ErrorAlert error={disqualify.error} />}
        onConfirm={(reasonCode) => disqualifying && disqualify.mutate({ candidateId: disqualifying.id, reasonCode })}
      />
    </>
  );
}
