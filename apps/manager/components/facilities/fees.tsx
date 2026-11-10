'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Field, Input, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type Facility } from '@/lib/queries';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';
import { validMoney } from './logic';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What a booking costs (ADR 0070): a fee, another at peak times, and the
 * refund cutoff. Owed by the unit through an invoice raised when the
 * booking is confirmed; empty is free. Only what changed is sent.
 */
export function Fees({ facility }: { facility: Facility }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const fees = facility.fees!;
  const [fee, setFee] = useState(fees.feeAmount ?? '');
  const [peak, setPeak] = useState(fees.peakFeeAmount ?? '');
  const [cutoff, setCutoff] = useState(String(fees.refundCutoffHours));
  const money = (v: string) => (v.trim() === '' ? null : v.trim());
  const body = {
    ...(money(fee) !== fees.feeAmount ? { feeAmount: money(fee) } : {}),
    ...(facility.mode === 'bookable' && money(peak) !== fees.peakFeeAmount ? { peakFeeAmount: money(peak) } : {}),
    ...(Number(cutoff) !== fees.refundCutoffHours ? { refundCutoffHours: Number(cutoff) } : {}),
  };
  const ready =
    (fee.trim() === '' || validMoney(fee)) &&
    (peak.trim() === '' || validMoney(peak)) &&
    /^\d{1,3}$/.test(cutoff) &&
    Number(cutoff) <= 168;
  const dirty = Object.keys(body).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/facilities/{id}', { params: { path: { id: facility.id } }, body })), {
    invalidate: [keys.facilitiesAll],
    onDone: () => toast.show(c('saved')),
  });
  return (
    <form
      className="stack"
      style={{ maxWidth: 640 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && ready) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title={t('fees.title')} />
        <CardBody>
          <div className="form">
            <Field
              label={facility.mode === 'stay' ? t('fees.perNight') : t('fees.perBooking')}
              hint={t('fees.hint')}
              error={fieldError(save.error, 'feeAmount')}
            >
              {(p) => <Input {...p} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />}
            </Field>
            {facility.mode === 'bookable' ? (
              <Field label={t('fees.peak')} hint={t('fees.peakHint')} error={fieldError(save.error, 'peakFeeAmount')}>
                {(p) => <Input {...p} inputMode="decimal" value={peak} onChange={(e) => setPeak(e.target.value)} />}
              </Field>
            ) : null}
            <Field
              label={t('fees.cutoff')}
              hint={t('fees.cutoffHint')}
              error={fieldError(save.error, 'refundCutoffHours')}
            >
              {(p) => <Input {...p} inputMode="numeric" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />}
            </Field>
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !ready}>
          {c('save')}
        </Button>
      </span>
    </form>
  );
}

/** A guest room facility's nights (ADR 0070): rooms, times and the longest stay. */
export function StayRules({ facility }: { facility: Facility }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const stay = facility.stay!;
  const [form, setForm] = useState({
    capacity: String(stay.rooms),
    checkInTime: stay.checkInTime,
    checkOutTime: stay.checkOutTime,
    maxNights: String(stay.maxNights),
  });
  const body = {
    ...(Number(form.capacity) !== stay.rooms ? { capacity: Number(form.capacity) } : {}),
    ...(form.checkInTime !== stay.checkInTime ? { checkInTime: form.checkInTime } : {}),
    ...(form.checkOutTime !== stay.checkOutTime ? { checkOutTime: form.checkOutTime } : {}),
    ...(Number(form.maxNights) !== stay.maxNights ? { maxNights: Number(form.maxNights) } : {}),
  };
  const ready =
    /^\d{1,3}$/.test(form.capacity) &&
    Number(form.capacity) >= 1 &&
    HHMM.test(form.checkInTime) &&
    HHMM.test(form.checkOutTime) &&
    /^\d{1,2}$/.test(form.maxNights) &&
    Number(form.maxNights) >= 1 &&
    Number(form.maxNights) <= 14;
  const dirty = Object.keys(body).length > 0;
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/facilities/{id}', { params: { path: { id: facility.id } }, body })), {
    invalidate: [keys.facilitiesAll],
    onDone: () => toast.show(c('saved')),
  });
  const text = (key: keyof typeof form, label: string, hint: string) => (
    <Field label={label} hint={hint} error={fieldError(save.error, key)}>
      {(p) => <Input {...p} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
    </Field>
  );
  return (
    <form
      className="stack"
      style={{ maxWidth: 640 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && ready) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title={t('stay.title')} />
        <CardBody>
          <div className="form">
            {text('capacity', t('stay.rooms'), t('stay.roomsHint'))}
            {text('checkInTime', t('stay.checkIn'), t('stay.checkInHint'))}
            {text('checkOutTime', t('stay.checkOut'), t('stay.checkOutHint'))}
            {text('maxNights', t('stay.maxNights'), t('range', { min: 1, max: 14 }))}
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !ready}>
          {c('save')}
        </Button>
      </span>
    </form>
  );
}
