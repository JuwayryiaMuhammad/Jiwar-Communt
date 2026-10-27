'use client';

import { ApiError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, ReasonDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ChecklistRunCard } from '@/components/assets/checklist-run';
import { api } from '@/lib/api';
import { fetchers, keys, type TicketDetail } from '@/lib/queries';

const ORIGIN_TEXT: Record<string, string> = {
  plan: 'A maintenance plan opened it',
  inspection: 'An inspection’s finding opened it',
  field: 'A technician reported it on site',
};

/**
 * A work order of the compound's (ADR 0064): where it came from, its
 * asset, its checklist; once completed, dispatch closes it or sends it
 * back (a resident's ticket is theirs to confirm).
 */
export function WorkOrder({ ticket }: { ticket: TicketDetail }) {
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const checklist = useQuery({
    queryKey: keys.ticketChecklist(ticket.id),
    queryFn: () => fetchers.ticketChecklist(ticket.id),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const refresh = { invalidate: [keys.ticketsAll] };
  const accept = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/accept-work', { params: { path: { id: ticket.id } } })),
    { ...refresh, onDone: () => toast.show(`${ticket.number} is closed.`) },
  );
  const back = useAction(
    (reason: { reasonCode: string; reason: string }) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/send-back', { params: { path: { id: ticket.id } }, body: reason })),
    {
      ...refresh,
      onDone: () => {
        toast.show(`${ticket.number} went back to the technician.`);
        setSending(false);
      },
    },
  );
  if (ticket.origin === 'resident') return null;
  const done = ticket.status === 'completed' && ticket.confirmationStatus === 'pending';
  return (
    <>
      <Card flush>
        <CardHeader
          title="Work order"
          actions={
            done ? (
              <span className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="primary" loading={accept.isPending} onClick={() => accept.mutate()}>
                  Accept the work
                </Button>
                <Button size="sm" onClick={() => setSending(true)}>
                  Send back
                </Button>
              </span>
            ) : undefined
          }
        />
        <CardBody>
          <p>{ORIGIN_TEXT[ticket.origin]}.</p>
          {ticket.assetId ? (
            <Link className="table__link" href={`/assets/${ticket.assetId}`}>
              Open the asset
            </Link>
          ) : null}
          <ErrorAlert error={accept.error} />
        </CardBody>
      </Card>
      {checklist.data ? <ChecklistRunCard run={checklist.data} /> : null}
      <ReasonDialog
        open={sending}
        onClose={() => setSending(false)}
        title="Send the work back"
        description="The technician reads why in the ticket's thread."
        codes={REASON_CODES.ticketReject}
        confirmLabel="Send back"
        textLabel="For the technician"
        textHint="Posted in the ticket's thread."
        pending={back.isPending}
        error={<ErrorAlert error={back.error} />}
        onConfirm={(r) => back.mutate(r)}
      />
    </>
  );
}
