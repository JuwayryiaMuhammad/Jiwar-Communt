'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type Category } from '@/lib/queries';
import { formatMinutes } from './format';

const PRIORITIES = ['emergency', 'urgent', 'normal'] as const;
type Priority = (typeof PRIORITIES)[number];
type Form = Record<Priority, { responseMinutes: string; resolutionMinutes: string }>;

const toForm = (c: Category): Form =>
  Object.fromEntries(
    PRIORITIES.map((p) => [
      p,
      {
        responseMinutes: String(c.slaTargets[p].responseMinutes),
        resolutionMinutes: String(c.slaTargets[p].resolutionMinutes),
      },
    ]),
  ) as Form;

/**
 * A category's SLA targets (ADR 0034), per priority. All three are saved
 * together. A change applies to tickets opened from now on and retargets the
 * clocks still running; a clock that already ended keeps what it was held to.
 */
export function SlaTargetsDialog({ category, onClose }: { category: Category; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState(() => toForm(category));
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/maintenance/categories/{id}/sla-targets', {
          params: { path: { id: category.id } },
          body: Object.fromEntries(
            PRIORITIES.map((p) => [
              p,
              {
                responseMinutes: Number(form[p].responseMinutes),
                resolutionMinutes: Number(form[p].resolutionMinutes),
              },
            ]),
          ) as Record<Priority, { responseMinutes: number; resolutionMinutes: number }>,
        }),
      ),
    {
      invalidate: [keys.categories],
      onDone: () => {
        toast.show(`SLA targets of ${category.nameEn} are saved.`);
        onClose();
      },
    },
  );
  const set = (p: Priority, field: 'responseMinutes' | 'resolutionMinutes', value: string) =>
    setForm((f) => ({ ...f, [p]: { ...f[p], [field]: value } }));
  const read = (value: string) => (value.trim() === '' ? '' : formatMinutes(Number(value)));
  // The one cross-field rule, said before the API has to.
  const inverted = (p: Priority) => Number(form[p].responseMinutes) > Number(form[p].resolutionMinutes);
  const ready = PRIORITIES.every((p) => form[p].responseMinutes.trim() !== '' && form[p].resolutionMinutes.trim() !== '' && !inverted(p));

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`SLA targets: ${category.nameEn}`}
      description="In minutes. Response: from opening to the first visit proposal or the start of the work. Resolution: until the technician reports the work done, without the time spent waiting for the resident or for parts."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Save targets
          </Button>
        </>
      }
    >
      <div className="form">
        {PRIORITIES.map((p) => (
          <div className="form__row" key={p}>
            <Field
              label={`${p.charAt(0).toUpperCase() + p.slice(1)}: response`}
              hint={`5 to 10080. ${read(form[p].responseMinutes)}`}
              error={fieldError(save.error, `${p}.responseMinutes`)}
            >
              {(f) => (
                <Input {...f} type="number" min={5} max={10080} value={form[p].responseMinutes} onChange={(e) => set(p, 'responseMinutes', e.target.value)} />
              )}
            </Field>
            <Field
              label={`${p.charAt(0).toUpperCase() + p.slice(1)}: resolution`}
              hint={`15 to 43200. ${read(form[p].resolutionMinutes)}`}
              error={
                fieldError(save.error, `${p}.resolutionMinutes`) ??
                (inverted(p) ? 'At least the response target.' : undefined)
              }
            >
              {(f) => (
                <Input {...f} type="number" min={15} max={43200} value={form[p].resolutionMinutes} onChange={(e) => set(p, 'resolutionMinutes', e.target.value)} />
              )}
            </Field>
          </div>
        ))}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
