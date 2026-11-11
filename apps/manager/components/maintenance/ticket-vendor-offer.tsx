'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, CardHeader, Dialog, Field, ReasonCodeDialog, Textarea, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { VendorPicker } from '@/components/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TicketDetail, type VendorDispatch } from '@/lib/queries';
import ar from '@/messages/ar/maint-vendor-offer';
import en from '@/messages/en/maint-vendor-offer';

/** Who may read the vendor register (the API lists it to these permissions). */
const READ_VENDORS = ['vendors.manage', 'assets.manage', 'finance.budget', 'purchases.request', 'purchases.approve'];

const TONE: Record<VendorDispatch['status'], 'green' | 'beige' | 'terracotta'> = {
  offered: 'beige',
  accepted: 'green',
  declined: 'terracotta',
  withdrawn: 'beige',
  returned: 'terracotta',
};

/**
 * Dispatch offers a queued ticket to an outside vendor (ADR 0088): the offer
 * "to a vendor" with a note, the offers the ticket has had and how each
 * ended, and taking an open one back. The vendor's contractors see the work,
 * never the unit or the residents; the ticket's SLA clock runs on. Needs
 * `tickets.dispatch`.
 */
export function TicketVendorOffer({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { can } = usePermissions();
  const mayDispatch = can('tickets.dispatch');
  const mayListVendors = READ_VENDORS.some((p) => can(p));
  const [open, setOpen] = useState<'offer' | 'withdraw' | null>(null);
  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [note, setNote] = useState('');
  const offers = useQuery({
    queryKey: keys.ticketVendorOffers(ticket.id),
    queryFn: () => fetchers.ticketVendorOffers(ticket.id),
    enabled: mayDispatch,
  });
  const rows = offers.data?.data ?? [];
  const live = rows.find((o) => o.status === 'offered') ?? null;
  // Offered only from the queue: new, with no technician and no offer open.
  const mayOffer = ticket.status === 'new' && !ticket.technician && live === null;
  const refresh = { invalidate: [keys.ticketVendorOffers(ticket.id), keys.ticketsAll] };
  const vendorIds = [...new Set(rows.map((o) => o.vendorId))];
  const names = useQuery({
    queryKey: [...keys.vendorsAll, 'names', vendorIds.join(',')],
    queryFn: async () => {
      const found = new Map<string, string>();
      for (const id of vendorIds) {
        const v = await fetchers.vendor(id);
        found.set(id, `${v.reference} · ${v.name}`);
      }
      return found;
    },
    enabled: mayDispatch && mayListVendors && vendorIds.length > 0,
  });
  const nameOf = (id: string) => names.data?.get(id) ?? t('aVendor');

  const offer = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/vendor-dispatch', {
          params: { path: { id: ticket.id } },
          body: { vendorId, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      ...refresh,
      onDone: () => {
        toast.show(t('offered', { number: ticket.number, vendor: vendorName }));
        close();
      },
    },
  );
  const withdraw = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/vendor-dispatch/withdraw', {
          params: { path: { id: ticket.id } },
          body: { reasonCode },
        }),
      ),
    {
      ...refresh,
      onDone: () => {
        toast.show(t('withdrawn', { number: ticket.number }));
        close();
      },
    },
  );
  function close() {
    setOpen(null);
    setVendorId('');
    setVendorName('');
    setNote('');
    offer.reset();
    withdraw.reset();
  }

  if (!mayDispatch) return null;
  if (!mayOffer && rows.length === 0) return null;

  return (
    <Card flush>
      <CardHeader
        title={t('title')}
        actions={
          mayOffer && mayListVendors ? (
            <Button onClick={() => setOpen('offer')}>{t('offer')}</Button>
          ) : live ? (
            <Button variant="danger" onClick={() => setOpen('withdraw')}>
              {t('withdraw')}
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {live ? <p>{t('liveOffer', { vendor: nameOf(live.vendorId), when: fmt.dateTime(live.offeredAt) })}</p> : null}
        {rows.length ? (
          <ul className="list">
            {rows.map((o) => (
              <li key={o.id} className="list__item" style={{ alignItems: 'flex-start' }}>
                <span className="list__text">
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="list__title">{nameOf(o.vendorId)}</span>
                    <Badge tone={TONE[o.status]}>{label(o.status)}</Badge>
                    {o.declineReason ? <span className="t-secondary">{label(o.declineReason)}</span> : null}
                    {o.withdrawReason ? <span className="t-secondary">{label(o.withdrawReason)}</span> : null}
                  </span>
                  {o.note ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{o.note}</p> : null}
                  <span className="list__meta">
                    {t('offeredAt', { when: fmt.dateTime(o.offeredAt) })}
                    {o.decidedAt ? <> · {t('decidedAt', { when: fmt.dateTime(o.decidedAt) })}</> : null}
                    {o.endedAt && !o.decidedAt ? <> · {t('endedAt', { when: fmt.dateTime(o.endedAt) })}</> : null}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-secondary">{t('none')}</p>
        )}
        {mayOffer && !mayListVendors ? <p className="t-secondary">{t('cannotListVendors')}</p> : null}
      </CardBody>

      <Dialog
        open={open === 'offer'}
        onClose={close}
        title={t('offerTitle', { number: ticket.number })}
        description={t('offerDescription')}
        onSubmit={() => vendorId && offer.mutate(undefined)}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={offer.isPending} disabled={!vendorId}>
              {t('offer')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('vendor')} hint={t('vendorHint')} error={fieldError(offer.error, 'vendorId')}>
            {(p) => (
              <VendorPicker
                {...p}
                value={vendorId}
                enabled={open === 'offer'}
                onChange={(id, text) => {
                  setVendorId(id);
                  setVendorName(text);
                }}
              />
            )}
          </Field>
          <Field label={t('note')} hint={t('noteHint')} error={fieldError(offer.error, 'note')}>
            {(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <ErrorAlert error={offer.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={open === 'withdraw'}
        onClose={close}
        title={t('withdrawTitle', { number: ticket.number })}
        description={t('withdrawDescription')}
        codes={REASON_CODES.vendorDispatchWithdraw}
        confirmLabel={t('withdraw')}
        pending={withdraw.isPending}
        error={<ErrorAlert error={withdraw.error} />}
        onConfirm={(code) => withdraw.mutate(code)}
      />
    </Card>
  );
}
