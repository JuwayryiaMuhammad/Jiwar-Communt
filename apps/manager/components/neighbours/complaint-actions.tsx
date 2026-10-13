'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, ReasonCodeDialog, Textarea, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type ComplaintDetail } from '@/lib/queries';
import { actionsFor, unitText } from './logic';

type Open = 'notice' | 'resolve' | 'dismiss' | null;

/**
 * What a handler may do to a complaint, shown only from the statuses that
 * allow it (ADR 0042). A complaint that moved meanwhile answers
 * NEIGHBOUR_COMPLAINT_INVALID_TRANSITION, which is shown; every action
 * refreshes the page's data and the inbox.
 */
export function ComplaintActions({ complaint }: { complaint: ComplaintDetail }) {
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const [notice, setNotice] = useState('');
  const path = { path: { id: complaint.id } };
  const refresh = { invalidate: [keys.complaintsAll] };
  const may = actionsFor(complaint.status, complaint.notice !== null);

  const close = () => {
    setOpen(null);
    for (const a of [sendNotice, resolve, dismiss]) a.reset();
  };
  const done = (text: string) => () => {
    toast.show(text);
    setNotice('');
    close();
  };

  const review = useAction(() => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/review', { params: path })), {
    ...refresh,
    onDone: () => toast.show(`${complaint.number} is under review. The complainant was told.`),
  });
  const mediate = useAction(() => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/mediation', { params: path })), {
    ...refresh,
    onDone: () => toast.show(`${complaint.number} is in mediation. The complainant was told.`),
  });
  const sendNotice = useAction(
    () => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/notice', { params: path, body: { body: notice.trim() } })),
    { ...refresh, onDone: done(`The notice went to unit ${complaint.targetUnit.code}.`) },
  );
  const resolve = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/resolve', { params: path, body: { reasonCode } })),
    { ...refresh, onDone: done(`${complaint.number} is resolved.`) },
  );
  const dismiss = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/dismiss', { params: path, body: { reasonCode } })),
    { ...refresh, onDone: done(`${complaint.number} is dismissed.`) },
  );

  if (!may.review && !may.notice && !may.mediate && !may.resolve && !may.dismiss) return null;

  return (
    <>
      <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {may.review ? (
          <Button variant="primary" loading={review.isPending} onClick={() => review.mutate()}>
            Take under review
          </Button>
        ) : null}
        {may.notice ? (
          <Button variant="primary" onClick={() => setOpen('notice')}>
            Send notice
          </Button>
        ) : null}
        {may.mediate ? (
          <Button loading={mediate.isPending} onClick={() => mediate.mutate()}>
            Start mediation
          </Button>
        ) : null}
        {may.resolve ? <Button onClick={() => setOpen('resolve')}>Resolve…</Button> : null}
        {may.dismiss ? (
          <Button variant="danger" onClick={() => setOpen('dismiss')}>
            Dismiss…
          </Button>
        ) : null}
      </span>
      <ErrorAlert error={review.error ?? mediate.error} />

      <Dialog
        open={open === 'notice'}
        onClose={close}
        wide
        title={`Send a notice to unit ${unitText(complaint.targetUnit)}`}
        description="A complaint has one notice. It goes to the people answering for the household living in the unit, or to its owners when nobody lives there. They never learn who complained, and never read the complaint."
        onSubmit={() => notice.trim() && sendNotice.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={sendNotice.isPending} disabled={!notice.trim()}>
              Send notice
            </Button>
          </>
        }
      >
        <div className="form">
          <Field
            label="The management’s words to the unit"
            hint="The only text of the matter the unit ever reads. Write it in your own words: do not name the complainant, their unit, or quote what they wrote. It cannot be changed or sent again."
            error={fieldError(sendNotice.error, 'body')}
          >
            {(p) => <Textarea {...p} rows={6} maxLength={2000} value={notice} onChange={(e) => setNotice(e.target.value)} />}
          </Field>
          <ErrorAlert error={sendNotice.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={open === 'resolve'}
        onClose={close}
        title={`Resolve ${complaint.number}?`}
        description="The complainant is told it was resolved. Nothing more is written to either side afterwards; staff notes stay possible."
        codes={REASON_CODES.neighbourComplaintResolve}
        codeLabel="How it ended"
        confirmLabel="Resolve complaint"
        pending={resolve.isPending}
        error={<ErrorAlert error={resolve.error} />}
        onConfirm={(code) => resolve.mutate(code)}
      />
      <ReasonCodeDialog
        open={open === 'dismiss'}
        onClose={close}
        title={`Dismiss ${complaint.number}?`}
        description="The complainant is told it was dismissed. “Unfounded” is counted in this author’s pattern and in the unit’s history."
        codes={REASON_CODES.neighbourComplaintDismiss}
        confirmLabel="Dismiss complaint"
        danger
        pending={dismiss.isPending}
        error={<ErrorAlert error={dismiss.error} />}
        onConfirm={(code) => dismiss.mutate(code)}
      />
    </>
  );
}
