'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT, type Format } from '@jiwar/i18n';
import { Button, Card, CardHeader, DataTable, Dialog, Field, Select, StatusBadge, Textarea, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { codeText } from '@/components/governance/logic';
import { columnLabel, subjectParts, tallyText, type SubjectValue } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { keys, type Approval, type BoardMotion } from '@/lib/queries';
import codesAr from '@/messages/ar/gov-codes';
import ar from '@/messages/ar/gov-board-ui';
import codesEn from '@/messages/en/gov-codes';
import en from '@/messages/en/gov-board-ui';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

/** A described value as read: an instant in local time, a code in words. */
function valueText(v: SubjectValue, fmt: Format, label: (code: string) => string, yes: string, no: string): string {
  if (v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? yes : no;
  if (typeof v === 'number') return fmt.number(v);
  if (ISO_INSTANT.test(v)) return fmt.dateTime(v);
  if (/^[a-z]+(_[a-z]+)+$/.test(v)) return label(v);
  return v;
}

/** A matter's subject as its domain described it: codes, amounts and dates, no names. */
export function SubjectCard({ title, subject }: { title: string; subject: unknown }) {
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { rows, tables } = subjectParts(subject, label);
  if (!rows.length && !tables.length) return null;
  const text = (v: SubjectValue) => valueText(v, fmt, label, c('yes'), c('no'));
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length ? (
        <dl className="dl">
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'contents' }}>
              <dt>{r.label}</dt>
              <dd>{text(r.value)}</dd>
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
            columns={t.columns.map((col) => ({ key: col, header: columnLabel(col, label), cell: (r) => text(r[col] ?? null) }))}
          />
        </div>
      ))}
    </Card>
  );
}

/** Attachments as links, while their short-lived URLs last. */
export function Attachments({ items }: { items: { fileId: string; url: string | null }[] }) {
  const t = useT(en, ar);
  const c = useCommonT();
  if (!items.length) return <span className="t-secondary">{c('none')}</span>;
  return (
    <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
      {items.map((a, i) =>
        a.url ? (
          <a key={a.fileId} href={a.url} target="_blank" rel="noreferrer">
            {t('attachment', { n: i + 1 })}
          </a>
        ) : (
          <span key={a.fileId} className="t-secondary">
            {t('attachmentRemoved', { n: i + 1 })}
          </span>
        ),
      )}
    </span>
  );
}

type Matter = 'approval' | 'appeal' | 'representative';
type Vote = BoardMotion['votes'][number];

