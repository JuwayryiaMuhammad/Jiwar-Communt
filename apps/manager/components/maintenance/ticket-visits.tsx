'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, Input, ReasonCodeDialog, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type TicketDetail, type Visit } from '@/lib/queries';
import ar from '@/messages/ar/ticket-visits';
import en from '@/messages/en/ticket-visits';
import { useTicketWords } from './sla';

const IN_HAND = ['assigned', 'en_route', 'in_progress', 'on_hold'];
const ACTIVE = ['proposed', 'confirmed', 'arrived'];

type Pending =
  | { kind: 'propose' }
  | { kind: 'counter' | 'reschedule' | 'cancel' | 'confirm'; visit: Visit }
  | null;

/** `datetime-local` holds local wall time; the API takes an instant. */
const toIso = (local: string) => (local ? new Date(local).toISOString() : '');

function WindowFields({
  startsAt,
  endsAt,
  onChange,
  error,
}: {
  startsAt: string;
  endsAt: string;
  onChange: (next: { startsAt: string; endsAt: string }) => void;
  error: unknown;
}) {
  const t = useT(en, ar);
  return (
    <div className="form__row">
      <Field label={t('from')} hint={t('fromHint')} error={fieldError(error, 'startsAt')}>
        {(p) => <Input {...p} type="datetime-local" value={startsAt} onChange={(e) => onChange({ startsAt: e.target.value, endsAt })} />}
      </Field>
      <Field label={t('to')} hint={t('toHint')} error={fieldError(error, 'endsAt')}>
        {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => onChange({ startsAt, endsAt: e.target.value })} />}
      </Field>
    </div>
  );
}

/**
 * The ticket's visits (ADR 0034). Dispatch acts on the technician's side: it
 * proposes a window, answers the resident's proposal, and reschedules or
 * cancels an agreed visit. Arriving and finishing are the technician's own.
 */
