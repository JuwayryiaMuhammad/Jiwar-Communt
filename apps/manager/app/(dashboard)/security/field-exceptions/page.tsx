'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { countdown, entryState, exceptionKindText, exceptionState, exceptionSubjectIn, secondsLeft } from '@/components/security/exceptions-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FieldException, type FieldExceptionFilter } from '@/lib/queries';
import { useNow } from '@/lib/use-now';
import ar from '@/messages/ar/sec-field-exceptions';
import en from '@/messages/en/sec-field-exceptions';

/** How long is left to answer, ticking; or where it stands. */
function TimeLeft({ e, now }: { e: FieldException; now: number }) {
  const t = useT(en, ar);
  const state = exceptionState(e, now);
  if (state === 'answerable') {
    const left = secondsLeft(e.answerBy, now);
    return (
      <Badge tone={left <= 60 ? 'error' : 'beige'}>
        {t('timeLeft', { time: countdown(left) })}
      </Badge>
    );
  }
  if (state === 'lapsed') return <Badge tone="error">{t('expired')}</Badge>;
  const entry = entryState(e, now);
  if (entry === 'open' && e.entryUntil)
    return (
      <span className="row">
        <StatusBadge status="approved" />
        <span className="t-muted">{t('entryFor', { time: countdown(secondsLeft(e.entryUntil, now)) })}</span>
      </span>
    );
  if (entry === 'used')
    return (
      <span className="row">
        <StatusBadge status="approved" />
        <span className="t-muted">{t('cameIn')}</span>
      </span>
    );
  if (entry === 'unused')
    return (
      <span className="row">
        <StatusBadge status="approved" />
        <span className="t-muted">{t('notUsed')}</span>
      </span>
    );
  return <StatusBadge status={e.status} />;
}

/**
 * Approve or reject, once: the first answer of the on-duty management
 * wins (GATE_EXCEPTION_DECIDED after it). The key makes a retry the same
 * answer.
 */
function useDecide(e: FieldException, onDone: () => void) {
  const t = useT(en, ar);
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
        toast.show(x.status === 'approved' ? t('approved') : t('rejected'));
        onDone();
      },
    },
  );
}

function Approve({ e, onClose }: { e: FieldException; onClose: () => void }) {
  const t = useT(en, ar);
  const { locale } = useLocale();
  const decide = useDecide(e, onClose);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={t('approveTitle', { who: exceptionSubjectIn(e, locale) })}
      description={t('approveDescription', { gate: e.gateName })}
      confirmLabel={t('approve')}
      pending={decide.isPending}
      error={<ErrorAlert error={decide.error} />}
      onConfirm={() => decide.mutate({ decision: 'approve' })}
    />
  );
}

function Reject({ e, onClose }: { e: FieldException; onClose: () => void }) {
  const t = useT(en, ar);
  const { locale } = useLocale();
  const decide = useDecide(e, onClose);
  return (
    <ReasonCodeDialog
      open
      onClose={onClose}
      title={t('rejectTitle', { who: exceptionSubjectIn(e, locale) })}
      description={t('rejectDescription')}
      codes={REASON_CODES.gateExceptionReject}
      confirmLabel={t('reject')}
      danger
      pending={decide.isPending}
      error={<ErrorAlert error={decide.error} />}
      onConfirm={(reasonCode) => decide.mutate({ decision: 'reject', reasonCode: reasonCode as (typeof REASON_CODES.gateExceptionReject)[number] })}
    />
  );
}

function ExceptionDetail({
  id,
  now,
  onClose,
  onAnswer,
}: {
  id: string;
  now: number;
  onClose: () => void;
  onAnswer: (e: FieldException, a: 'approve' | 'reject') => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const detail = useQuery({ queryKey: keys.fieldException(id), queryFn: () => fetchers.fieldException(id), refetchInterval: 10_000 });
  const e = detail.data;
  const answerable = e ? exceptionState(e, now) === 'answerable' : false;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={e ? `${e.reference} · ${exceptionKindText(e.kind, locale)}` : t('detailTitle')}
      footer={
        <>
          {e && answerable ? (
            <>
              <Button variant="danger" onClick={() => onAnswer(e, 'reject')}>
                {t('reject')}
              </Button>
              <Button variant="primary" onClick={() => onAnswer(e, 'approve')}>
                {t('approve')}
              </Button>
            </>
          ) : null}
          <Button onClick={onClose}>{c('close')}</Button>
        </>
      }
    >
      <QueryState query={detail} rows={5}>
        {e ? (
          <dl className="dl">
            <dt>{t('col.who')}</dt>
            <dd>{exceptionSubjectIn(e, locale)}</dd>
            <dt>{t('unitGate')}</dt>
            <dd>
              {e.unitCode} · {e.gateName}
            </dd>
            <dt>{t('whyGuardAsks')}</dt>
            <dd>{label(e.reasonCode)}</dd>
            <dt>{t('askedBy')}</dt>
            <dd>
              {e.raisedBy.fullName ?? t('erasedAccount')} · {f.dateTime(e.raisedAt)}
            </dd>
            <dt>{t('col.now')}</dt>
            <dd>
              <TimeLeft e={e} now={now} />
            </dd>
            {e.decidedAt ? (
              <>
                <dt>{t('answered')}</dt>
                <dd>
                  {e.decidedBy?.fullName ?? '—'} · {f.dateTime(e.decidedAt)}
                  {e.rejectReasonCode ? ` · ${label(e.rejectReasonCode)}` : ''}
                </dd>
              </>
            ) : null}
            {e.usedAt ? (
              <>
                <dt>{t('cameInLabel')}</dt>
                <dd>{f.dateTime(e.usedAt)}</dd>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );

  const answer = (e: FieldException, action: 'approve' | 'reject') => setAnswering({ e, action });
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<FieldExceptionFilter>
          label={t('shown')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: t('filter.pending') },
            { value: 'decided', label: t('filter.decided') },
            { value: 'all', label: c('all') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<FieldException>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={status === 'pending' ? t('emptyPending') : t('emptyAll')}
            columns={[
              {
                key: 'who',
                header: t('col.who'),
                cell: (e) => (
                  <span className="row">
                    <Button variant="text" className="table__link" onClick={() => setOpen(e.id)}>
                      {exceptionSubjectIn(e, locale)}
                    </Button>
                    <Badge tone="beige">{exceptionKindText(e.kind, locale)}</Badge>
                  </span>
                ),
              },
              { key: 'unit', header: t('col.unit'), cell: (e) => e.unitCode },
              { key: 'gate', header: t('col.gate'), cell: (e) => e.gateName },
              { key: 'reason', header: t('col.why'), cell: (e) => label(e.reasonCode) },
              { key: 'asked', header: t('col.asked'), cell: (e) => <span title={f.dateTime(e.raisedAt)}>{f.relative(e.raisedAt)}</span> },
              { key: 'now', header: t('col.now'), cell: (e) => <TimeLeft e={e} now={now} /> },
              {
                key: 'answer',
                header: '',
                cell: (e) =>
                  exceptionState(e, now) === 'answerable' ? (
                    <span className="row">
                      <Button size="sm" variant="primary" onClick={() => answer(e, 'approve')}>
                        {t('approve')}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => answer(e, 'reject')}>
                        {t('reject')}
                      </Button>
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
