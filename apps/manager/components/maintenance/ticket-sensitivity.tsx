'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardHeader, DataTable, ReasonCodeDialog, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type SensitiveRead, type TicketDetail } from '@/lib/queries';
import ar from '@/messages/ar/maint-actions';
import en from '@/messages/en/maint-actions';

/**
 * Sensitive tickets (ADR 0081): "Mark sensitive" for the dispatch (who
 * loses the ticket at once without `tickets.sensitive`), "Clear" and who
 * read it for the holders. A sensitive ticket says its access is logged.
 */
export function TicketSensitivity({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
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
            ? t('notSensitive', { number: ticket.number })
            : holder
              ? t('sensitiveHolder', { number: ticket.number })
              : t('sensitiveGone', { number: ticket.number }),
        );
        setOpen(false);
      },
    },
  );
  if (ticket.sensitive && !holder) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{ticket.sensitive ? t('clearSensitive') : t('markSensitive')}</Button>
      <ReasonCodeDialog
        open={open}
        onClose={() => setOpen(false)}
        title={ticket.sensitive ? t('clearTitle', { number: ticket.number }) : t('markTitle', { number: ticket.number })}
        description={ticket.sensitive ? t('clearDescription') : holder ? t('markDescriptionHolder') : t('markDescription')}
        codes={ticket.sensitive ? REASON_CODES.ticketSensitiveClear : REASON_CODES.ticketSensitive}
        confirmLabel={ticket.sensitive ? t('clear') : t('markSensitive')}
        pending={set.isPending}
        error={<ErrorAlert error={set.error} />}
        onConfirm={(code) => set.mutate(code)}
      />
    </>
  );
}

/** The banner and the reads' log, on a sensitive ticket, for the holders. */
export function SensitiveReads({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { can } = usePermissions();
  const holder = can('tickets.sensitive');
  const reads = useCursorList(keys.sensitiveReads(ticket.id), (c) => fetchers.sensitiveReads(ticket.id, c), {
    enabled: ticket.sensitive && holder,
  });
  if (!ticket.sensitive) return null;
  return (
    <>
      <Alert tone="warn">{t('logged')}</Alert>
      {holder ? (
        <Card flush>
          <CardHeader title={t('whoRead')} />
          <QueryState query={reads}>
            <DataTable<SensitiveRead>
              rows={reads.rows}
              rowKey={(r) => r.id}
              empty={t('nobody')}
              columns={[
                { key: 'at', header: t('col.when'), width: 170, cell: (r) => fmt.dateTime(r.readAt) },
                { key: 'who', header: t('col.who'), cell: (r) => r.reader.fullName ?? t('erased') },
                { key: 'via', header: t('col.where'), cell: (r) => label(r.via) },
              ]}
            />
            <LoadMore query={reads} />
          </QueryState>
        </Card>
      ) : null}
    </>
  );
}
