'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import {
  inEither,
  OUTCOME_TEXT,
  PHASE_TEXT,
  seatsLeft,
  tieChoiceComplete,
  turnoutText,
} from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffGovernanceElection } from '@/lib/queries';

type Candidate = StaffGovernanceElection['candidates'][number];

function Certify({ election, onClose }: { election: StaffGovernanceElection; onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const tied = election.candidates.filter((c) => c.outcome === 'tied');
  const remaining = seatsLeft(election.seats, election.candidates);
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const complete = !tied.length || (tieChoiceComplete(chosen, tied.map((t) => t.id), remaining) && reason !== '');
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
        toast.show('Certified. The elected board sits; its members and the owners were told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Certify ${election.reference}?`}
      description="The board before it ends now; the elected one sits for the election’s term. Record the offices on the Board page afterwards."
      onSubmit={() => certify.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={certify.isPending} disabled={!complete}>
            Certify
          </Button>
        </>
      }
    >
      <div className="form">
        {tied.length ? (
          <>
            <p>
              A tie across the last seat: the board chooses {remaining} of the tied candidates.
            </p>
            {tied.map((t) => (
              <Checkbox
                key={t.id}
                label={`${t.fullName ?? '—'} (${t.votes ?? 0} votes)`}
                checked={chosen.includes(t.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, t.id] : chosen.filter((c) => c !== t.id))}
              />
            ))}
            <Field label="How the board chose">
              {(p) => (
                <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">Choose…</option>
                  {REASON_CODES.governanceTieBreak.map((c) => (
                    <option key={c} value={c}>
                      {humanize(c)}
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
        toast.show('Cancelled. The board was told.');
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
        toast.show('Taken off the list.');
        setDisqualifying(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/governance/elections" label="Elections" />} title="Election" />
        <ForbiddenState />
      </>
    );
  const e = election.data;
  const live = e && !['certified', 'cancelled'].includes(e.phase);
  const beforeVoting = e && (e.phase === 'nominating' || e.phase === 'nominations_closed');
  return (
    <>
      <PageHeader
        back={<Back href="/governance/elections" label="Elections" />}
        title={e ? `${e.reference} · ${inEither(e.titleEn, e.titleAr)}` : 'Election'}
        description={e ? `${e.seats} seats · a term of ${e.termMonths} months` : undefined}
        actions={
          e ? (
            <>
              {live ? (
                <Button variant="danger" onClick={() => setCancelling(true)}>
                  Cancel
                </Button>
              ) : null}
              {e.phase === 'closed' && e.electorate !== null && e.candidates.some((c) => c.outcome) ? (
                <Button variant="primary" onClick={() => setCertifying(true)}>
                  Certify
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
                <dt>Phase</dt>
                <dd>
                  <StatusBadge status={e.phase} /> {PHASE_TEXT[e.phase]}
                  {e.cancelReasonCode ? ` · ${humanize(e.cancelReasonCode)}` : ''}
                </dd>
                <dt>Nominations</dt>
                <dd>
                  {formatDateTime(e.nominationsOpenAt)} – {formatDateTime(e.nominationsCloseAt)}
                </dd>
                <dt>Voting</dt>
                <dd>
                  {formatDateTime(e.votingOpensAt)} – {formatDateTime(e.votingClosesAt)}
                </dd>
                <dt>Turnout</dt>
                <dd>{turnoutText(e.turnout, e.electorate)}</dd>
                {e.certifiedAt ? (
                  <>
                    <dt>Certified</dt>
                    <dd>
                      {formatDateTime(e.certifiedAt)}
                      {e.tieReasonCode ? ` · the tie resolved by ${humanize(e.tieReasonCode)}` : ''}
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <Card flush>
              <CardHeader title="Candidates">
                {e.phase === 'voting' ? (
                  <span className="t-secondary">Counts show once voting closes: nobody sees one before.</span>
                ) : null}
              </CardHeader>
              <DataTable<Candidate>
                rows={e.candidates}
                rowKey={(c) => c.id}
                empty="Nobody stands yet"
                columns={[
                  { key: 'n', header: 'Candidate', cell: (c) => c.fullName ?? <span className="t-secondary">Erased</span> },
                  { key: 'w', header: 'Statement', cell: (c) => c.statement ?? '—' },
                  {
                    key: 's',
                    header: 'Status',
                    cell: (c) => (
                      <>
                        <StatusBadge status={c.status} />
                        {c.reasonCode ? ` ${humanize(c.reasonCode)}` : ''}
                      </>
                    ),
                  },
                  { key: 'v', header: 'Votes', cell: (c) => (c.votes === null ? '—' : c.votes) },
                  { key: 'o', header: 'Outcome', cell: (c) => (c.outcome ? OUTCOME_TEXT[c.outcome] : '—') },
                  {
                    key: 'a',
                    header: '',
                    cell: (c) =>
                      beforeVoting && c.status === 'nominated' ? (
                        <Button variant="text" onClick={() => setDisqualifying(c)}>
                          Disqualify
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
        title="Cancel the election?"
        codes={REASON_CODES.governanceElectionCancel}
        confirmLabel="Cancel the election"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
      <ReasonCodeDialog
        open={disqualifying !== null}
        onClose={() => setDisqualifying(null)}
        title={`Take ${disqualifying?.fullName ?? 'this candidate'} off the list?`}
        description="Until voting opens; the list is fixed from then on."
        codes={REASON_CODES.governanceCandidateDisqualify}
        confirmLabel="Disqualify"
        danger
        pending={disqualify.isPending}
        error={<ErrorAlert error={disqualify.error} />}
        onConfirm={(reasonCode) => disqualifying && disqualify.mutate({ candidateId: disqualifying.id, reasonCode })}
      />
    </>
  );
}
