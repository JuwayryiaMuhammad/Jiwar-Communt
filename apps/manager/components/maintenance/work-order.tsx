'use client';

import { ApiError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, ReasonDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ChecklistRunCard } from '@/components/assets/checklist-run';
import { api } from '@/lib/api';
import { fetchers, keys, type TicketDetail } from '@/lib/queries';
import ar from '@/messages/ar/maint-work-order';
import en from '@/messages/en/maint-work-order';

const ORIGINS = ['plan', 'inspection', 'field', 'staff'] as const;
const isOrigin = (o: string): o is (typeof ORIGINS)[number] => (ORIGINS as readonly string[]).includes(o);

/**
 * A work order of the compound's (ADR 0064): where it came from, its
 * asset, its checklist; once completed, dispatch closes it or sends it
 * back (a resident's ticket is theirs to confirm).
 */
export function WorkOrder({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
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
    { ...refresh, onDone: () => toast.show(t('closed', { number: ticket.number })) },
  );
  const back = useAction(
    (reason: { reasonCode: string; reason: string }) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/send-back', { params: { path: { id: ticket.id } }, body: reason })),
    {
      ...refresh,
      onDone: () => {
        toast.show(t('sentBack', { number: ticket.number }));
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
          title={t('workOrder')}
          actions={
            done ? (
              <span className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="primary" loading={accept.isPending} onClick={() => accept.mutate()}>
                  {t('accept')}
                </Button>
                <Button size="sm" onClick={() => setSending(true)}>
                  {t('sendBack')}
                </Button>
              </span>
            ) : undefined
          }
        />
        <CardBody>
          {isOrigin(ticket.origin) ? <p>{t(`origin.${ticket.origin}`)}</p> : null}
          {ticket.assetId ? (
            <Link className="table__link" href={`/assets/${ticket.assetId}`}>
              {t('openAsset')}
            </Link>
          ) : null}
          <ErrorAlert error={accept.error} />
        </CardBody>
      </Card>
      {checklist.data ? <ChecklistRunCard run={checklist.data} /> : null}
      <ReasonDialog
        open={sending}
        onClose={() => setSending(false)}
        title={t('sendBackTitle')}
        description={t('sendBackDescription')}
        codes={REASON_CODES.ticketReject}
        confirmLabel={t('sendBack')}
        textLabel={t('forTechnician')}
        textHint={t('postedInThread')}
        pending={back.isPending}
        error={<ErrorAlert error={back.error} />}
        onConfirm={(r) => back.mutate(r)}
      />
    </>
  );
}
