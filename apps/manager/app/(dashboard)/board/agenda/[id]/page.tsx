'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, Dialog, Field, ForbiddenState, PageHeader, Select, StatusBadge, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { AGENDA_STATUS_TEXT } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Outcome = 'accepted' | 'declined';

/** A member answers a proposal once: accepted, or declined with its code; a note to the proposer either way. */
function Decide({ id, outcome, onClose }: { id: string; outcome: Outcome; onClose: () => void }) {
  const toast = useToast();
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const decide = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/board/agenda-proposals/{id}/decide', {
          params: { path: { id } },
          body: {
            outcome,
            ...(outcome === 'declined' ? { reasonCode } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show(outcome === 'accepted' ? 'Accepted. The proposer was told.' : 'Declined. The proposer was told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={outcome === 'accepted' ? 'Accept this proposal?' : 'Decline this proposal?'}
      description="Once, for the board. The proposer reads your note: write no one’s name in it."
      onSubmit={() => decide.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={decide.isPending} disabled={outcome === 'declined' && !reasonCode}>
            {outcome === 'accepted' ? 'Accept' : 'Decline'}
          </Button>
        </>
      }
    >
      <div className="form">
        {outcome === 'declined' ? (
          <Field label="Why" error={fieldError(decide.error, 'reasonCode')}>
            {(p) => (
              <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                <option value="">Choose a reason</option>
                {REASON_CODES.agendaDecline.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Note to the proposer (optional)" error={fieldError(decide.error, 'note')}>
          {(p) => <Textarea {...p} rows={4} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <ErrorAlert error={decide.error} />
      </div>
    </Dialog>
  );
}

/** An owner's agenda proposal as the board reads it (ADR 0059): its words, never who wrote them. */
export default function BoardAgendaProposalPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [deciding, setDeciding] = useState<Outcome | null>(null);
  const q = useQuery({ queryKey: keys.boardAgendaProposal(id), queryFn: () => fetchers.boardAgendaProposal(id), enabled: allowed });
  const back = <Back href="/board/agenda" label="Agenda proposals" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Proposal" />
        <ForbiddenState />
      </>
    );
  const p = q.data;
  return (
    <>
      <PageHeader
        back={back}
        title={p?.title ?? 'Proposal'}
        actions={
          p?.status === 'open' ? (
            <span className="row" style={{ gap: 8 }}>
              <Button variant="primary" onClick={() => setDeciding('accepted')}>
                Accept
              </Button>
              <Button onClick={() => setDeciding('declined')}>Decline</Button>
            </span>
          ) : null
        }
      />
      <QueryState query={q}>
        {p ? (
          <Card>
            <dl className="dl">
              <dt>Status</dt>
              <dd>
                <StatusBadge status={p.status} /> {AGENDA_STATUS_TEXT[p.status]}
              </dd>
              <dt>Proposed</dt>
              <dd>{formatDateTime(p.createdAt)}</dd>
              <dt>The proposal</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{p.body ?? 'Removed: its proposer’s account was erased.'}</dd>
              {p.decidedAt ? (
                <>
                  <dt>Answered</dt>
                  <dd>
                    {formatDateTime(p.decidedAt)}
                    {p.declineReason ? ` · ${humanize(p.declineReason)}` : ''}
                  </dd>
                </>
              ) : null}
              {p.decisionNote ? (
                <>
                  <dt>The board’s note</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{p.decisionNote}</dd>
                </>
              ) : null}
              {p.withdrawnAt ? (
                <>
                  <dt>Withdrawn</dt>
                  <dd>{formatDateTime(p.withdrawnAt)}</dd>
                </>
              ) : null}
            </dl>
          </Card>
        ) : null}
      </QueryState>
      {deciding && p ? <Decide id={p.id} outcome={deciding} onClose={() => setDeciding(null)} /> : null}
    </>
  );
}
