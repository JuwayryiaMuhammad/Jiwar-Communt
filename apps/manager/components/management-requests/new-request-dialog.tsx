'use client';

import { fieldError, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Checkbox, Dialog, Field, Segmented, Select, Textarea } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { fetchers, keys, type AppointmentMode, type ManagementRequestType } from '@/lib/queries';
import { MODE_TEXT, SlotPicker, TYPE_TEXT } from './bits';

const EMPTY = {
  unitId: '',
  authorId: '',
  aboutUnit: true,
  type: 'general' as ManagementRequestType,
  topicId: '',
  reasonCode: '',
  body: '',
  startsAt: '',
  mode: 'in_person' as AppointmentMode,
};

/**
 * A request opened for a resident who called, came in or wrote (ADR 0039).
 * The resident is its author and sees it; who opened it and why are kept.
 * The resident is picked through their unit: its occupants and the
 * household members with an account. An appointment booked here is
 * confirmed at once, since the resident is at the desk or on the phone.
 */
export function NewRequestDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (request: { id: string; number: string }) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  // One key for this form: a retry after a lost answer replays the first, it
  // never opens a second request.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const topics = useQuery({ queryKey: keys.requestTopicOptions, queryFn: fetchers.requestTopicOptions, enabled: open });
  const authors = useQuery({
    queryKey: keys.requestAuthors(form.unitId),
    queryFn: () => fetchers.requestAuthors(form.unitId),
    enabled: open && form.unitId !== '',
  });

  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/management/requests', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            type: form.type,
            topicId: form.topicId,
            authorAccountId: form.authorId,
            reasonCode: form.reasonCode,
            body: form.body.trim(),
            ...(form.aboutUnit ? { unitId: form.unitId } : {}),
            ...(form.type === 'appointment' ? { appointment: { startsAt: form.startsAt, mode: form.mode } } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.managementAll],
      onDone: (request) => {
        setForm(EMPTY);
        setIdempotencyKey(crypto.randomUUID());
        onCreated(request);
      },
    },
  );

  const close = () => {
    setForm(EMPTY);
    create.reset();
    setIdempotencyKey(crypto.randomUUID());
    onClose();
  };
  const ready =
    form.authorId !== '' &&
    form.topicId !== '' &&
    form.reasonCode !== '' &&
    form.body.trim() !== '' &&
    (form.type !== 'appointment' || form.startsAt !== '');
  const err = (field: string) => fieldError(create.error, field);

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title="Open a request for a resident"
      description="For a resident who called, came in or wrote. They are told, and see the request as their own."
      onSubmit={() => ready && create.mutate()}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            Open request
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label="Unit" hint="To find the resident.">
            {(p) => (
              <UnitPicker
                {...p}
                value={form.unitId}
                onChange={(e) => setForm((f) => ({ ...f, unitId: e.target.value, authorId: '' }))}
              />
            )}
          </Field>
          <Field label="Resident" error={err('authorAccountId')}>
            {(p) => (
              <Select {...p} value={form.authorId} disabled={form.unitId === ''} onChange={(e) => set('authorId', e.target.value)}>
                <option value="">
                  {form.unitId === '' ? 'Pick a unit first' : authors.isPending ? 'Loading…' : authors.data?.data.length ? 'Select…' : 'Nobody with an account lives here'}
                </option>
                {(authors.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName ?? 'Unnamed account'}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Checkbox label="The request is about this unit" checked={form.aboutUnit} onChange={(e) => set('aboutUnit', e.target.checked)} />
        <div className="form__row">
          <Field label="How they reached you" error={err('reasonCode')}>
            {(p) => (
              <Select {...p} value={form.reasonCode} onChange={(e) => set('reasonCode', e.target.value)}>
                <option value="">Select…</option>
                {REASON_CODES.managementRequestOnBehalf.map((code) => (
                  <option key={code} value={code}>
                    {humanize(code)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Topic" error={err('topicId')}>
            {(p) => (
              <Select {...p} value={form.topicId} onChange={(e) => set('topicId', e.target.value)}>
                <option value="">Select…</option>
                {(topics.data?.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Segmented<ManagementRequestType>
          label="Kind"
          value={form.type}
          onChange={(type) => set('type', type)}
          options={(['general', 'question', 'appointment'] as const).map((value) => ({ value, label: TYPE_TEXT[value] }))}
        />
        {form.type === 'appointment' ? (
          <div className="form__row">
            <Field label="Slot" hint="Booked and confirmed at once." error={err('appointment.startsAt')}>
              {(p) => <SlotPicker {...p} enabled={open} value={form.startsAt} onChange={(e) => set('startsAt', e.target.value)} />}
            </Field>
            <Field label="How">
              {(p) => (
                <Select {...p} value={form.mode} onChange={(e) => set('mode', e.target.value as AppointmentMode)}>
                  <option value="in_person">{MODE_TEXT.in_person}</option>
                  <option value="phone">{MODE_TEXT.phone}</option>
                </Select>
              )}
            </Field>
          </div>
        ) : null}
        <Field label="What they asked" hint="Becomes the request's first message, in your name." error={err('body')}>
          {(p) => <Textarea {...p} rows={4} maxLength={4000} value={form.body} onChange={(e) => set('body', e.target.value)} />}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}
