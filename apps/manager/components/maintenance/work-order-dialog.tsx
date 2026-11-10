'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Segmented, Select, Textarea, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type TicketPriority } from '@/lib/queries';
import ar from '@/messages/ar/maint-work-order';
import en from '@/messages/en/maint-work-order';

const PRIORITIES: TicketPriority[] = ['emergency', 'urgent', 'normal'];

const EMPTY = {
  place: 'asset' as 'asset' | 'area',
  assetId: '',
  commonAreaId: '',
  categoryId: '',
  priority: '' as TicketPriority | '',
  description: '',
};

/**
 * A work order of the compound's own (ADR 0076): a fault seen on a walk, a
 * device, a meter's spike. On an asset or a common area; dispatched like
 * any repair and measured by the SLA. `meterAlertId` comes from an energy
 * alert's page, which opens this with it.
 */
export function WorkOrderDialog({
  open,
  onClose,
  onCreated,
  meterAlertId,
  assetId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (ticket: { id: string; number: string }) => void;
  meterAlertId?: string;
  assetId?: string;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const [form, setForm] = useState({ ...EMPTY, assetId: assetId ?? '' });
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const categories = useQuery({ queryKey: keys.ticketCategories, queryFn: fetchers.ticketCategories, enabled: open });
  const assets = useQuery({
    queryKey: keys.assets({ status: 'in_service', picker: true }),
    queryFn: () => fetchers.assets({ status: 'in_service' }, undefined, 100),
    enabled: open && form.place === 'asset' && !assetId,
  });
  const areas = useQuery({
    queryKey: keys.areas({ active: 'true', picker: true }),
    queryFn: () => fetchers.areas({ active: 'true' }),
    enabled: open && form.place === 'area',
  });

  const reset = () => {
    setForm({ ...EMPTY, assetId: assetId ?? '' });
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
        api.POST('/api/v1/maintenance/work-orders', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            categoryId: form.categoryId,
            description: form.description.trim(),
            ...(form.place === 'asset' && form.assetId ? { assetId: form.assetId } : {}),
            ...(form.place === 'area' && form.commonAreaId ? { commonAreaId: form.commonAreaId } : {}),
            ...(meterAlertId ? { meterAlertId } : {}),
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

  const placed = form.place === 'asset' ? form.assetId !== '' : form.commonAreaId !== '';
  const ready = form.categoryId !== '' && form.description.trim() !== '' && (placed || Boolean(meterAlertId));
  const err = (field: string) => fieldError(create.error, field);

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={t('title')}
      description={meterAlertId ? t('descriptionAlert') : t('description')}
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
        {assetId ? null : (
          <div>
            <Segmented
              label={t('on')}
              value={form.place}
              onChange={(place) => setForm((f) => ({ ...f, place }))}
              options={[
                { value: 'asset', label: t('place.asset') },
                { value: 'area', label: t('place.area') },
              ]}
            />
          </div>
        )}
        {assetId ? null : form.place === 'asset' ? (
          <Field label={t('asset')} error={err('assetId')}>
            {(p) => (
              <Select {...p} value={form.assetId} onChange={(e) => set('assetId', e.target.value)}>
                <option value="">{meterAlertId ? t('theMeters') : t('chooseAsset')}</option>
                {(assets.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field label={t('commonArea')} error={err('commonAreaId')}>
            {(p) => (
              <Select {...p} value={form.commonAreaId} onChange={(e) => set('commonAreaId', e.target.value)}>
                <option value="">{meterAlertId ? t('theMeters') : t('chooseArea')}</option>
                {(areas.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('category')} error={err('categoryId')}>
          {(p) => (
            <Select {...p} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">{t('chooseCategory')}</option>
              {(categories.data?.data ?? []).map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('priority')} hint={t('priorityHint')} error={err('priority')}>
          {(p) => (
            <Select {...p} value={form.priority} onChange={(e) => set('priority', e.target.value as TicketPriority | '')}>
              <option value="">{t('categorys')}</option>
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('whatToDo')} error={err('description')}>
          {(p) => <Textarea {...p} rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} />}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}
