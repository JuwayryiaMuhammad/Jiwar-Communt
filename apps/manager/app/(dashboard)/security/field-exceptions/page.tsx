'use client';

import { formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, ConfirmDialog, DataTable, Dialog, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { countdown, entryState, EXCEPTION_KINDS, exceptionState, exceptionSubject, secondsLeft } from '@/components/security/exceptions-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FieldException, type FieldExceptionFilter } from '@/lib/queries';
import { useNow } from '@/lib/use-now';

/** How long is left to answer, ticking; or where it stands. */
function TimeLeft({ e, now }: { e: FieldException; now: number }) {
  const state = exceptionState(e, now);
  if (state === 'answerable') {
    const left = secondsLeft(e.answerBy, now);
    return (
      <Badge tone={left <= 60 ? 'error' : 'beige'}>
        <span className="t-num">{countdown(left)}</span> left
      </Badge>
    );
  }
  if (state === 'lapsed') return <Badge tone="error">Expired</Badge>;
  const entry = entryState(e, now);
  if (entry === 'open' && e.entryUntil)
    return (
      <span className="row">
        <StatusBadge status="approved" />
        <span className="t-muted">entry for {countdown(secondsLeft(e.entryUntil, now))}</span>
      </span>
    );
  if (entry === 'used') return <span className="row"><StatusBadge status="approved" /><span className="t-muted">came in</span></span>;
  if (entry === 'unused') return <span className="row"><StatusBadge status="approved" /><span className="t-muted">not used</span></span>;
  return <StatusBadge status={e.status} />;
}

/**
 * Approve or reject, once: the first answer of the on-duty management
 * wins (GATE_EXCEPTION_DECIDED after it). The key makes a retry the same
 * answer.
 */
function useDecide(e: FieldException, onDone: () => void) {
  const toast = useToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return useAction(
    (body: { decision: 'approve' | 'reject'; reasonCode?: (typeof REASON_CODES.gateExceptionReject)[number] }) =>
      unwrap(
        api.POST('/api/v1/staff/gate/field-exceptions/{id}/decide', {
          params: { path: { id: e.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body,
        }),
      ),
    {
      invalidate: [keys.fieldExceptionsAll],
      onDone: (x) => {
        toast.show(x.status === 'approved' ? 'Approved: the guard may let them in once, at their gate.' : 'Rejected: the guard is told.');
        onDone();
      },
    },
  );
}

function Approve({ e, onClose }: { e: FieldException; onClose: () => void }) {
  const decide = useDecide(e, onClose);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Let ${exceptionSubject(e)} in?`}
      description={`Once, at ${e.gateName}, within the gate’s entry window. A lockdown or a ban still refuses them.`}
      confirmLabel="Approve"
      pending={decide.isPending}
      error={<ErrorAlert error={decide.error} />}
      onConfirm={() => decide.mutate({ decision: 'approve' })}
    />
  );
}

function Reject({ e, onClose }: { e: FieldException; onClose: () => void }) {
  const decide = useDecide(e, onClose);
  return (
    <ReasonCodeDialog
      open
      onClose={onClose}
      title={`Refuse ${exceptionSubject(e)}?`}
      description="The guard is told, with the reason."
      codes={REASON_CODES.gateExceptionReject}
      confirmLabel="Reject"
      danger
      pending={decide.isPending}
      error={<ErrorAlert error={decide.error} />}
      onConfirm={(reasonCode) => decide.mutate({ decision: 'reject', reasonCode: reasonCode as (typeof REASON_CODES.gateExceptionReject)[number] })}
    />
  );
}

function ExceptionDetail({ id, now, onClose, onAnswer }: { id: string; now: number; onClose: () => void; onAnswer: (e: FieldException, a: 'approve' | 'reject') => void }) {
  const detail = useQuery({ queryKey: keys.fieldException(id), queryFn: () => fetchers.fieldException(id), refetchInterval: 10_000 });
  const e = detail.data;
  const answerable = e ? exceptionState(e, now) === 'answerable' : false;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={e ? `${e.reference} · ${EXCEPTION_KINDS[e.kind] ?? humanize(e.kind)}` : 'Field exception'}
      footer={
        <>
          {e && answerable ? (
            <>
              <Button variant="danger" onClick={() => onAnswer(e, 'reject')}>Reject</Button>
              <Button variant="primary" onClick={() => onAnswer(e, 'approve')}>Approve</Button>
            </>
          ) : null}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <QueryState query={detail} rows={5}>
        {e ? (
          <dl className="dl">
            <dt>Who</dt>
            <dd>{exceptionSubject(e)}</dd>
            <dt>Unit · gate</dt>
            <dd>{e.unitCode} · {e.gateName}</dd>
            <dt>Why the guard asks</dt>
            <dd>{humanize(e.reasonCode)}</dd>
            <dt>Asked by</dt>
            <dd>{e.raisedBy.fullName ?? 'An erased account'} · {formatDateTime(e.raisedAt)}</dd>
            <dt>Now</dt>
            <dd><TimeLeft e={e} now={now} /></dd>
            {e.decidedAt ? (
              <>
                <dt>Answered</dt>
                <dd>
                  {e.decidedBy?.fullName ?? '—'} · {formatDateTime(e.decidedAt)}
                  {e.rejectReasonCode ? ` · ${humanize(e.rejectReasonCode)}` : ''}
                </dd>
              </>
            ) : null}
            {e.usedAt ? (
              <>
                <dt>Came in</dt>
                <dd>{formatDateTime(e.usedAt)}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </QueryState>
    </Dialog>
  );
}

/**
 * Field exceptions (ADR 0056): a guard asks the on-duty management to let
 * in, once, someone the gate refused — a worker outside their hours, a
 * visitor without a pass, an unregistered vehicle. Every holder of
 * `gate_exceptions.decide` sees them; the first answer wins. Unanswered
 * by its deadline, it expires: the countdown ticks here, the list
 * refreshes every ten seconds while it shows what waits.
 */
export default function FieldExceptionsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('gate_exceptions.decide');
  const params = useSearchParams();
  const [status, setStatus] = useState<FieldExceptionFilter>('pending');
  const [open, setOpen] = useState<string | null>(params.get('exception'));
  const [answering, setAnswering] = useState<{ e: FieldException; action: 'approve' | 'reject' } | null>(null);
  const now = useNow(1000);
  const list = useCursorList(keys.fieldExceptions(status), (c) => fetchers.fieldExceptions(status, c), {
    enabled: allowed,
    refetchInterval: status === 'pending' ? 10_000 : undefined,
  });

  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Field exceptions" />
        <ForbiddenState />
      </>
    );

  const answer = (e: FieldException, action: 'approve' | 'reject') => setAnswering({ e, action });
  return (
    <>
      <PageHeader
        title="Field exceptions"
        description="A guard asks to let someone in once that the gate refused. Answer before the time runs out; the first answer wins."
      />
      <div className="toolbar">
        <Segmented<FieldExceptionFilter>
          label="Exceptions shown"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: 'Waiting' },
            { value: 'decided', label: 'Answered or expired' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<FieldException>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={status === 'pending' ? 'Nothing waits for an answer' : 'No field exception'}
            columns={[
              {
                key: 'who',
                header: 'Who',
                cell: (e) => (
                  <span className="row">
                    <Button variant="text" className="table__link" onClick={() => setOpen(e.id)}>
                      {exceptionSubject(e)}
                    </Button>
                    <Badge tone="beige">{EXCEPTION_KINDS[e.kind] ?? humanize(e.kind)}</Badge>
                  </span>
                ),
              },
              { key: 'unit', header: 'Unit', cell: (e) => e.unitCode },
              { key: 'gate', header: 'Gate', cell: (e) => e.gateName },
              { key: 'reason', header: 'Why', cell: (e) => humanize(e.reasonCode) },
              { key: 'asked', header: 'Asked', cell: (e) => <span title={formatDateTime(e.raisedAt)}>{relativeTime(e.raisedAt)}</span> },
              { key: 'now', header: 'Now', cell: (e) => <TimeLeft e={e} now={now} /> },
              {
                key: 'answer',
                header: '',
                cell: (e) =>
                  exceptionState(e, now) === 'answerable' ? (
                    <span className="row">
                      <Button size="sm" variant="primary" onClick={() => answer(e, 'approve')}>Approve</Button>
                      <Button size="sm" variant="danger" onClick={() => answer(e, 'reject')}>Reject</Button>
                    </span>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <ExceptionDetail id={open} now={now} onClose={() => setOpen(null)} onAnswer={answer} /> : null}
      {answering?.action === 'approve' ? <Approve e={answering.e} onClose={() => setAnswering(null)} /> : null}
      {answering?.action === 'reject' ? <Reject e={answering.e} onClose={() => setAnswering(null)} /> : null}
    </>
  );
}
