'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Segmented, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type FacilityMode } from '@/lib/queries';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';
import { useLocalName } from './bits';
import { inRange, RULE_RANGES } from './logic';

/**
 * A new facility (ADR 0044): bookable (a court, the hall) with its slot
 * length and capacity — the other rules take their defaults and are set
 * on its page — or walk-in (the pool, the gym). Its mode never changes. It
 * opens with no hours: set them next.
 */
export function NewFacilityDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const name = useLocalName();
  const toast = useToast();
  const router = useRouter();
  const [mode, setMode] = useState<FacilityMode>('bookable');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [descriptionEn, setDescriptionEn] = useState('');
  const [slotMinutes, setSlotMinutes] = useState('60');
  const [capacity, setCapacity] = useState('1');
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/facilities', {
          body: {
            mode,
            nameEn: nameEn.trim(),
            nameAr: nameAr.trim(),
            ...(descriptionEn.trim() ? { descriptionEn: descriptionEn.trim() } : {}),
            ...(mode === 'bookable' ? { slotMinutes: Number(slotMinutes), capacity: Number(capacity) } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.facilitiesAll],
      onDone: (created) => {
        toast.show(t('new.created', { name: name(created) }));
        router.push(`/facilities/${created.id}?tab=hours`);
      },
    },
  );
  const ready =
    nameEn.trim() !== '' &&
    nameAr.trim() !== '' &&
    (mode === 'walk_in' || (inRange(RULE_RANGES.slotMinutes, slotMinutes) && inRange(RULE_RANGES.capacity, capacity)));

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newFacility')}
      description={t('new.description')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('create')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<FacilityMode>
          label={t('new.kind')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'bookable', label: t('badge.bookable') },
            { value: 'walk_in', label: t('badge.walk_in') },
          ]}
        />
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} maxLength={80} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <Field label={t('descriptionEn')} hint={t('optional')} error={fieldError(save.error, 'descriptionEn')}>
          {(p) => <Textarea {...p} maxLength={1000} rows={2} dir="ltr" value={descriptionEn} onChange={(e) => setDescriptionEn(e.target.value)} />}
        </Field>
        {mode === 'bookable' ? (
          <>
            <Field
              label={t('rule.slotMinutes')}
              error={
                fieldError(save.error, 'slotMinutes') ??
                (inRange(RULE_RANGES.slotMinutes, slotMinutes) ? undefined : t('range', RULE_RANGES.slotMinutes))
              }
            >
              {(p) => <Input {...p} type="number" min={15} max={480} value={slotMinutes} onChange={(e) => setSlotMinutes(e.target.value)} />}
            </Field>
            <Field
              label={t('new.capacity')}
              hint={t('new.capacityHint')}
              error={fieldError(save.error, 'capacity') ?? (inRange(RULE_RANGES.capacity, capacity) ? undefined : t('range', RULE_RANGES.capacity))}
            >
              {(p) => <Input {...p} type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
