'use client';

import { REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT, type Format, type Translate } from '@jiwar/i18n';
import { Alert, Badge, Button, Checkbox, Dialog, Field, Input, ReasonDialog, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { WorkerActions } from '@/components/workers/worker-actions';
import { WorkerWages } from '@/components/workers/worker-wages';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';

/** A worker's days and hours: `Sun, Mon and Tue · 08:00–14:00`. */
export function scheduleText(t: Translate<typeof en>, fmt: Format, schedule: Schema<'WorkerScheduleDto'>): string {
  const days = [...schedule.days].sort().map((d) => fmt.weekday(d, 'short'));
  const windows = schedule.windows.map((w) => `${w.from}–${w.to}`);
  return t('schedule', { days: days.length ? fmt.list(days) : t('noDays'), windows: windows.length ? fmt.list(windows) : t('allDay') });
}

/** The 8-digit code and card come back once, at approval or reissue. */
export function AccessCodeDialog({
  code,
  onClose,
  title,
}: {
  code: Schema<'AccessCodeView'> | null;
  onClose: () => void;
  title?: string;
}) {
  const t = useT(en, ar);
  return (
    <Dialog
      open={code !== null}
      onClose={onClose}
      title={title ?? t('workerApproved')}
      description={t('accessCodeDescription')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('done')}
        </Button>
      }
    >
      {code?.accessCode ? (
        <div className="code-box" style={{ fontSize: 28, letterSpacing: 6, justifyContent: 'center' }}>
          {code.accessCode}
        </div>
      ) : (
        <Alert tone="info">{t('noNewCode')}</Alert>
      )}
    </Dialog>
  );
}

/**
 * A pending worker: identity, document, schedule and photo, then approve
 * (a passport worker's birth date is attested once) or reject.
 */
