'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Segmented, Select, Textarea, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ResidentPicker } from '@/components/pickers';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { fetchers, keys, type TicketPriority } from '@/lib/queries';
import ar from '@/messages/ar/maint-new-ticket';
import en from '@/messages/en/maint-new-ticket';

const ROOMS = ['kitchen', 'bathroom', 'living_room', 'bedroom', 'balcony', 'other'] as const;
type Room = (typeof ROOMS)[number];
const PRIORITIES: TicketPriority[] = ['normal', 'urgent', 'emergency'];

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
 * resident is told and it is audited (ADR 0032). The reporter is someone the
 * API accepts there: for a unit, its occupants and the household members who
 * may open tickets; for a common area, a resident of the compound.
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const [form, setForm] = useState(EMPTY);
  // One key for this form: a retry after a lost answer replays the first, it
  // never opens a second ticket.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const categories = useQuery({ queryKey: keys.ticketCategories, queryFn: fetchers.ticketCategories, enabled: open });
  const unitReporters = useQuery({
    queryKey: keys.ticketReporters(form.unitId),
    queryFn: () => fetchers.ticketReporters(form.unitId),
    enabled: open && form.place === 'unit' && form.unitId !== '',
  });

  const category = categories.data?.data.find((c) => c.id === form.categoryId);
  const usable = (categories.data?.data ?? []).filter((c) => form.place === 'unit' || c.commonAreaAllowed);
  const reporters = (unitReporters.data?.data ?? []).map((r) => ({ id: r.id, name: r.fullName ?? t('resident') }));

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
      title={t('title')}
      description={t('description')}
      onSubmit={() => ready && create.mutate()}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            {t('open')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div>
          <Segmented
            label={t('where')}
            value={form.place}
            onChange={(place) => setForm((f) => ({ ...f, place, reporterId: '', categoryId: '' }))}
            options={[
              { value: 'unit', label: t('place.unit') },
              { value: 'common', label: t('place.common') },
            ]}
          />
        </div>
        {form.place === 'unit' ? (
          <div className="form__row">
            <Field label={t('unit')} error={err('unitId')}>
              {(p) => (
                <UnitPicker
                  {...p}
                  value={form.unitId}
                  onChange={(e) => setForm((f) => ({ ...f, unitId: e.target.value, reporterId: '' }))}
                />
              )}
            </Field>
            <Field label={t('room')} hint={t('roomHint')} error={err('unitLocation')}>
              {(p) => (
                <Select {...p} value={form.room} onChange={(e) => set('room', e.target.value as Room | '')}>
                  <option value="">{t('notGiven')}</option>
                  {ROOMS.map((r) => (
                    <option key={r} value={r}>
                      {label(r)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ) : (
          <Field label={t('commonArea')} hint={t('commonAreaHint')} error={err('commonArea')}>
            {(p) => <Input {...p} maxLength={120} value={form.commonArea} onChange={(e) => set('commonArea', e.target.value)} />}
          </Field>
        )}
        <Field
          label={t('reportedBy')}
          hint={
            form.place === 'unit'
              ? unitReporters.isError
                ? t('reportersFailed')
                : unitReporters.isSuccess && reporters.length === 0
                  ? t('reportersNone')
                  : t('reportersUnit')
              : t('reportersCommon')
          }
          error={err('reporterAccountId')}
        >
          {(p) => (
            form.place === 'unit' ? (
              <Select {...p} value={form.reporterId} disabled={form.unitId === ''} onChange={(e) => set('reporterId', e.target.value)}>
                <option value="">{form.unitId === '' ? t('pickUnitFirst') : t('selectResident')}</option>
                {reporters.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            ) : (
              <ResidentPicker {...p} enabled={open} placeholder={t('selectResident')} value={form.reporterId} onChange={(id) => set('reporterId', id)} />
            )
          )}
        </Field>
        <div className="form__row">
          <Field label={t('category')} error={err('categoryId')}>
            {(p) => (
              <Select {...p} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">{c('select')}</option>
                {usable.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('priority')}
            hint={category ? t('priorityHintOf', { priority: label(category.defaultPriority) }) : t('priorityHint')}
            error={err('priority')}
          >
            {(p) => (
              <Select {...p} value={form.priority} onChange={(e) => set('priority', e.target.value as TicketPriority | '')}>
                <option value="">{t('categoryDefault')}</option>
                {PRIORITIES.map((x) => (
                  <option key={x} value={x}>
                    {label(x)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('whatIsWrong')} error={err('description')}>
          {(p) => (
            <Textarea {...p} maxLength={2000} rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} />
          )}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}