function Propose({ matter, matterId, onClose }: { matter: Matter; matterId: string; onClose: () => void }) {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
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
        toast.show(t('proposed'));
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
      title={t('proposeTitle')}
      description={t('proposeDescription')}
      onSubmit={() => propose.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={propose.isPending} disabled={!rationale.trim()}>
            {t('propose')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('outcome')}>
          {(p) => (
            <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {outcomes.map((o) => (
                <option key={o} value={o}>
                  {codeText(g, 'motionOutcome', o)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('rationale')} error={fieldError(propose.error, 'rationale')}>
          {(p) => <Textarea {...p} rows={5} maxLength={4000} value={rationale} onChange={(e) => setRationale(e.target.value)} />}
        </Field>
        {matter === 'approval' ? (
          <Field label={t('alternativesOptional')} error={fieldError(propose.error, 'alternativesNote')}>
            {(p) => <Textarea {...p} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        ) : null}
        <ErrorAlert error={propose.error} />
      </div>
    </Dialog>
  );
}

function MotionCard({ m }: { m: BoardMotion }) {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
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
        toast.show(r.status === 'open' ? t('voteIn') : t('voteDecided', { status: codeText(g, 'motionStatus', r.status) }));
      },
    },
  );
  const close = useAction(() => unwrap(api.POST('/api/v1/board/motions/{id}/close', { params: { path: { id: m.id } } })), {
    invalidate: [keys.governanceAll],
    onDone: (r) => toast.show(t('closedToast', { status: codeText(g, 'motionStatus', r.status) })),
  });
  const withdraw = useAction(() => unwrap(api.POST('/api/v1/board/motions/{id}/withdraw', { params: { path: { id: m.id } } })), {
    invalidate: [keys.governanceAll],
    onDone: () => toast.show(t('withdrawnToast')),
  });
  const open = m.status === 'open';
  const by = { name: m.proposedByName ?? c('erasedAccount'), when: fmt.dateTime(m.openedAt) };
  return (
    <Card flush>
      <CardHeader
        title={
          <>
            {codeText(g, 'motionOutcome', m.outcome)} <StatusBadge status={m.status} />
          </>
        }
        actions={
          open ? (
            <span className="row" style={{ gap: 8 }}>
              {!m.myVote && !m.myRecusal ? (
                <>
                  <Button variant="primary" loading={vote.isPending} onClick={() => vote.mutate('for')}>
                    {t('voteFor')}
                  </Button>
                  <Button loading={vote.isPending} onClick={() => vote.mutate('against')}>
                    {t('voteAgainst')}
                  </Button>
                </>
              ) : null}
              {!m.myRecusal ? (
                <Button variant="text" loading={close.isPending} onClick={() => close.mutate(undefined)}>
                  {c('close')}
                </Button>
              ) : null}
              {m.proposedByMe ? (
                <Button variant="text" loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
                  {t('withdraw')}
                </Button>
              ) : null}
            </span>
          ) : null
        }
      >
        <span className="t-secondary">
          {m.closedAt ? t('proposedByClosed', { ...by, closed: fmt.dateTime(m.closedAt) }) : t('proposedBy', by)}
        </span>
      </CardHeader>
      <div className="stack" style={{ padding: '0 16px' }}>
        <p style={{ whiteSpace: 'pre-wrap' }}>{m.rationale}</p>
        {m.alternativesNote ? (
          <p className="t-secondary" style={{ whiteSpace: 'pre-wrap' }}>
            {t('onAlternativesNote', { note: m.alternativesNote })}
          </p>
        ) : null}
        <p>
          {tallyText(g, m.tally)}
          {m.recused ? ` · ${t('recused', { n: m.recused })}` : ''}
        </p>
        {m.myRecusal ? <p className="t-secondary">{t('youRecused')}</p> : null}
        {m.myVote ? <p className="t-secondary">{t('youVoted', { choice: m.myVote })}</p> : null}
        {open ? <p className="t-secondary">{t('closesHint')}</p> : null}
      </div>
      <DataTable<Vote>
        rows={m.votes}
        rowKey={(v) => v.memberId}
        empty={t('noVotes')}
        columns={[
          { key: 'n', header: t('col.member'), cell: (v) => v.fullName ?? t('erased') },
          { key: 'c', header: t('col.vote'), cell: (v) => (v.choice === 'for' ? t('vote.for') : t('vote.against')) },
          { key: 't', header: t('col.cast'), cell: (v) => fmt.dateTime(v.castAt) },
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
  const t = useT(en, ar);
  const [proposing, setProposing] = useState(false);
  const anyOpen = motions.some((m) => m.status === 'open');
  const ordered = [...motions].sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>{t('motions')}</h2>
        {pending && !anyOpen ? (
          <Button variant="primary" onClick={() => setProposing(true)}>
            {t('proposeTitle')}
          </Button>
        ) : null}
      </div>
      {ordered.length ? ordered.map((m) => <MotionCard key={m.id} m={m} />) : <p className="t-secondary">{t('noMotion')}</p>}
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
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  return (
    <div className="stack">
      <Card>
        <dl className="dl">
          <dt>{c('status')}</dt>
          <dd>
            <StatusBadge status={approvalStatus(a)} /> {codeText(g, 'approvalStatus', approvalStatus(a))}
            {a.overdue ? ` · ${t('pastDeadline')}` : ''}
          </dd>
          <dt>{c('type')}</dt>
          <dd>{codeText(g, 'approvalType', a.type)}</dd>
          <dt>{t('cost')}</dt>
          <dd>{a.cost ? fmt.money(a.cost) : '—'}</dd>
          {a.threshold ? (
            <>
              <dt>{t('threshold')}</dt>
              <dd>
                {fmt.money(a.threshold)} {a.type === 'major_contract' ? t('thresholdLimit') : t('thresholdAdvisory')}
              </dd>
            </>
          ) : null}
          <dt>{t('raised')}</dt>
          <dd>{fmt.dateTime(a.raisedAt)}</dd>
          <dt>{t('deadline')}</dt>
          <dd>{fmt.dateTime(a.deadlineAt)}</dd>
          <dt>{t('context')}</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{a.context}</dd>
          <dt>{t('impact')}</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{a.impact}</dd>
          <dt>{t('attachments')}</dt>
          <dd>
            <Attachments items={a.attachments} />
          </dd>
        </dl>
      </Card>
      {a.alternatives.length ? (
        <Card flush>
          <CardHeader title={t('alternatives')} />
          <DataTable<Alternative>
            rows={a.alternatives}
            rowKey={(x) => String(x.position)}
            columns={[
              { key: 't', header: t('col.alternative'), cell: (x) => <span style={{ whiteSpace: 'pre-wrap' }}>{x.text}</span> },
              { key: 'c', header: t('cost'), cell: (x) => (x.cost ? fmt.money(x.cost) : '—') },
            ]}
          />
        </Card>
      ) : null}
      {a.decision ? (
        <Card>
          <CardHeader title={t('boardDecided', { decision: a.decision.decision })} />
          <dl className="dl">
            <dt>{t('decided')}</dt>
            <dd>{fmt.dateTime(a.decision.decidedAt)}</dd>
            <dt>{t('rationale')}</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.rationale}</dd>
            {a.decision.alternativesNote ? (
              <>
                <dt>{t('onAlternatives')}</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{a.decision.alternativesNote}</dd>
              </>
            ) : null}
            {a.implementation ? (
              <>
                <dt>{t('implemented')}</dt>
                <dd>
                  {fmt.dateTime(a.implementation.implementedAt)}
                  {a.implementation.byDecision ? ` · ${t('byDecision')}` : ''}
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
            <dt>{t('withdrawn')}</dt>
            <dd>
              {fmt.dateTime(a.withdrawal.withdrawnAt)} · {label(a.withdrawal.reasonCode)}
            </dd>
          </dl>
        </Card>
      ) : null}
    </div>
  );
}
