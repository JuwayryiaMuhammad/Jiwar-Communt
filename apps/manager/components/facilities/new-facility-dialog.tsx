'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Segmented, Textarea, useToast } from '@jiwar/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type FacilityMode } from '@/lib/queries';
import { inRange, RULE_RANGES } from './logic';

/**
 * A new facility (ADR 0044): bookable (a court, the hall) with its slot
 * length and capacity — the other rules take their defaults and are set
 * on its page — or walk-in (the pool, the gym). Its mode never changes. It
 * opens with no hours: set them next.
 */
export function NewFacilityDialog({ onClose }: { onClose: () => void }) {
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
        toast.show(`${created.nameEn} is created. Set its opening hours next.`);
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
      title="New facility"
      description="A bookable facility takes bookings by slot. A walk-in facility is shown with its hours only."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Create
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<FacilityMode>
          label="Kind"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'bookable', label: 'Bookable' },
            { value: 'walk_in', label: 'Walk-in' },
          ]}
        />
        <Field label="Name in English" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name in Arabic" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} maxLength={80} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <Field label="Description in English" hint="Optional." error={fieldError(save.error, 'descriptionEn')}>
          {(p) => <Textarea {...p} maxLength={1000} rows={2} value={descriptionEn} onChange={(e) => setDescriptionEn(e.target.value)} />}
        </Field>
        {mode === 'bookable' ? (
          <>
            <Field
              label="Slot length, minutes"
              error={fieldError(save.error, 'slotMinutes') ?? (inRange(RULE_RANGES.slotMinutes, slotMinutes) ? undefined : 'From 15 to 480.')}
            >
              {(p) => <Input {...p} type="number" min={15} max={480} value={slotMinutes} onChange={(e) => setSlotMinutes(e.target.value)} />}
            </Field>
            <Field
              label="Bookings a slot takes"
              hint="Capacity can be counted in people instead, on the facility’s page."
              error={fieldError(save.error, 'capacity') ?? (inRange(RULE_RANGES.capacity, capacity) ? undefined : 'From 1 to 500.')}
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
