'use client';

import { fieldError, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Segmented, Select, Textarea } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { fetchers, keys, type TicketPriority } from '@/lib/queries';

const ROOMS = ['kitchen', 'bathroom', 'living_room', 'bedroom', 'balcony', 'other'] as const;
type Room = (typeof ROOMS)[number];

const EMPTY = {
  place: 'unit' as 'unit' | 'common',
  unitId: '',
  room: '' as Room | '',
  commonArea: '',
  reporterId: '',
  categoryId: '',
  priority: '' as TicketPriority | '',
  description: '',
};

/**
 * A ticket opened for a resident who asked in person or by phone. The
 * resident is told and it is audited (ADR 0032). The reporter is one of the
 * unit's occupants; for a common area, a resident of the compound.
 */
export function NewTicketDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (ticket: { id: string; number: string }) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  // One key for this form: a retry after a lost answer replays the first, it
  // never opens a second ticket.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const categories = useQuery({ queryKey: keys.ticketCategories, queryFn: fetchers.ticketCategories, enabled: open });
  const unit = useQuery({
    queryKey: keys.unit(form.unitId),
    queryFn: () => fetchers.unit(form.unitId),
    enabled: open && form.place === 'unit' && form.unitId !== '',
  });
  const residents = useQuery({
    queryKey: [...keys.residents, 'picker'],
    queryFn: () => fetchers.residents(undefined, 100),
    enabled: open && form.place === 'common',
  });

  const category = categories.data?.data.find((c) => c.id === form.categoryId);
  const usable = (categories.data?.data ?? []).filter((c) => form.place === 'unit' || c.commonAreaAllowed);
  const reporters =
    form.place === 'unit'
      ? (unit.data?.occupants ?? []).filter((o) => !o.account.erased).map((o) => ({ id: o.account.id, name: o.account.fullName ?? 'Resident' }))
      : (residents.data?.data ?? []).map((r) => ({ id: r.id, name: r.fullName ?? 'Resident' }));

  const reset = () => {
    setForm(EMPTY);
    setIdempotencyKey(crypto.randomUUID());
    create.reset();
  };
  const close = () => {
    reset();
    onClose();
  };

  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/tickets', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            reporterAccountId: form.reporterId,
            categoryId: form.categoryId,
            description: form.description.trim(),
            ...(form.place === 'unit'
              ? { unitId: form.unitId, ...(form.room ? { unitLocation: form.room } : {}) }
              : { commonArea: form.commonArea.trim() }),
            ...(form.priority ? { priority: form.priority } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.ticketsAll],
      onDone: (ticket) => {
        reset();
        onCreated(ticket);
      },
    },
  );

  const ready =
    form.reporterId !== '' &&
    form.categoryId !== '' &&
    form.description.trim() !== '' &&
    (form.place === 'unit' ? form.unitId !== '' : form.commonArea.trim() !== '');
  const err = (field: string) => fieldError(create.error, field);

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title="New ticket for a resident"
      description="For a resident who asked in person or by phone. They are told a ticket was opened for them."
      onSubmit={() => ready && create.mutate()}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            Open ticket
          </Button>
        </>
      }
    >
      <div className="form">
        <div>
          <Segmented
            label="Where"
            value={form.place}
            onChange={(place) => setForm((f) => ({ ...f, place, reporterId: '', categoryId: '' }))}
            options={[
              { value: 'unit', label: 'In a unit' },
              { value: 'common', label: 'Common area' },
            ]}
          />
        </div>
        {form.place === 'unit' ? (
          <div className="form__row">
            <Field label="Unit" error={err('unitId')}>
              {(p) => (
                <UnitPicker
                  {...p}
                  value={form.unitId}
                  onChange={(e) => setForm((f) => ({ ...f, unitId: e.target.value, reporterId: '' }))}
                />
              )}
            </Field>
            <Field label="Room" hint="Optional." error={err('unitLocation')}>
              {(p) => (
                <Select {...p} value={form.room} onChange={(e) => set('room', e.target.value as Room | '')}>
                  <option value="">Not given</option>
                  {ROOMS.map((r) => (
                    <option key={r} value={r}>
                      {humanize(r)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ) : (
          <Field label="Common area" hint="Where exactly: the gym, the north gate, the pool." error={err('commonArea')}>
            {(p) => <Input {...p} maxLength={120} value={form.commonArea} onChange={(e) => set('commonArea', e.target.value)} />}
          </Field>
        )}
        <Field
          label="Reported by"
          hint={
            form.place === 'unit'
              ? "One of the unit's occupants."
              : 'A resident of the compound (the first 100 by the list’s order).'
          }
          error={err('reporterAccountId')}
        >
          {(p) => (
            <Select
              {...p}
              value={form.reporterId}
              disabled={form.place === 'unit' && form.unitId === ''}
              onChange={(e) => set('reporterId', e.target.value)}
            >
              <option value="">{form.place === 'unit' && form.unitId === '' ? 'Pick a unit first' : 'Select a resident…'}</option>
              {reporters.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form__row">
          <Field label="Category" error={err('categoryId')}>
            {(p) => (
              <Select {...p} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">Select…</option>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Priority"
            hint={category ? `Empty: the category's own (${category.defaultPriority}).` : "Empty: the category's own."}
            error={err('priority')}
          >
            {(p) => (
              <Select {...p} value={form.priority} onChange={(e) => set('priority', e.target.value as TicketPriority | '')}>
                <option value="">Category default</option>
                <option value="normal">Normal</option>
                <option value="urgent">Urgent</option>
                <option value="emergency">Emergency</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="What is wrong" error={err('description')}>
          {(p) => (
            <Textarea {...p} maxLength={2000} rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} />
          )}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}
