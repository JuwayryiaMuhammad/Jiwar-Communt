'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  Field,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type Appointment, type AppointmentMode } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-requests';
import en from '@/messages/en/services-mgmt-requests';
import { SlotPicker, useSlotText } from './bits';
import { appointmentActionsFor } from './logic';

type Open = 'propose' | 'cancel' | null;

const WAITS = ['requested', 'proposed', 'confirmed'] as const;
const waits = (status: string): status is (typeof WAITS)[number] => (WAITS as readonly string[]).includes(status);

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
  const t = useT(en, ar);
  const c = useCommonT();
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
    onDone: () => toast.show(t('confirmedToast', { number })),
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
        toast.show(t('proposedToast'));
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
        toast.show(t('apptCancelledToast'));
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
            {c('confirm')}
          </Button>
        ) : null}
        {may.propose ? (
          <Button size="sm" onClick={() => setOpen('propose')}>
            {t(may.proposeLabel)}
          </Button>
        ) : null}
        {may.cancel ? (
          <Button size="sm" variant="danger" onClick={() => setOpen('cancel')}>
            {c('cancel')}
          </Button>
        ) : null}
      </span>
      <ErrorAlert error={confirm.error} />

      <Dialog
        open={open === 'propose'}
        onClose={close}
        title={t(may.proposeLabel === 'proposeAnother' ? 'proposeAnotherTitle' : 'proposeTitle', { number })}
        description={t('proposeDescription')}
        onSubmit={() => startsAt && propose.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={propose.isPending} disabled={!startsAt}>
              {t('proposeSubmit')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('slot')} hint={t('proposeSlotHint')}>
            {(p) => <SlotPicker {...p} enabled={open === 'propose'} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />}
          </Field>
          <Segmented<AppointmentMode>
            label={t('how')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'in_person', label: t('mode.in_person') },
              { value: 'phone', label: t('mode.phone') },
            ]}
          />
          <ErrorAlert error={propose.error} />
        </div>
      </Dialog>

      <ReasonCodeDialog
        open={open === 'cancel'}
        onClose={close}
        title={t('cancelApptTitle', { number })}
        description={t('cancelApptDescription')}
        codes={REASON_CODES.managementAppointmentCancelByStaff}
        confirmLabel={t('cancelAppt')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const slotText = useSlotText();
  return (
    <Card flush>
      <CardHeader title={t('appointment')} />
      <CardBody>
        {appointment ? (
          <dl className="dl">
            <dt>{t('when')}</dt>
            <dd>{slotText(appointment.startsAt, appointment.endsAt)}</dd>
            <dt>{t('how')}</dt>
            <dd>{t(`mode.${appointment.mode}`)}</dd>
            <dt>{c('status')}</dt>
            <dd>
              <StatusBadge status={appointment.status} />
            </dd>
            <dt>{t('pickedBy')}</dt>
            <dd>{t(`pickedBy.${appointment.proposedBy}`)}</dd>
            {appointment.confirmedAt ? (
              <>
                <dt>{t('confirmedAt')}</dt>
                <dd>{fmt.dateTime(appointment.confirmedAt)}</dd>
              </>
            ) : null}
            {appointment.cancelReason ? (
              <>
                <dt>{t('cancelledAt')}</dt>
                <dd>
                  {label(appointment.cancelReason)}
                  {appointment.cancelledBy ? ` · ${t(`cancelledBy.${appointment.cancelledBy}`)}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="t-secondary">{t('noAppointment')}</p>
        )}
        {appointment && waits(appointment.status) ? (
          <p className="t-secondary" style={{ margin: '12px 0' }}>
            {t(`wait.${appointment.status}`)}
          </p>
        ) : null}
        <AppointmentActions requestId={requestId} number={number} requestStatus={requestStatus} appointment={appointment} />
      </CardBody>
    </Card>
  );
}
