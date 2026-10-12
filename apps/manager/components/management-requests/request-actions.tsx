'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys, type ManagementRequestDetail } from '@/lib/queries';
import { HandlerPicker, personName } from './bits';
import { actionsFor } from './logic';

type Open = 'assign' | 'close' | null;

/**
 * What a handler may do to a request, shown only from the statuses that
 * allow it. A request that moved meanwhile answers
 * MANAGEMENT_REQUEST_INVALID_TRANSITION, which the dialog shows; every
 * action refreshes the page's data and the inbox.
 */
export function RequestActions({ request }: { request: ManagementRequestDetail }) {
  const toast = useToast();
  const { me } = usePermissions();
  const [open, setOpen] = useState<Open>(null);
  const [assigneeId, setAssigneeId] = useState('');
  const path = { path: { id: request.id } };
  const refresh = { invalidate: [keys.managementAll] };
  const may = actionsFor(request.status);

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
    { ...refresh, onDone: done(`${request.number} is updated.`) },
  );
  const start = useAction(() => unwrap(api.POST('/api/v1/management/requests/{id}/start', { params: path })), {
    ...refresh,
    onDone: () => toast.show(`${request.number} is in progress.`),
  });
  const closeRequest = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/management/requests/{id}/close', { params: path, body: { reasonCode } })),
    { ...refresh, onDone: done(`${request.number} is closed.`) },
  );

  if (!may.assign && !may.start && !may.close) return null;
  const mine = request.assignee?.id === me?.id;

  return (
    <>
      <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {may.start ? (
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
            Start
          </Button>
        ) : null}
        {may.assign && !mine && me ? (
          <Button loading={assign.isPending && open === null} onClick={() => assign.mutate(me.id)}>
            Assign to me
          </Button>
        ) : null}
        {may.assign ? <Button onClick={() => setOpen('assign')}>{request.assignee ? 'Reassign' : 'Assign'}</Button> : null}
        {may.close ? (
          <Button variant="danger" onClick={() => setOpen('close')}>
            Close request
          </Button>
        ) : null}
      </span>
      <ErrorAlert error={start.error ?? (open === null ? assign.error : null)} />

      <Dialog
        open={open === 'assign'}
        onClose={close}
        title={`Assign ${request.number}`}
        description={
          request.assignee
            ? `Now with ${personName(request.assignee)}. The new handler is told.`
            : 'The handler is told. An unassigned request stays in everyone’s queue.'
        }
        onSubmit={() => assigneeId && assign.mutate(assigneeId)}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            {request.assignee ? (
              <Button loading={assign.isPending} onClick={() => assign.mutate(null)}>
                Return to the queue
              </Button>
            ) : null}
            <Button type="submit" variant="primary" loading={assign.isPending} disabled={!assigneeId}>
              Assign
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Handler">
            {(p) => <HandlerPicker {...p} exclude={request.assignee?.id} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} />}
          </Field>
          <ErrorAlert error={assign.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={open === 'close'}
        onClose={close}
        title={`Close ${request.number}?`}
        description="The resident is told. They may reopen it within seven days; an appointment still planned is cancelled."
        codes={REASON_CODES.managementRequestClose}
        confirmLabel="Close request"
        danger
        pending={closeRequest.isPending}
        error={<ErrorAlert error={closeRequest.error} />}
        onConfirm={(code) => closeRequest.mutate(code)}
      />
    </>
  );
}
