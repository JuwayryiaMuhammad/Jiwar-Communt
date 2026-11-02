'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, ReasonCodeDialog, ReasonDialog, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type TicketDetail } from '@/lib/queries';

/**
 * Dispatch's own moves (ADR 0076): close a resident's completed ticket on
 * their behalf, reopen a closed ticket within 30 days, resume a ticket on
 * hold in its technician's hands. Shown only from the statuses that allow
 * each; a compound's work order is accepted instead of closed.
 */
export function TicketStaffMoves({ ticket }: { ticket: TicketDetail }) {
  const toast = useToast();
  const [open, setOpen] = useState<'close' | 'reopen' | null>(null);
  const path = { path: { id: ticket.id } };
  const refresh = { invalidate: [keys.ticketsAll, keys.technicians] };
  const shut = () => {
    setOpen(null);
    close.reset();
    reopen.reset();
  };

  const close = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/close', { params: path, body: { reasonCode } })),
    {
      ...refresh,
      onDone: () => {
        toast.show(`${ticket.number} is closed. The residents are told and may still reopen it.`);
        shut();
      },
    },
  );
  const reopen = useAction(
    (reason: { reasonCode: string; reason: string }) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/reopen', { params: path, body: reason })),
    {
      ...refresh,
      onDone: () => {
        toast.show(`${ticket.number} is open again.`);
        shut();
      },
    },
  );
  const resume = useAction(() => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/resume', { params: path })), {
    ...refresh,
    onDone: () => toast.show(`${ticket.number} is back in progress.`),
  });

  const closable = ticket.status === 'completed' && ticket.origin === 'resident';
  if (!closable && ticket.status !== 'closed' && ticket.status !== 'on_hold') return null;

  return (
    <>
      <span className="row" style={{ gap: 6 }}>
        {closable ? <Button onClick={() => setOpen('close')}>Close for the residents</Button> : null}
        {ticket.status === 'closed' ? <Button onClick={() => setOpen('reopen')}>Reopen</Button> : null}
        {ticket.status === 'on_hold' ? (
          <Button loading={resume.isPending} onClick={() => resume.mutate()}>
            Resume
          </Button>
        ) : null}
      </span>
      <ErrorAlert error={resume.error} />
      <ReasonCodeDialog
        open={open === 'close'}
        onClose={shut}
        title={`Close ${ticket.number} for the residents?`}
        description="When they confirmed by phone, cannot be reached, or left. They are told, and may still reopen it in their window."
        codes={REASON_CODES.ticketStaffClose}
        confirmLabel="Close ticket"
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(code) => close.mutate(code)}
      />
      <ReasonDialog
        open={open === 'reopen'}
        onClose={shut}
        title={`Reopen ${ticket.number}?`}
        description="Within 30 days of closing. It goes back to its technician the first time; your words go to the thread, and the residents are told."
        codes={REASON_CODES.ticketReopen}
        confirmLabel="Reopen"
        textLabel="For the residents and the technician"
        textHint="Posted in the ticket's thread."
        pending={reopen.isPending}
        error={<ErrorAlert error={reopen.error} />}
        onConfirm={(r) => reopen.mutate(r)}
      />
    </>
  );
}
