'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, ReasonCodeDialog, ReasonDialog, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type TicketDetail } from '@/lib/queries';
import ar from '@/messages/ar/maint-actions';
import en from '@/messages/en/maint-actions';

/**
 * Dispatch's own moves (ADR 0076): close a resident's completed ticket on
 * their behalf, reopen a closed ticket within 30 days, resume a ticket on
 * hold in its technician's hands. Shown only from the statuses that allow
 * each; a compound's work order is accepted instead of closed.
 */
export function TicketStaffMoves({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
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
        toast.show(t('closedForResidents', { number: ticket.number }));
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
        toast.show(t('reopened', { number: ticket.number }));
        shut();
      },
    },
  );
  const resume = useAction(() => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/resume', { params: path })), {
    ...refresh,
    onDone: () => toast.show(t('resumed', { number: ticket.number })),
  });

  const closable = ticket.status === 'completed' && ticket.origin === 'resident';
  if (!closable && ticket.status !== 'closed' && ticket.status !== 'on_hold') return null;

  return (
    <>
      <span className="row" style={{ gap: 6 }}>
        {closable ? <Button onClick={() => setOpen('close')}>{t('closeForResidents')}</Button> : null}
        {ticket.status === 'closed' ? <Button onClick={() => setOpen('reopen')}>{t('reopen')}</Button> : null}
        {ticket.status === 'on_hold' ? (
          <Button loading={resume.isPending} onClick={() => resume.mutate()}>
            {t('resume')}
          </Button>
        ) : null}
      </span>
      <ErrorAlert error={resume.error} />
      <ReasonCodeDialog
        open={open === 'close'}
        onClose={shut}
        title={t('closeTitle', { number: ticket.number })}
        description={t('closeDescription')}
        codes={REASON_CODES.ticketStaffClose}
        confirmLabel={t('closeConfirm')}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(code) => close.mutate(code)}
      />
      <ReasonDialog
        open={open === 'reopen'}
        onClose={shut}
        title={t('reopenTitle', { number: ticket.number })}
        description={t('reopenDescription')}
        codes={REASON_CODES.ticketReopen}
        confirmLabel={t('reopen')}
        textLabel={t('reopenText')}
        textHint={t('postedInThread')}
        pending={reopen.isPending}
        error={<ErrorAlert error={reopen.error} />}
        onConfirm={(r) => reopen.mutate(r)}
      />
    </>
  );
}
