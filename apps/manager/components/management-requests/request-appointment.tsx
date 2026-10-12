'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Dialog, Field, ReasonCodeDialog, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type Appointment, type AppointmentMode } from '@/lib/queries';
import { MODE_TEXT, SlotPicker, slotText } from './bits';
import { appointmentActionsFor } from './logic';

type Open = 'propose' | 'cancel' | null;

const WAITS: Record<string, string> = {
  requested: 'The resident picked this slot. Confirm it, or propose another.',
  proposed: 'Proposed by the management: waiting for the resident to accept or pick another.',
  confirmed: 'Agreed by both sides.',
};

/**
 * An appointment request's slot and what staff may do with it: confirm the
 * resident's pick, propose another slot (the resident accepts or picks
 * again), or cancel with a reason. Confirming and proposing count as the
 * management's response to the request.
 */
export function AppointmentActions({
  requestId,
  number,
  requestStatus,
  appointment,
  compact,
}: {
  requestId: string;
  number: string;
  requestStatus: string;
  appointment: Appointment | null;
  /** Buttons only, for a table row. */
  compact?: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const [startsAt, setStartsAt] = useState('');
  const [mode, setMode] = useState<AppointmentMode>(appointment?.mode ?? 'in_person');
  // One key per proposal: a retry replays the first, it never books twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const path = { path: { id: requestId } };
  const refresh = { invalidate: [keys.managementAll] };
  const may = appointmentActionsFor(requestStatus, appointment?.status ?? null);

  const close = () => {
    setOpen(null);
    setStartsAt('');
    for (const a of [propose, cancel]) a.reset();
  };
  const confirm = useAction(() => unwrap(api.POST('/api/v1/management/requests/{id}/appointment/confirm', { params: path })), {
    ...refresh,
    onDone: () => toast.show(`The appointment of ${number} is confirmed.`),
  });
  const propose = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/management/requests/{id}/appointment/propose', {
          params: { ...path, header: { 'Idempotency-Key': idempotencyKey } },
          body: { startsAt, mode },
        }),
      ),
    {
      ...refresh,
      onDone: () => {
        toast.show('The slot was proposed to the resident.');
        setIdempotencyKey(crypto.randomUUID());
        close();
      },
    },
  );
  const cancel = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/management/requests/{id}/appointment/cancel', { params: path, body: { reasonCode } })),
    {
      ...refresh,
      onDone: () => {
        toast.show('The appointment is cancelled.');
        close();
      },
    },
  );

  if (!may.confirm && !may.propose && !may.cancel) return null;
  return (
    <>
      <span className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: compact ? 'flex-end' : undefined }}>
        {may.confirm ? (
          <Button size="sm" variant="primary" loading={confirm.isPending} onClick={() => confirm.mutate()}>
            Confirm
          </Button>
        ) : null}
        {may.propose ? (
          <Button size="sm" onClick={() => setOpen('propose')}>
            {may.proposeLabel}
          </Button>
        ) : null}
        {may.cancel ? (
          <Button size="sm" variant="danger" onClick={() => setOpen('cancel')}>
            Cancel
          </Button>
        ) : null}
      </span>
      <ErrorAlert error={confirm.error} />

      <Dialog
        open={open === 'propose'}
        onClose={close}
        title={`${may.proposeLabel} for ${number}`}
        description="The resident is told, and accepts it or picks another slot. Until then the slot is held."
        onSubmit={() => startsAt && propose.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={propose.isPending} disabled={!startsAt}>
              Propose
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Slot" hint="From the office hours, in your time zone.">
            {(p) => <SlotPicker {...p} enabled={open === 'propose'} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />}
          </Field>
          <Segmented<AppointmentMode>
            label="How"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'in_person', label: MODE_TEXT.in_person },
              { value: 'phone', label: MODE_TEXT.phone },
            ]}
          />
          <ErrorAlert error={propose.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={open === 'cancel'}
        onClose={close}
        title={`Cancel the appointment of ${number}?`}
        description="The resident is told and the slot is free again. The request itself stays open."
        codes={REASON_CODES.managementAppointmentCancelByStaff}
        confirmLabel="Cancel appointment"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
    </>
  );
}

/** The appointment of a request, on its page. */
export function RequestAppointment({
  requestId,
  number,
  requestStatus,
  appointment,
}: {
  requestId: string;
  number: string;
  requestStatus: string;
  appointment: Appointment | null;
}) {
  return (
    <Card flush>
      <CardHeader title="Appointment" />
      <CardBody>
        {appointment ? (
          <dl className="dl">
            <dt>When</dt>
            <dd>{slotText(appointment.startsAt, appointment.endsAt)}</dd>
            <dt>How</dt>
            <dd>{MODE_TEXT[appointment.mode]}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={appointment.status} />
            </dd>
            <dt>Picked by</dt>
            <dd>{appointment.proposedBy === 'staff' ? 'The management' : 'The resident'}</dd>
            {appointment.confirmedAt ? (
              <>
                <dt>Confirmed</dt>
                <dd>{formatDateTime(appointment.confirmedAt)}</dd>
              </>
            ) : null}
            {appointment.cancelReason ? (
              <>
                <dt>Cancelled</dt>
                <dd>
                  {humanize(appointment.cancelReason)}
                  {appointment.cancelledBy ? ` · by ${appointment.cancelledBy === 'staff' ? 'the management' : `the ${appointment.cancelledBy}`}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="t-secondary">No appointment yet.</p>
        )}
        {appointment && WAITS[appointment.status] ? (
          <p className="t-secondary" style={{ margin: '12px 0' }}>
            {WAITS[appointment.status]}
          </p>
        ) : null}
        <AppointmentActions requestId={requestId} number={number} requestStatus={requestStatus} appointment={appointment} />
      </CardBody>
    </Card>
  );
}
