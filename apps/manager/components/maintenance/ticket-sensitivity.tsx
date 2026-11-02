'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Alert, Button, Card, CardHeader, DataTable, ReasonCodeDialog, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type SensitiveRead, type TicketDetail } from '@/lib/queries';

/**
 * Sensitive tickets (ADR 0081): "Mark sensitive" for the dispatch (who
 * loses the ticket at once without `tickets.sensitive`), "Clear" and who
 * read it for the holders. A sensitive ticket says its access is logged.
 */
export function TicketSensitivity({ ticket }: { ticket: TicketDetail }) {
  const toast = useToast();
  const { can } = usePermissions();
  const holder = can('tickets.sensitive');
  const [open, setOpen] = useState(false);
  const set = useAction(
    (code: string) =>
      unwrap(
        api.PUT('/api/v1/maintenance/tickets/{id}/sensitivity', {
          params: { path: { id: ticket.id } },
          body: { sensitive: !ticket.sensitive, reasonCode: code },
        }),
      ),
    {
      invalidate: [keys.ticketsAll],
      onDone: () => {
        toast.show(
          ticket.sensitive
            ? `${ticket.number} is no longer sensitive.`
            : holder
              ? `${ticket.number} is sensitive: only who holds the permission sees it, and every read is logged.`
              : `${ticket.number} is sensitive. You no longer see it.`,
        );
        setOpen(false);
      },
    },
  );
  if (ticket.sensitive && !holder) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{ticket.sensitive ? 'Clear sensitive' : 'Mark sensitive'}</Button>
      <ReasonCodeDialog
        open={open}
        onClose={() => setOpen(false)}
        title={ticket.sensitive ? `Clear ${ticket.number}?` : `Mark ${ticket.number} sensitive?`}
        description={
          ticket.sensitive
            ? 'It goes back to every list of the dispatch.'
            : holder
              ? 'Only who holds “sensitive tickets” sees it among the compound’s tickets; its technician and residents keep it. Every staff read is logged.'
              : 'You will no longer see it: only who holds “sensitive tickets” does. Its technician and residents keep it.'
        }
        codes={ticket.sensitive ? REASON_CODES.ticketSensitiveClear : REASON_CODES.ticketSensitive}
        confirmLabel={ticket.sensitive ? 'Clear' : 'Mark sensitive'}
        pending={set.isPending}
        error={<ErrorAlert error={set.error} />}
        onConfirm={(code) => set.mutate(code)}
      />
    </>
  );
}

/** The banner and the reads' log, on a sensitive ticket, for the holders. */
export function SensitiveReads({ ticket }: { ticket: TicketDetail }) {
  const { can } = usePermissions();
  const holder = can('tickets.sensitive');
  const reads = useCursorList(keys.sensitiveReads(ticket.id), (c) => fetchers.sensitiveReads(ticket.id, c), {
    enabled: ticket.sensitive && holder,
  });
  if (!ticket.sensitive) return null;
  return (
    <>
      <Alert tone="warn">Access to this ticket is logged.</Alert>
      {holder ? (
        <Card flush>
          <CardHeader title="Who read it" />
          <QueryState query={reads}>
            <DataTable<SensitiveRead>
              rows={reads.rows}
              rowKey={(r) => r.id}
              empty="Nobody yet"
              columns={[
                { key: 'at', header: 'When', width: 170, cell: (r) => formatDateTime(r.readAt) },
                { key: 'who', header: 'Who', cell: (r) => r.reader.fullName ?? 'Erased account' },
                { key: 'via', header: 'Where', cell: (r) => humanize(r.via) },
              ]}
            />
            <LoadMore query={reads} />
          </QueryState>
        </Card>
      ) : null}
    </>
  );
}