export function EngagementReview({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [confirmBirth, setConfirmBirth] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [issued, setIssued] = useState<Schema<'AccessCodeView'> | null>(null);
  // A code issued from the worker's own actions: a lost card, a reissue.
  const [reissued, setReissued] = useState<Schema<'AccessCodeView'> | null>(null);
  const [correction, setCorrection] = useState('');

  const detail = useQuery({
    queryKey: keys.engagement(id ?? ''),
    queryFn: () => unwrap(api.GET('/api/v1/worker-engagements/{id}', { params: { path: { id: id ?? '' } } })),
    enabled: id !== null,
  });
  const d = detail.data;
  const needsBirthConfirmation = d?.worker.idDocumentType === 'passport' && !d.worker.birthDateVerifiedAt;

  const review = useAction(
    (v: { decision: 'approve' | 'reject'; reasonCode?: string; reason?: string }) =>
      unwrap(
        api.POST('/api/v1/worker-engagements/{id}/review', {
          params: { path: { id: id ?? '' } },
          // The contract marks reasonCode/reason required (shared ReasonDto),
          // but the service asks for them on a rejection only.
          body: (v.decision === 'approve'
            ? {
                decision: 'approve',
                ...(needsBirthConfirmation ? { birthDateConfirmed: confirmBirth } : {}),
                // The passport says otherwise: corrected in the same step.
                ...(needsBirthConfirmation && correction ? { birthDate: correction } : {}),
              }
            : { decision: 'reject', reasonCode: v.reasonCode, reason: v.reason }) as Schema<'ReviewDto'>,
        }),
      ),
    {
      invalidate: [keys.engagementsAll],
      onDone: (result, v) => {
        if (v.decision === 'approve') {
          setIssued(result as Schema<'AccessCodeView'>);
        } else {
          toast.show(t('rejected'));
          setRejecting(false);
          close();
        }
      },
    },
  );

  function close() {
    setConfirmBirth(false);
    setCorrection('');
    review.reset();
    onClose();
  }

  return (
    <>
      <Dialog
        wide
        open={id !== null && issued === null && reissued === null && !rejecting}
        onClose={close}
        title={d ? d.worker.fullName : t('worker')}
        description={d ? t('reviewDescription', { capacity: label(d.capacity), unit: d.unitCode }) : undefined}
        footer={
          d?.status === 'pending_review' ? (
            <>
              <Button onClick={() => setRejecting(true)}>{c('reject')}</Button>
              <Button
                variant="primary"
                loading={review.isPending}
                disabled={needsBirthConfirmation && !confirmBirth}
                onClick={() => review.mutate({ decision: 'approve' })}
              >
                {c('approve')}
              </Button>
            </>
          ) : (
            <Button onClick={close}>{c('close')}</Button>
          )
        }
      >
        <QueryState query={detail} rows={4}>
          {d ? (
            <div className="stack">
              <div className="row" style={{ alignItems: 'flex-start', gap: 20, flexWrap: 'nowrap' }}>
                {d.worker.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived presigned URL
                  <img
                    src={d.worker.photo.url}
                    alt={t('photoOf', { name: d.worker.fullName })}
                    width={96}
                    height={96}
                    style={{ borderRadius: 12, objectFit: 'cover', flex: 'none' }}
                  />
                ) : (
                  <span className="avatar" style={{ width: 96, height: 96, borderRadius: 12, fontSize: 13 }}>
                    {t('noPhoto')}
                  </span>
                )}
                <dl className="dl" style={{ flex: 1 }}>
                  <dt>{c('status')}</dt>
                  <dd>
                    <span className="row">
                      <StatusBadge status={d.status} />
                      {d.worker.banned ? <Badge tone="error">{t('banned')}</Badge> : null}
                    </span>
                  </dd>
                  <dt>{t('document')}</dt>
                  <dd>
                    {label(d.worker.idDocumentType)} <bdi className="t-mono">{d.worker.idDocumentNumberMasked}</bdi>
                  </dd>
                  <dt>{t('nationality')}</dt>
                  <dd>{d.worker.nationality}</dd>
                  <dt>{t('birthDate')}</dt>
                  <dd>
                    {fmt.day(d.worker.birthDate)}{' '}
                    {d.worker.birthDateVerifiedAt ? <Badge tone="green" plain>{t('verified')}</Badge> : null}
                  </dd>
                  <dt>{c('phone')}</dt>
                  <dd className="t-num">
                    <bdi>{d.worker.phone}</bdi>
                  </dd>
                  <dt>{t('scheduleLabel')}</dt>
                  <dd>{scheduleText(t, fmt, d.schedule)}</dd>
                  <dt>{t('requestedBy')}</dt>
                  <dd>{d.requestedBy.erased ? t('erased') : d.requestedBy.fullName}</dd>
                  <dt>{t('validUntil')}</dt>
                  <dd>{fmt.date(d.validUntil)}</dd>
                </dl>
              </div>
              {needsBirthConfirmation && d.status === 'pending_review' ? (
                <Alert tone="warn">
                  <div className="form">
                    <Field
                      label={t('birthCorrection')}
                      hint={t('birthCorrectionHint', { day: fmt.day(d.worker.birthDate) })}
                    >
                      {(p) => <Input {...p} type="date" value={correction} onChange={(e) => setCorrection(e.target.value)} />}
                    </Field>
                    <Checkbox
                      label={
                        correction
                          ? t('birthCheckedNew', { day: fmt.day(correction) })
                          : t('birthChecked')
                      }
                      checked={confirmBirth}
                      onChange={(e) => setConfirmBirth(e.target.checked)}
                    />
                  </div>
                </Alert>
              ) : null}
              <ErrorAlert error={review.error} />
              <WorkerWages engagement={d} />
              {d.status !== 'pending_review' ? <WorkerActions engagement={d} onCode={setReissued} /> : null}
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <ReasonDialog
        open={rejecting}
        onClose={() => {
          setRejecting(false);
          review.reset();
        }}
        title={d ? t('rejectTitle', { name: d.worker.fullName }) : t('rejectThis')}
        description={t('rejectDescription')}
        codes={REASON_CODES.workerReject}
        confirmLabel={c('reject')}
        danger
        pending={review.isPending}
        error={<ErrorAlert error={review.error} />}
        onConfirm={(reason) => review.mutate({ decision: 'reject', ...reason })}
      />
      <AccessCodeDialog code={reissued} title={t('newAccessCode')} onClose={() => setReissued(null)} />
      <AccessCodeDialog
        code={issued}
        onClose={() => {
          setIssued(null);
          toast.show(t('approved'));
          close();
        }}
      />
    </>
  );
}
