'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type TicketDetail, type TicketPriority } from '@/lib/queries';
import { personName } from './sla';
import { TechnicianPicker } from './technician-picker';

/** The statuses each action is allowed from (the backend's ticket-rules.ts). */
const IN_HAND = ['assigned', 'en_route', 'in_progress', 'on_hold'];
const CHANGEABLE = ['new', ...IN_HAND, 'completed'];

type Open = 'assign' | 'reassign' | 'priority' | 'category' | 'cancel' | null;

/**
 * What a dispatcher may do to a ticket, shown only from the statuses that
 * allow it. A ticket that moved meanwhile answers TICKET_INVALID_TRANSITION,
 * which the dialog shows; every action refreshes the page's data.
 */
export function TicketActions({ ticket }: { ticket: TicketDetail }) {
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const [technicianId, setTechnicianId] = useState('');
  const [priority, setPriority] = useState<TicketPriority | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const path = { path: { id: ticket.id } };
  const refresh = { invalidate: [keys.ticketsAll, keys.technicians] };
  const categories = useQuery({
    queryKey: keys.ticketCategories,
    queryFn: fetchers.ticketCategories,
    enabled: open === 'category',
  });

  const close = () => {
    setOpen(null);
    setTechnicianId('');
    setPriority('');
    setCategoryId('');
    for (const a of [assign, reassign, changePriority, changeCategory, cancel]) a.reset();
  };
  const done = (text: string) => () => {
    toast.show(text);
    close();
  };

  const assign = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/assign', { params: path, body: { technicianId } })),
    { ...refresh, onDone: done(`${ticket.number} is assigned.`) },
  );
  const autoAssign = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/auto-assign', { params: path })),
    {
      ...refresh,
      onDone: (result) =>
        toast.show(
          result.outcome === 'assigned'
            ? `${ticket.number} went to ${personName(result.technician)}.`
            : 'No technician qualifies right now: none is available with a specialty this category needs.',
          result.outcome === 'assigned' ? 'success' : 'error',
        ),
    },
  );
  const reassign = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/reassign', { params: path, body: { technicianId, reasonCode } })),
    { ...refresh, onDone: done(`${ticket.number} is reassigned.`) },
  );
  const changePriority = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/priority', {
          params: path,
          body: { priority: priority as TicketPriority, reasonCode },
        }),
      ),
    { ...refresh, onDone: done('Priority changed.') },
  );
  const changeCategory = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/category', { params: path, body: { categoryId, reasonCode } })),
    { ...refresh, onDone: done('Category changed.') },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/cancel', { params: path, body: { reasonCode } })),
    { ...refresh, onDone: done(`${ticket.number} is cancelled.`) },
  );

  const s = ticket.status;
  if (!CHANGEABLE.includes(s)) return null;

  return (
    <>
      <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {s === 'new' ? (
          <>
            <Button variant="primary" onClick={() => setOpen('assign')}>
              Assign
            </Button>
            <Button loading={autoAssign.isPending} onClick={() => autoAssign.mutate()}>
              Auto-assign
            </Button>
          </>
        ) : null}
        {IN_HAND.includes(s) ? <Button onClick={() => setOpen('reassign')}>Reassign</Button> : null}
        <Button onClick={() => setOpen('priority')}>Priority</Button>
        <Button onClick={() => setOpen('category')}>Category</Button>
        <Button variant="danger" onClick={() => setOpen('cancel')}>
          Cancel ticket
        </Button>
      </span>
      <ErrorAlert error={autoAssign.error} />

      <Dialog
        open={open === 'assign'}
        onClose={close}
        title={`Assign ${ticket.number}`}
        description="The technician is told. An emergency reaches them at once, whatever their notification settings."
        onSubmit={() => technicianId && assign.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={assign.isPending} disabled={!technicianId}>
              Assign
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Technician">
            {(p) => <TechnicianPicker {...p} value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} />}
          </Field>
          <ErrorAlert error={assign.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={open === 'reassign'}
        onClose={close}
        title={`Reassign ${ticket.number}`}
        description={`From ${personName(ticket.technician)}. Both technicians are told; a visit they had agreed ends.`}
        codes={REASON_CODES.ticketReassign}
        confirmLabel="Reassign"
        ready={technicianId !== ''}
        pending={reassign.isPending}
        error={<ErrorAlert error={reassign.error} />}
        onConfirm={(code) => reassign.mutate(code)}
      >
        <Field label="New technician">
          {(p) => (
            <TechnicianPicker
              {...p}
              exclude={ticket.technician?.id}
              value={technicianId}
              onChange={(e) => setTechnicianId(e.target.value)}
            />
          )}
        </Field>
      </ReasonCodeDialog>

      <ReasonCodeDialog
        open={open === 'priority'}
        onClose={close}
        title="Change the priority"
        description="The SLA targets follow the new priority from now on."
        codes={REASON_CODES.ticketPriority}
        confirmLabel="Change priority"
        ready={priority !== '' && priority !== ticket.priority}
        pending={changePriority.isPending}
        error={<ErrorAlert error={changePriority.error} />}
        onConfirm={(code) => changePriority.mutate(code)}
      >
        <Field label="Priority" hint={`Now: ${ticket.priority}.`}>
          {(p) => (
            <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority | '')}>
              <option value="">Select…</option>
              {(['normal', 'urgent', 'emergency'] as const)
                .filter((x) => x !== ticket.priority)
                .map((x) => (
                  <option key={x} value={x}>
                    {x.charAt(0).toUpperCase() + x.slice(1)}
                  </option>
                ))}
            </Select>
          )}
        </Field>
      </ReasonCodeDialog>

      <ReasonCodeDialog
        open={open === 'category'}
        onClose={close}
        title="Change the category"
        description="For a ticket filed under the wrong category. Its SLA targets follow the new one."
        codes={REASON_CODES.ticketCategory}
        confirmLabel="Change category"
        ready={categoryId !== ''}
        pending={changeCategory.isPending}
        error={<ErrorAlert error={changeCategory.error} />}
        onConfirm={(code) => changeCategory.mutate(code)}
      >
        <Field label="Category" hint={`Now: ${ticket.category.nameEn}.`}>
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Select…</option>
              {(categories.data?.data ?? [])
                .filter((c) => c.id !== ticket.category.id && (ticket.unit !== null || c.commonAreaAllowed))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nameEn}
                  </option>
                ))}
            </Select>
          )}
        </Field>
      </ReasonCodeDialog>

      <ReasonCodeDialog
        open={open === 'cancel'}
        onClose={close}
        title={`Cancel ${ticket.number}?`}
        description="The work stops and the ticket cannot be reopened. The reporter and the technician are told."
        codes={REASON_CODES.ticketCancel}
        confirmLabel="Cancel ticket"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
    </>
  );
}
