'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, Input, ReasonCodeDialog, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type TicketDetail, type Visit } from '@/lib/queries';
import { personName } from './sla';

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
  return (
    <div className="form__row">
      <Field label="From" hint="At least 15 minutes from now." error={fieldError(error, 'startsAt')}>
        {(p) => <Input {...p} type="datetime-local" value={startsAt} onChange={(e) => onChange({ startsAt: e.target.value, endsAt })} />}
      </Field>
      <Field label="To" hint="At most 4 hours later." error={fieldError(error, 'endsAt')}>
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
    options('Visit proposed. The resident is asked to confirm.'),
  );
  const counter = useAction(
    (visit: Visit) =>
      unwrap(api.POST('/api/v1/maintenance/tickets/{id}/visits/{visitId}/counter', { params: at(visit), body: range() })),
    options('Another window proposed.'),
  );
  const confirm = useAction(
    (visit: Visit) => unwrap(api.POST('/api/v1/maintenance/tickets/{id}/visits/{visitId}/confirm', { params: at(visit) })),
    options('Visit confirmed.'),
  );
  const reschedule = useAction(
    (v: { visit: Visit; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/visits/{visitId}/reschedule', {
          params: at(v.visit),
          body: { ...range(), reasonCode: v.reasonCode },
        }),
      ),
    options('Visit rescheduled. The resident is asked to confirm the new window.'),
  );
  const cancel = useAction(
    (v: { visit: Visit; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets/{id}/visits/{visitId}/cancel', {
          params: at(v.visit),
          body: { reasonCode: v.reasonCode },
        }),
      ),
    options('Visit cancelled.'),
  );

  const rows = visits.data?.data;
  const canPropose =
    ticket.unit !== null && IN_HAND.includes(ticket.status) && !(rows ?? []).some((v) => ACTIVE.includes(v.status));
  const windowReady = window.startsAt !== '' && window.endsAt !== '';
  const visit = pending && pending.kind !== 'propose' ? pending.visit : null;

  return (
    <Card flush>
      <CardHeader
        title="Visits"
        actions={
          canPropose ? (
            <Button size="sm" onClick={() => setPending({ kind: 'propose' })}>
              Propose a visit
            </Button>
          ) : null
        }
      />
      <QueryState query={visits} rows={2}>
        <DataTable<Visit>
          rows={rows}
          rowKey={(v) => v.id}
          empty="No visit yet"
          emptyHint={
            ticket.unit === null
              ? 'Visits are for tickets in a unit.'
              : 'A visit is proposed by the technician or dispatch once the ticket is assigned, and confirmed by the resident.'
          }
          columns={[
            {
              key: 'window',
              header: 'Window',
              cell: (v) => (
                <span>
                  {formatDateTime(v.startsAt)}
                  <span className="t-secondary"> to {formatDateTime(v.endsAt).slice(-5)}</span>
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (v) => (
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <StatusBadge status={v.status} />
                  {v.status === 'proposed' ? (
                    <span className="t-secondary">
                      {v.proposedBySide === 'resident' ? 'by the resident: yours to answer' : 'by maintenance: the resident answers'}
                    </span>
                  ) : null}
                  {v.lateNotifiedAt && v.status === 'confirmed' ? <Badge tone="terracotta">Late</Badge> : null}
                  {v.cancelReasonCode ? <span className="t-secondary">{humanize(v.cancelReasonCode)}</span> : null}
                </span>
              ),
            },
            { key: 'technician', header: 'Technician', cell: (v) => personName(v.technician) },
            {
              key: 'access',
              header: 'Access',
              cell: (v) =>
                v.receiver ? (
                  <span title={`Receiver: ${v.receiver.kind}`}>Received by {v.receiver.fullName ?? 'someone at home'}</span>
                ) : v.absenceEntry.approved ? (
                  <span title={v.absenceEntry.grantedBy ? `Granted by ${personName(v.absenceEntry.grantedBy)}` : undefined}>
                    May enter while away
                  </span>
                ) : (
                  <span className="t-secondary">Resident at home</span>
                ),
            },
            {
              key: 'actions',
              header: <span className="visually-hidden">Actions</span>,
              className: 'table__actions',
              cell: (v) => (
                <span className="row" style={{ justifyContent: 'flex-end' }}>
                  {v.status === 'proposed' && v.proposedBySide === 'resident' ? (
                    <>
                      <Button size="sm" variant="primary" onClick={() => setPending({ kind: 'confirm', visit: v })}>
                        Confirm
                      </Button>
                      <Button size="sm" onClick={() => setPending({ kind: 'counter', visit: v })}>
                        Other time
                      </Button>
                    </>
                  ) : null}
                  {v.status === 'confirmed' ? (
                    <Button size="sm" onClick={() => setPending({ kind: 'reschedule', visit: v })}>
                      Reschedule
                    </Button>
                  ) : null}
                  {v.status === 'proposed' || v.status === 'confirmed' ? (
                    <Button size="sm" onClick={() => setPending({ kind: 'cancel', visit: v })}>
                      Cancel
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
        title={pending?.kind === 'counter' ? 'Propose another window' : 'Propose a visit'}
        description={
          pending?.kind === 'counter'
            ? "The resident's proposal is replaced by this one, for them to confirm."
            : `For ${personName(ticket.technician)}, inside the compound's visiting hours. The resident confirms it.`
        }
        onSubmit={() => {
          if (!windowReady) return;
          if (pending?.kind === 'counter') counter.mutate(pending.visit);
          else propose.mutate();
        }}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={propose.isPending || counter.isPending} disabled={!windowReady}>
              Propose
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
        title="Confirm the resident's window?"
        description={visit ? `${formatDateTime(visit.startsAt)} to ${formatDateTime(visit.endsAt).slice(-5)}, for ${personName(visit.technician)}.` : undefined}
        onSubmit={() => visit && confirm.mutate(visit)}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={confirm.isPending}>
              Confirm visit
            </Button>
          </>
        }
      >
        <ErrorAlert error={confirm.error} />
      </Dialog>

      <ReasonCodeDialog
        open={pending?.kind === 'reschedule'}
        onClose={close}
        title="Reschedule the visit"
        description="The agreed visit ends and the new window goes to the resident to confirm. Their consent to enter while away does not carry over."
        codes={REASON_CODES.visitChange}
        confirmLabel="Reschedule"
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
        title="Cancel the visit?"
        description="The resident and the technician are told. The ticket stays as it is."
        codes={REASON_CODES.visitChange}
        confirmLabel="Cancel visit"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => visit && cancel.mutate({ visit, reasonCode })}
      />
    </Card>
  );
}
