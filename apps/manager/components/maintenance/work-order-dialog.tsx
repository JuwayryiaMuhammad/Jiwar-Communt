'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Segmented, Select, Textarea } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type TicketPriority } from '@/lib/queries';

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
      title="New work order"
      description={
        meterAlertId
          ? 'For this spike: the alert is acknowledged with it. Without a place, the meter’s asset or area.'
          : 'A job of the compound’s own, on an asset or a common area. It is dispatched like any repair.'
      }
      onSubmit={() => ready && create.mutate()}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            Open work order
          </Button>
        </>
      }
    >
      <div className="form">
        {assetId ? null : (
          <div>
            <Segmented
              label="On"
              value={form.place}
              onChange={(place) => setForm((f) => ({ ...f, place }))}
              options={[
                { value: 'asset', label: 'An asset' },
                { value: 'area', label: 'A common area' },
              ]}
            />
          </div>
        )}
        {assetId ? null : form.place === 'asset' ? (
          <Field label="Asset" error={err('assetId')}>
            {(p) => (
              <Select {...p} value={form.assetId} onChange={(e) => set('assetId', e.target.value)}>
                <option value="">{meterAlertId ? 'The meter’s' : 'Choose an asset'}</option>
                {(assets.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field label="Common area" error={err('commonAreaId')}>
            {(p) => (
              <Select {...p} value={form.commonAreaId} onChange={(e) => set('commonAreaId', e.target.value)}>
                <option value="">{meterAlertId ? 'The meter’s' : 'Choose an area'}</option>
                {(areas.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Category" error={err('categoryId')}>
          {(p) => (
            <Select {...p} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">Choose a category</option>
              {(categories.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Priority" hint="The category’s when left empty." error={err('priority')}>
          {(p) => (
            <Select {...p} value={form.priority} onChange={(e) => set('priority', e.target.value as TicketPriority | '')}>
              <option value="">The category’s</option>
              <option value="emergency">Emergency</option>
              <option value="urgent">Urgent</option>
              <option value="normal">Normal</option>
            </Select>
          )}
        </Field>
        <Field label="What is to be done" error={err('description')}>
          {(p) => <Textarea {...p} rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} />}
        </Field>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}
