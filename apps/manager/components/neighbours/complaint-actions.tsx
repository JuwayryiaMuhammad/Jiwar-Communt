'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, ReasonCodeDialog, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type ComplaintDetail } from '@/lib/queries';
import ar from '@/messages/ar/neighbours-complaint';
import en from '@/messages/en/neighbours-complaint';
import { actionsFor, unitText } from './logic';

type Open = 'notice' | 'resolve' | 'dismiss' | null;

/**
 * What a handler may do to a complaint, shown only from the statuses that
 * allow it (ADR 0042). A complaint that moved meanwhile answers
 * NEIGHBOUR_COMPLAINT_INVALID_TRANSITION, which is shown; every action
 * refreshes the page's data and the inbox.
 */
export function ComplaintActions({ complaint }: { complaint: ComplaintDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
    onDone: () => toast.show(t('toast.review', { number: complaint.number })),
  });
  const mediate = useAction(() => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/mediation', { params: path })), {
    ...refresh,
    onDone: () => toast.show(t('toast.mediate', { number: complaint.number })),
  });
  const sendNotice = useAction(
    () => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/notice', { params: path, body: { body: notice.trim() } })),
    { ...refresh, onDone: done(t('toast.notice', { unit: complaint.targetUnit.code })) },
  );
  const resolve = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/resolve', { params: path, body: { reasonCode } })),
    { ...refresh, onDone: done(t('toast.resolved', { number: complaint.number })) },
  );
  const dismiss = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/neighbours/complaints/{id}/dismiss', { params: path, body: { reasonCode } })),
    { ...refresh, onDone: done(t('toast.dismissed', { number: complaint.number })) },
  );

  if (!may.review && !may.notice && !may.mediate && !may.resolve && !may.dismiss) return null;

  return (
    <>
      <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {may.review ? (
          <Button variant="primary" loading={review.isPending} onClick={() => review.mutate()}>
            {t('review')}
          </Button>
        ) : null}
        {may.notice ? (
          <Button variant="primary" onClick={() => setOpen('notice')}>
            {t('sendNotice')}
          </Button>
        ) : null}
        {may.mediate ? (
          <Button loading={mediate.isPending} onClick={() => mediate.mutate()}>
            {t('mediate')}
          </Button>
        ) : null}
        {may.resolve ? <Button onClick={() => setOpen('resolve')}>{t('resolve')}</Button> : null}
        {may.dismiss ? (
          <Button variant="danger" onClick={() => setOpen('dismiss')}>
            {t('dismiss')}
          </Button>
        ) : null}
      </span>
      <ErrorAlert error={review.error ?? mediate.error} />

      <Dialog
        open={open === 'notice'}
        onClose={close}
        wide
        title={t('notice.title', { unit: unitText(complaint.targetUnit) })}
        description={t('notice.description')}
        onSubmit={() => notice.trim() && sendNotice.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={sendNotice.isPending} disabled={!notice.trim()}>
              {t('sendNotice')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field
            label={t('notice.label')}
            hint={t('notice.hint')}
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
        title={t('resolve.title', { number: complaint.number })}
        description={t('resolve.description')}
        codes={REASON_CODES.neighbourComplaintResolve}
        codeLabel={t('resolve.codeLabel')}
        confirmLabel={t('resolve.confirm')}
        pending={resolve.isPending}
        error={<ErrorAlert error={resolve.error} />}
        onConfirm={(code) => resolve.mutate(code)}
      />
      <ReasonCodeDialog
        open={open === 'dismiss'}
        onClose={close}
        title={t('dismiss.title', { number: complaint.number })}
        description={t('dismiss.description')}
        codes={REASON_CODES.neighbourComplaintDismiss}
        confirmLabel={t('dismiss.confirm')}
        danger
        pending={dismiss.isPending}
        error={<ErrorAlert error={dismiss.error} />}
        onConfirm={(code) => dismiss.mutate(code)}
      />
    </>
  );
}
