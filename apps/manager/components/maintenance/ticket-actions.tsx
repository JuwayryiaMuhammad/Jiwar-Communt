'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, ReasonCodeDialog, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type TicketDetail, type TicketPriority } from '@/lib/queries';
import ar from '@/messages/ar/maint-actions';
import en from '@/messages/en/maint-actions';
import { useTicketWords } from './sla';
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const words = useTicketWords();
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
    { ...refresh, onDone: done(t('assigned', { number: ticket.number })) },
  );
  const autoAssign = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/auto-assign', { params: path })),
    {
      ...refresh,
      onDone: (result) =>
        toast.show(
          result.outcome === 'assigned'
            ? t('autoAssigned', { number: ticket.number, name: words.person(result.technician) })
            : t('noCandidate'),
          result.outcome === 'assigned' ? 'success' : 'error',
        ),
    },
  );
  const reassign = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/reassign', { params: path, body: { technicianId, reasonCode } })),
    { ...refresh, onDone: done(t('reassigned', { number: ticket.number })) },
  );
  const changePriority = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/priority', {
          params: path,
          body: { priority: priority as TicketPriority, reasonCode },
        }),
      ),
    { ...refresh, onDone: done(t('priorityChanged')) },
  );
  const changeCategory = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/category', { params: path, body: { categoryId, reasonCode } })),
    { ...refresh, onDone: done(t('categoryChanged')) },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/cancel', { params: path, body: { reasonCode } })),
    { ...refresh, onDone: done(t('cancelled', { number: ticket.number })) },
  );

  const s = ticket.status;
  if (!CHANGEABLE.includes(s)) return null;

  return (
    <>
      <span className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {s === 'new' ? (
          <>
            <Button variant="primary" onClick={() => setOpen('assign')}>
              {t('assign')}
            </Button>
            <Button loading={autoAssign.isPending} onClick={() => autoAssign.mutate()}>
              {t('autoAssign')}
            </Button>
          </>
        ) : null}
        {IN_HAND.includes(s) ? <Button onClick={() => setOpen('reassign')}>{t('reassign')}</Button> : null}
        <Button onClick={() => setOpen('priority')}>{t('priority')}</Button>
        <Button onClick={() => setOpen('category')}>{t('category')}</Button>
        <Button variant="danger" onClick={() => setOpen('cancel')}>
          {t('cancelTicket')}
        </Button>
      </span>
      <ErrorAlert error={autoAssign.error} />

      <Dialog
        open={open === 'assign'}
        onClose={close}
        title={t('assignTitle', { number: ticket.number })}
        description={t('assignDescription')}
        onSubmit={() => technicianId && assign.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={assign.isPending} disabled={!technicianId}>
              {t('assign')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('technician')}>
            {(p) => <TechnicianPicker {...p} value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} />}
          </Field>
          <ErrorAlert error={assign.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={open === 'reassign'}
        onClose={close}
        title={t('reassignTitle', { number: ticket.number })}
        description={t('reassignDescription', { name: words.person(ticket.technician) })}
        codes={REASON_CODES.ticketReassign}
        confirmLabel={t('reassign')}
        ready={technicianId !== ''}
        pending={reassign.isPending}
        error={<ErrorAlert error={reassign.error} />}
        onConfirm={(code) => reassign.mutate(code)}
      >
        <Field label={t('newTechnician')}>
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
        title={t('priorityTitle')}
        description={t('priorityDescription')}
        codes={REASON_CODES.ticketPriority}
        confirmLabel={t('priorityConfirm')}
        ready={priority !== '' && priority !== ticket.priority}
        pending={changePriority.isPending}
        error={<ErrorAlert error={changePriority.error} />}
        onConfirm={(code) => changePriority.mutate(code)}
      >
        <Field label={t('priority')} hint={t('now', { value: label(ticket.priority) })}>
          {(p) => (
            <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority | '')}>
              <option value="">{c('select')}</option>
              {(['normal', 'urgent', 'emergency'] as const)
                .filter((x) => x !== ticket.priority)
                .map((x) => (
                  <option key={x} value={x}>
                    {label(x)}
                  </option>
                ))}
            </Select>
          )}
        </Field>
      </ReasonCodeDialog>

      <ReasonCodeDialog
        open={open === 'category'}
        onClose={close}
        title={t('categoryTitle')}
        description={t('categoryDescription')}
        codes={REASON_CODES.ticketCategory}
        confirmLabel={t('categoryConfirm')}
        ready={categoryId !== ''}
        pending={changeCategory.isPending}
        error={<ErrorAlert error={changeCategory.error} />}
        onConfirm={(code) => changeCategory.mutate(code)}
      >
        <Field label={t('category')} hint={t('now', { value: ticket.category.nameEn })}>
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{c('select')}</option>
              {(categories.data?.data ?? [])
                .filter((cat) => cat.id !== ticket.category.id && (ticket.unit !== null || cat.commonAreaAllowed))
                .map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.nameEn}
                  </option>
                ))}
            </Select>
          )}
        </Field>
      </ReasonCodeDialog>

      <ReasonCodeDialog
        open={open === 'cancel'}
        onClose={close}
        title={t('cancelTitle', { number: ticket.number })}
        description={t('cancelDescription')}
        codes={REASON_CODES.ticketCancel}
        confirmLabel={t('cancelTicket')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
    </>
  );
}
