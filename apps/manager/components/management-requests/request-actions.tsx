'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, ReasonCodeDialog, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys, type ManagementRequestDetail } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-requests';
import en from '@/messages/en/services-mgmt-requests';
import { HandlerPicker, usePersonName } from './bits';
import { actionsFor } from './logic';

type Open = 'assign' | 'close' | null;

/**
 * What a handler may do to a request, shown only from the statuses that
 * allow it. A request that moved meanwhile answers
 * MANAGEMENT_REQUEST_INVALID_TRANSITION, which the dialog shows; every
 * action refreshes the page's data and the inbox.
 */
export function RequestActions({ request }: { request: ManagementRequestDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const personName = usePersonName();
  const toast = useToast();
  const { me } = usePermissions();
  const [open, setOpen] = useState<Open>(null);
  const [assigneeId, setAssigneeId] = useState('');
  const path = { path: { id: request.id } };
  const refresh = { invalidate: [keys.managementAll] };
  const may = actionsFor(request.status);
  const number = request.number;

  const close = () => {
    setOpen(null);
    setAssigneeId('');
    for (const a of [assign, closeRequest]) a.reset();
  };
  const done = (text: string) => () => {
    toast.show(text);
    close();
  };

  const assign = useAction(
    (to: string | null) => unwrap(api.POST('/api/v1/management/requests/{id}/assign', { params: path, body: { assigneeId: to } })),
    { ...refresh, onDone: done(t('updatedToast', { number })) },
  );
  const start = useAction(() => unwrap(api.POST('/api/v1/management/requests/{id}/start', { params: path })), {
    ...refresh,
    onDone: () => toast.show(t('startedToast', { number })),
  });
  const closeRequest = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/management/requests/{id}/close', { params: path, body: { reasonCode } })),
    { ...refresh, onDone: done(t('closedToast', { number })) },
  );

  if (!may.assign && !may.start && !may.close) return null;
  const mine = request.assignee?.id === me?.id;

  return (
    <>
      <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {may.start ? (
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
            {t('start')}
          </Button>
        ) : null}
        {may.assign && !mine && me ? (
          <Button loading={assign.isPending && open === null} onClick={() => assign.mutate(me.id)}>
            {t('assignToMe')}
          </Button>
        ) : null}
        {may.assign ? <Button onClick={() => setOpen('assign')}>{request.assignee ? t('reassign') : t('assign')}</Button> : null}
        {may.close ? (
          <Button variant="danger" onClick={() => setOpen('close')}>
            {t('closeRequest')}
          </Button>
        ) : null}
      </span>
      <ErrorAlert error={start.error ?? (open === null ? assign.error : null)} />

      <Dialog
        open={open === 'assign'}
        onClose={close}
        title={t('assignTitle', { number })}
        description={request.assignee ? t('assignWith', { name: personName(request.assignee) }) : t('assignNone')}
        onSubmit={() => assigneeId && assign.mutate(assigneeId)}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            {request.assignee ? (
              <Button loading={assign.isPending} onClick={() => assign.mutate(null)}>
                {t('returnToQueue')}
              </Button>
            ) : null}
            <Button type="submit" variant="primary" loading={assign.isPending} disabled={!assigneeId}>
              {t('assign')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('handler')}>
            {(p) => <HandlerPicker {...p} exclude={request.assignee?.id} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} />}
          </Field>
          <ErrorAlert error={assign.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={open === 'close'}
        onClose={close}
        title={t('closeTitle', { number })}
        description={t('closeDescription')}
        codes={REASON_CODES.managementRequestClose}
        confirmLabel={t('closeRequest')}
        danger
        pending={closeRequest.isPending}
        error={<ErrorAlert error={closeRequest.error} />}
        onConfirm={(code) => closeRequest.mutate(code)}
      />
    </>
  );
}