export function TicketVisits({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const label = useLabel();
  const f = useFormat();
  const words = useTicketWords();
  const toast = useToast();
  const [pending, setPending] = useState<Pending>(null);
  const [window, setWindow] = useState({ startsAt: '', endsAt: '' });
  const key = keys.ticketPart(ticket.id, 'visits');
  const visits = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/tickets/{id}/visits', { params: { path: { id: ticket.id } } })),
    refetchInterval: 60_000,
  });

  const close = () => {
    setPending(null);
    setWindow({ startsAt: '', endsAt: '' });
    for (const a of [propose, counter, reschedule, cancel, confirm]) a.reset();
  };
  const options = (text: string) => ({
    invalidate: [keys.ticketsAll],
    onDone: () => {
      toast.show(text);
      close();
    },
  });
  const range = () => ({ startsAt: toIso(window.startsAt), endsAt: toIso(window.endsAt) });
  const at = (visit: Visit) => ({ path: { id: ticket.id, visitId: visit.id } });

  const propose = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/visits', { params: { path: { id: ticket.id } }, body: range() })),
    options(t('proposed')),
  );
  const counter = useAction(
    (visit: Visit) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/visits/{visitId}/counter', { params: at(visit), body: range() })),
    options(t('counterProposed')),
  );
  const confirm = useAction(
    (visit: Visit) => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/visits/{visitId}/confirm', { params: at(visit) })),
    options(t('confirmed')),
  );
  const reschedule = useAction(
    (v: { visit: Visit; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/visits/{visitId}/reschedule', {
          params: at(v.visit),
          body: { ...range(), reasonCode: v.reasonCode },
        }),
      ),
    options(t('rescheduled')),
  );
  const cancel = useAction(
    (v: { visit: Visit; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/visits/{visitId}/cancel', {
          params: at(v.visit),
          body: { reasonCode: v.reasonCode },
        }),
      ),
    options(t('cancelled')),
  );

  const rows = visits.data?.data;
  const canPropose =
    ticket.unit !== null && IN_HAND.includes(ticket.status) && !(rows ?? []).some((v) => ACTIVE.includes(v.status));
  const windowReady = window.startsAt !== '' && window.endsAt !== '';
  const visit = pending && pending.kind !== 'propose' ? pending.visit : null;
  const windowText = (v: Visit) => t('windowRange', { from: f.dateTime(v.startsAt), to: f.time(v.endsAt) });

  return (
    <Card flush>
      <CardHeader
        title={t('visits')}
        actions={
          canPropose ? (
            <Button size="sm" onClick={() => setPending({ kind: 'propose' })}>
              {t('proposeVisit')}
            </Button>
          ) : null
        }
      />
      <QueryState query={visits} rows={2}>
        <DataTable<Visit>
          rows={rows}
          rowKey={(v) => v.id}
          empty={t('empty')}
          emptyHint={
            ticket.unit === null ? t('emptyNoUnit') : t('emptyHint')
          }
          columns={[
            {
              key: 'window',
              header: t('col.window'),
              cell: (v) => <span>{windowText(v)}</span>,
            },
            {
              key: 'status',
              header: t('col.status'),
              cell: (v) => (
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <StatusBadge status={v.status} />
                  {v.status === 'proposed' ? (
                    <span className="t-secondary">
                      {v.proposedBySide === 'resident' ? t('byResident') : t('byMaintenance')}
                    </span>
                  ) : null}
                  {v.lateNotifiedAt && v.status === 'confirmed' ? <Badge tone="terracotta">{t('late')}</Badge> : null}
                  {v.cancelReasonCode ? <span className="t-secondary">{label(v.cancelReasonCode)}</span> : null}
                </span>
              ),
            },
            { key: 'technician', header: t('col.technician'), cell: (v) => words.person(v.technician) },
            {
              key: 'access',
              header: t('col.access'),
              cell: (v) =>
                v.receiver ? (
                  <span title={t('receiverTitle', { kind: label(v.receiver.kind) })}>
                    {t('receivedBy', { name: v.receiver.fullName ?? t('someoneAtHome') })}
                  </span>
                ) : v.absenceEntry.approved ? (
                  <span title={v.absenceEntry.grantedBy ? t('grantedBy', { name: words.person(v.absenceEntry.grantedBy) }) : undefined}>
                    {t('mayEnter')}
                  </span>
                ) : (
                  <span className="t-secondary">{t('atHome')}</span>
                ),
            },
            {
              key: 'actions',
              header: <span className="visually-hidden">{common('actions')}</span>,
              className: 'table__actions',
              cell: (v) => (
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  {v.status === 'proposed' && v.proposedBySide === 'resident' ? (
                    <>
                      <Button size="sm" variant="primary" onClick={() => setPending({ kind: 'confirm', visit: v })}>
                        {t('confirm')}
                      </Button>
                      <Button size="sm" onClick={() => setPending({ kind: 'counter', visit: v })}>
                        {t('otherTime')}
                      </Button>
                    </>
                  ) : null}
                  {v.status === 'confirmed' ? (
                    <Button size="sm" onClick={() => setPending({ kind: 'reschedule', visit: v })}>
                      {t('reschedule')}
                    </Button>
                  ) : null}
                  {v.status === 'proposed' || v.status === 'confirmed' ? (
                    <Button size="sm" onClick={() => setPending({ kind: 'cancel', visit: v })}>
                      {common('cancel')}
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </QueryState>

      <Dialog
        open={pending?.kind === 'propose' || pending?.kind === 'counter'}
        onClose={close}
        title={pending?.kind === 'counter' ? t('proposeAnother') : t('proposeVisit')}
        description={
          pending?.kind === 'counter'
            ? t('counterDescription')
            : t('proposeDescription', { name: words.person(ticket.technician) })
        }
        onSubmit={() => {
          if (!windowReady) return;
          if (pending?.kind === 'counter') counter.mutate(pending.visit);
          else propose.mutate();
        }}
        footer={
          <>
            <Button onClick={close}>{common('cancel')}</Button>
            <Button type="submit" variant="primary" loading={propose.isPending || counter.isPending} disabled={!windowReady}>
              {t('propose')}
            </Button>
          </>
        }
      >
        <div className="form">
          <WindowFields {...window} onChange={setWindow} error={propose.error ?? counter.error} />
          <ErrorAlert error={propose.error ?? counter.error} />
        </div>
      </Dialog>

      <Dialog
        open={pending?.kind === 'confirm'}
        onClose={close}
        title={t('confirmTitle')}
        description={visit ? t('confirmDescription', { window: windowText(visit), name: words.person(visit.technician) }) : undefined}
        onSubmit={() => visit && confirm.mutate(visit)}
        footer={
          <>
            <Button onClick={close}>{common('cancel')}</Button>
            <Button type="submit" variant="primary" loading={confirm.isPending}>
              {t('confirmVisit')}
            </Button>
          </>
        }
      >
        <ErrorAlert error={confirm.error} />
      </Dialog>

      <ReasonCodeDialog
        open={pending?.kind === 'reschedule'}
        onClose={close}
        title={t('rescheduleTitle')}
        description={t('rescheduleDescription')}
        codes={REASON_CODES.visitChange}
        confirmLabel={t('reschedule')}
        ready={windowReady}
        pending={reschedule.isPending}
        error={<ErrorAlert error={reschedule.error} />}
        onConfirm={(reasonCode) => visit && reschedule.mutate({ visit, reasonCode })}
      >
        <WindowFields {...window} onChange={setWindow} error={reschedule.error} />
      </ReasonCodeDialog>

      <ReasonCodeDialog
        open={pending?.kind === 'cancel'}
        onClose={close}
        title={t('cancelTitle')}
        description={t('cancelDescription')}
        codes={REASON_CODES.visitChange}
        confirmLabel={t('cancelVisit')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => visit && cancel.mutate({ visit, reasonCode })}
      />
    </Card>
  );
}
