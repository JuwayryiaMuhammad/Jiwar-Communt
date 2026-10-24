'use client';

import { fieldError, formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Dialog, Field, Select, StatusBadge, Textarea, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import {
  APPROVAL_STATUS_TEXT,
  APPROVAL_TYPE_TEXT,
  columnLabel,
  MOTION_OUTCOME_TEXT,
  MOTION_STATUS_TEXT,
  subjectParts,
  tallyText,
  type SubjectValue,
} from '@/components/governance/matters';
import { api } from '@/lib/api';
import { keys, type Approval, type BoardMotion } from '@/lib/queries';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

/** A described value as read: an instant in local time, a code in words. */
function valueText(v: SubjectValue): string {
  if (v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (ISO_INSTANT.test(v)) return formatDateTime(v);
  if (/^[a-z]+(_[a-z]+)+$/.test(v)) return humanize(v);
  return v;
}

/** A matter's subject as its domain described it: codes, amounts and dates, no names. */
export function SubjectCard({ title, subject }: { title: string; subject: unknown }) {
  const { rows, tables } = subjectParts(subject);
  if (!rows.length && !tables.length) return null;
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length ? (
        <dl className="dl">
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'contents' }}>
              <dt>{r.label}</dt>
              <dd>{valueText(r.value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {tables.map((t) => (
        <div key={t.label} className="stack">
          <h3 className="t-secondary">{t.label}</h3>
          <DataTable<Record<string, SubjectValue>>
            rows={t.rows}
            rowKey={(r) => JSON.stringify(r)}
            columns={t.columns.map((c) => ({ key: c, header: columnLabel(c), cell: (r) => valueText(r[c] ?? null) }))}
          />
        </div>
      ))}
    </Card>
  );
}

/** Attachments as links, while their short-lived URLs last. */
export function Attachments({ items }: { items: { fileId: string; url: string | null }[] }) {
  if (!items.length) return <span className="t-secondary">None</span>;
  return (
    <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
      {items.map((a, i) =>
        a.url ? (
          <a key={a.fileId} href={a.url} target="_blank" rel="noreferrer">
            Attachment {i + 1}
          </a>
        ) : (
          <span key={a.fileId} className="t-secondary">
            Attachment {i + 1} (removed)
          </span>
        ),
      )}
    </span>
  );
}

type Matter = 'approval' | 'appeal' | 'representative';
type Vote = BoardMotion['votes'][number];

function Propose({ matter, matterId, onClose }: { matter: Matter; matterId: string; onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [outcome, setOutcome] = useState(matter === 'appeal' ? 'uphold' : 'approve');
  const [rationale, setRationale] = useState('');
  const [note, setNote] = useState('');
  const propose = useAction(
    () => {
      const params = { path: { id: matterId }, header: { 'Idempotency-Key': key } };
      if (matter === 'approval')
        return unwrap(
          api.POST('/api/v1/board/approvals/{id}/motions', {
            params,
            body: {
              outcome: outcome as 'approve' | 'reject',
              rationale: rationale.trim(),
              ...(note.trim() ? { alternativesNote: note.trim() } : {}),
            },
          }),
        );
      // A representative matter (ADR 0059): approve or reject, no alternatives.
      if (matter === 'representative')
        return unwrap(
          api.POST('/api/v1/board/representatives/matters/{id}/motions', {
            params,
            body: { outcome: outcome as 'approve' | 'reject', rationale: rationale.trim() },
          }),
        );
      return unwrap(
        api.POST('/api/v1/board/appeals/{id}/motions', {
          params,
          body: { outcome: outcome as 'uphold' | 'overturn', rationale: rationale.trim() },
        }),
      );
    },
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('Proposed. The other members were told; it closes once the count is decided.');
        onClose();
      },
    },
  );
  const outcomes = matter === 'appeal' ? ['uphold', 'overturn'] : ['approve', 'reject'];
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Propose a motion"
      description="The outcome and its reasons come first; members then vote for or against, once. The reasons are the board’s record: write no one’s name in them."
      onSubmit={() => propose.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={propose.isPending} disabled={!rationale.trim()}>
            Propose
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Outcome">
          {(p) => (
            <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {outcomes.map((o) => (
                <option key={o} value={o}>
                  {MOTION_OUTCOME_TEXT[o]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Rationale" error={fieldError(propose.error, 'rationale')}>
          {(p) => <Textarea {...p} rows={5} maxLength={4000} value={rationale} onChange={(e) => setRationale(e.target.value)} />}
        </Field>
        {matter === 'approval' ? (
          <Field label="On the alternatives (optional)" error={fieldError(propose.error, 'alternativesNote')}>
            {(p) => <Textarea {...p} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        ) : null}
        <ErrorAlert error={propose.error} />
      </div>
    </Dialog>
  );
}

function MotionCard({ m }: { m: BoardMotion }) {
  const toast = useToast();
  const [voteKey, setVoteKey] = useState(() => crypto.randomUUID());
  const vote = useAction(
    (choice: 'for' | 'against') =>
      unwrap(
        api.POST('/api/v1/board/motions/{id}/votes', {
          params: { path: { id: m.id }, header: { 'Idempotency-Key': voteKey } },
          body: { choice },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: (r) => {
        setVoteKey(crypto.randomUUID());
        toast.show(r.status === 'open' ? 'Your vote is in.' : `Your vote is in, and it decided the motion: ${MOTION_STATUS_TEXT[r.status]}.`);
      },
    },
  );
  const close = useAction(() => unwrap(api.POST('/api/v1/board/motions/{id}/close', { params: { path: { id: m.id } } })), {
    invalidate: [keys.governanceAll],
    onDone: (r) => toast.show(`Closed: ${MOTION_STATUS_TEXT[r.status]}.`),
  });
  const withdraw = useAction(() => unwrap(api.POST('/api/v1/board/motions/{id}/withdraw', { params: { path: { id: m.id } } })), {
    invalidate: [keys.governanceAll],
    onDone: () => toast.show('Withdrawn. The matter waits for another motion.'),
  });
  const open = m.status === 'open';
  return (
    <Card flush>
      <CardHeader
        title={
          <>
            {MOTION_OUTCOME_TEXT[m.outcome]} <StatusBadge status={m.status} />
          </>
        }
        actions={
          open ? (
            <span className="row" style={{ gap: 8 }}>
              {!m.myVote && !m.myRecusal ? (
                <>
                  <Button variant="primary" loading={vote.isPending} onClick={() => vote.mutate('for')}>
                    Vote for
                  </Button>
                  <Button loading={vote.isPending} onClick={() => vote.mutate('against')}>
                    Vote against
                  </Button>
                </>
              ) : null}
              {!m.myRecusal ? (
                <Button variant="text" loading={close.isPending} onClick={() => close.mutate(undefined)}>
                  Close
                </Button>
              ) : null}
              {m.proposedByMe ? (
                <Button variant="text" loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
                  Withdraw
                </Button>
              ) : null}
            </span>
          ) : null
        }
      >
        <span className="t-secondary">
          Proposed by {m.proposedByName ?? 'an erased account'} · {formatDateTime(m.openedAt)}
          {m.closedAt ? ` · closed ${formatDateTime(m.closedAt)}` : ''}
        </span>
      </CardHeader>
      <div className="stack" style={{ padding: '0 16px' }}>
        <p style={{ whiteSpace: 'pre-wrap' }}>{m.rationale}</p>
        {m.alternativesNote ? (
          <p className="t-secondary" style={{ whiteSpace: 'pre-wrap' }}>
            On the alternatives: {m.alternativesNote}
          </p>
        ) : null}
        <p>
          {tallyText(m.tally)}
          {m.recused ? ` · ${m.recused} recused, left out of the count` : ''}
        </p>
        {m.myRecusal ? (
          <p className="t-secondary">You are recused: you live in or own the unit, appealed, or the matter names you. You may not vote or close it.</p>
        ) : null}
        {m.myVote ? <p className="t-secondary">You voted {m.myVote}.</p> : null}
        {open ? (
          <p className="t-secondary">
            It closes by itself at the vote that decides it; a member closes it once decided, or past the deadline with a quorum.
          </p>
        ) : null}
      </div>
      <DataTable<Vote>
        rows={m.votes}
        rowKey={(v) => v.memberId}
        empty="No votes yet"
        columns={[
          { key: 'n', header: 'Member', cell: (v) => v.fullName ?? 'An erased account' },
          { key: 'c', header: 'Vote', cell: (v) => (v.choice === 'for' ? 'For' : 'Against') },
          { key: 't', header: 'Cast', cell: (v) => formatDateTime(v.castAt) },
        ]}
      />
      <div style={{ padding: '0 16px 16px' }}>
        <ErrorAlert error={vote.error ?? close.error ?? withdraw.error} />
      </div>
    </Card>
  );
}

/**
 * The board's motions on one matter (ADR 0055), newest first, with the
 * actions a sitting member has: propose while the matter waits and no motion
 * is open, vote once, close, withdraw one's own. The API decides each.
 */
export function Motions({
  matter,
  matterId,
  pending,
  motions,
}: {
  matter: Matter;
  matterId: string;
  pending: boolean;
  motions: BoardMotion[];
}) {
  const [proposing, setProposing] = useState(false);
  const anyOpen = motions.some((m) => m.status === 'open');
  const ordered = [...motions].sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Motions</h2>
        {pending && !anyOpen ? (
          <Button variant="primary" onClick={() => setProposing(true)}>
            Propose a motion
          </Button>
        ) : null}
      </div>
      {ordered.length ? ordered.map((m) => <MotionCard key={m.id} m={m} />) : <p className="t-secondary">No motion yet.</p>}
      {proposing ? <Propose matter={matter} matterId={matterId} onClose={() => setProposing(false)} /> : null}
    </div>
  );
}

type ApprovalLike = Approval;
type Alternative = Approval['alternatives'][number];

/** A request's status as read: an approved one already carried out shows as implemented. */
export function approvalStatus(a: Pick<Approval, 'status' | 'implementation'>): string {
  return a.status === 'approved' && a.implementation ? 'implemented' : a.status;
}

/** A decision package as raised (ADR 0055), and what became of it. Never a motion or a count. */
export function ApprovalPackage({ a }: { a: ApprovalLike }) {
  return (
    <div className="stack">
      <Card>
        <dl className="dl">
          <dt>Status</dt>
          <dd>
            <StatusBadge status={approvalStatus(a)} /> {APPROVAL_STATUS_TEXT[approvalStatus(a)]}
            {a.overdue ? ' · past its deadline' : ''}
          </dd>
          <dt>Type</dt>
          <dd>{APPROVAL_TYPE_TEXT[a.type]}</dd>
          <dt>Cost</dt>
          <dd>{a.cost ? egp(a.cost) : '—'}</dd>
          {a.threshold ? (
            <>
              <dt>Threshold</dt>
              <dd>
                {egp(a.threshold)}
                {a.type === 'major_contract' ? ' (the manager’s limit for one expense)' : ' (advisory)'}
              </dd>
            </>
          ) : null}
          <dt>Raised</dt>
          <dd>{formatDateTime(a.raisedAt)}</dd>
          <dt>Board’s deadline</dt>
          <dd>{formatDateTime(a.deadlineAt)}</dd>
          <dt>Context</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{a.context}</dd>
          <dt>Impact</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{a.impact}</dd>
          <dt>Attachments</dt>
          <dd>
            <Attachments items={a.attachments} />
          </dd>
        </dl>
      </Card>
      {a.alternatives.length ? (
        <Card flush>
          <CardHeader title="Alternatives considered" />
          <DataTable<Alternative>
            rows={a.alternatives}
            rowKey={(x) => String(x.position)}
            columns={[
              { key: 't', header: 'Alternative', cell: (x) => <span style={{ whiteSpace: 'pre-wrap' }}>{x.text}</span> },
              { key: 'c', header: 'Cost', cell: (x) => (x.cost ? egp(x.cost) : '—') },
            ]}
          />
        </Card>
      ) : null}
      {a.decision ? (
        <Card>
          <CardHeader title={`The board ${a.decision.decision}`} />
          <dl className="dl">
            <dt>Decided</dt>
            <dd>{formatDateTime(a.decision.decidedAt)}</dd>
            <dt>Rationale</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.rationale}</dd>
            {a.decision.alternativesNote ? (
              <>
                <dt>On the alternatives</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.alternativesNote}</dd>
              </>
            ) : null}
            {a.implementation ? (
              <>
                <dt>Implemented</dt>
                <dd>
                  {formatDateTime(a.implementation.implementedAt)}
                  {a.implementation.byDecision ? ' · by the decision itself' : ''}
                  {a.implementation.note ? ` · ${a.implementation.note}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
        </Card>
      ) : null}
      {a.withdrawal ? (
        <Card>
          <dl className="dl">
            <dt>Withdrawn</dt>
            <dd>
              {formatDateTime(a.withdrawal.withdrawnAt)} · {humanize(a.withdrawal.reasonCode)}
            </dd>
          </dl>
        </Card>
      ) : null}
    </div>
  );
}
