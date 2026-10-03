'use client';

import { formatDate, humanize, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Badge, Button, Checkbox, Dialog, ReasonDialog, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function scheduleText(schedule: Schema<'WorkerScheduleDto'>): string {
  const days = [...schedule.days].sort().map((d) => DAYS[d] ?? '?').join(', ');
  const windows = schedule.windows.map((w) => `${w.from}–${w.to}`).join(', ');
  return `${days || 'No days'} · ${windows || 'all day'}`;
}

/** The 8-digit code and card come back once, at approval or reissue. */
export function AccessCodeDialog({ code, onClose }: { code: Schema<'AccessCodeView'> | null; onClose: () => void }) {
  return (
    <Dialog
      open={code !== null}
      onClose={onClose}
      title="Worker approved"
      description="The access code is shown once. Give it to the resident who registered the worker."
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {code?.accessCode ? (
        <div className="code-box" style={{ fontSize: 28, letterSpacing: 6, justifyContent: 'center' }}>
          {code.accessCode}
        </div>
      ) : (
        <Alert tone="info">No new code was issued: the worker keeps their current one.</Alert>
      )}
    </Dialog>
  );
}

/**
 * A pending worker: identity, document, schedule and photo, then approve
 * (a passport worker's birth date is attested once) or reject.
 */
export function EngagementReview({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const [confirmBirth, setConfirmBirth] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [issued, setIssued] = useState<Schema<'AccessCodeView'> | null>(null);

  const detail = useQuery({
    queryKey: ['worker-engagements', 'detail', id],
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
            ? { decision: 'approve', ...(needsBirthConfirmation ? { birthDateConfirmed: confirmBirth } : {}) }
            : { decision: 'reject', reasonCode: v.reasonCode, reason: v.reason }) as Schema<'ReviewDto'>,
        }),
      ),
    {
      invalidate: [keys.engagementsAll],
      onDone: (result, v) => {
        if (v.decision === 'approve') {
          setIssued(result as Schema<'AccessCodeView'>);
        } else {
          toast.show('Worker rejected. The resident is told why.');
          setRejecting(false);
          close();
        }
      },
    },
  );

  function close() {
    setConfirmBirth(false);
    review.reset();
    onClose();
  }

  return (
    <>
      <Dialog
        wide
        open={id !== null && issued === null && !rejecting}
        onClose={close}
        title={d ? d.worker.fullName : 'Worker'}
        description={d ? `${humanize(d.capacity)} · unit ${d.unitCode}` : undefined}
        footer={
          d?.status === 'pending_review' ? (
            <>
              <Button onClick={() => setRejecting(true)}>Reject</Button>
              <Button
                variant="primary"
                loading={review.isPending}
                disabled={needsBirthConfirmation && !confirmBirth}
                onClick={() => review.mutate({ decision: 'approve' })}
              >
                Approve
              </Button>
            </>
          ) : (
            <Button onClick={close}>Close</Button>
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
                    alt={`Photo of ${d.worker.fullName}`}
                    width={96}
                    height={96}
                    style={{ borderRadius: 12, objectFit: 'cover', flex: 'none' }}
                  />
                ) : (
                  <span className="avatar" style={{ width: 96, height: 96, borderRadius: 12, fontSize: 13 }}>
                    No photo
                  </span>
                )}
                <dl className="dl" style={{ flex: 1 }}>
                  <dt>Status</dt>
                  <dd>
                    <span className="row">
                      <StatusBadge status={d.status} />
                      {d.worker.banned ? <Badge tone="error">Banned</Badge> : null}
                    </span>
                  </dd>
                  <dt>Document</dt>
                  <dd>
                    {humanize(d.worker.idDocumentType)} <span className="t-mono">{d.worker.idDocumentNumberMasked}</span>
                  </dd>
                  <dt>Nationality</dt>
                  <dd>{d.worker.nationality}</dd>
                  <dt>Birth date</dt>
                  <dd>
                    {formatDate(d.worker.birthDate)}{' '}
                    {d.worker.birthDateVerifiedAt ? <Badge tone="green" plain>Verified</Badge> : null}
                  </dd>
                  <dt>Phone</dt>
                  <dd className="t-num">{d.worker.phone}</dd>
                  <dt>Schedule</dt>
                  <dd>{scheduleText(d.schedule)}</dd>
                  <dt>Requested by</dt>
                  <dd>{d.requestedBy.erased ? 'Erased account' : d.requestedBy.fullName}</dd>
                  <dt>Valid until</dt>
                  <dd>{formatDate(d.validUntil)}</dd>
                </dl>
              </div>
              {needsBirthConfirmation && d.status === 'pending_review' ? (
                <Alert tone="warn">
                  <Checkbox
                    label="I checked the passport: the birth date above is correct and the worker is 18 or older."
                    checked={confirmBirth}
                    onChange={(e) => setConfirmBirth(e.target.checked)}
                  />
                </Alert>
              ) : null}
              <ErrorAlert error={review.error} />
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
        title={`Reject ${d?.worker.fullName ?? 'this worker'}?`}
        description="The resident who registered the worker is told why."
        codes={REASON_CODES.workerReject}
        confirmLabel="Reject"
        danger
        pending={review.isPending}
        error={<ErrorAlert error={review.error} />}
        onConfirm={(reason) => review.mutate({ decision: 'reject', ...reason })}
      />
      <AccessCodeDialog
        code={issued}
        onClose={() => {
          setIssued(null);
          toast.show('Worker approved.');
          close();
        }}
      />
    </>
  );
}
