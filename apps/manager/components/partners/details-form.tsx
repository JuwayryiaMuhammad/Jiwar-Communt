'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Textarea, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type StaffPartner } from '@/lib/queries';

interface Form {
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  businessPhone: string;
  notifyEmail: string;
  serviceBuildings: string;
  homeVisit: boolean;
}

const toForm = (p: StaffPartner): Form => ({
  nameEn: p.nameEn,
  nameAr: p.nameAr,
  descriptionEn: p.descriptionEn ?? '',
  descriptionAr: p.descriptionAr ?? '',
  businessPhone: p.businessPhone,
  notifyEmail: p.notifyEmail ?? '',
  serviceBuildings: p.serviceBuildings.join(', '),
  homeVisit: p.homeVisit,
});

/**
 * Who a partner is and where it serves (ADR 0060). The notify email is the
 * staff's alone: a new request is told there, with no resident data and no
 * link. Buildings as the units name them; none is the whole compound.
 */
export function DetailsForm({ partner }: { partner: StaffPartner }) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(toForm(partner));
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/partners/{id}', {
          params: { path: { id: partner.id } },
          body: {
            nameEn: form.nameEn.trim(),
            nameAr: form.nameAr.trim(),
            descriptionEn: form.descriptionEn.trim() || null,
            descriptionAr: form.descriptionAr.trim() || null,
            businessPhone: form.businessPhone.trim(),
            notifyEmail: form.notifyEmail.trim() || null,
            serviceBuildings: form.serviceBuildings
              .split(',')
              .map((b) => b.trim())
              .filter(Boolean),
            homeVisit: form.homeVisit,
          },
        }),
      ),
    {
      invalidate: [keys.partnersAll],
      onDone: (next) => {
        setForm(toForm(next));
        toast.show('Saved.');
      },
    },
  );
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(partner));
  // A building nobody's unit names is refused on its own position.
  const buildingError = Array.from({ length: 50 }, (_, i) => fieldError(save.error, `serviceBuildings.${i}`)).find(Boolean);
  return (
    <form
      className="stack"
      style={{ maxWidth: 720 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title="Details" />
        <CardBody>
          <div className="form">
            <Field label="Name in English" error={fieldError(save.error, 'nameEn')}>
              {(p) => <Input {...p} maxLength={80} value={form.nameEn} onChange={(e) => set('nameEn', e.target.value)} />}
            </Field>
            <Field label="Name in Arabic" error={fieldError(save.error, 'nameAr')}>
              {(p) => <Input {...p} dir="rtl" maxLength={80} value={form.nameAr} onChange={(e) => set('nameAr', e.target.value)} />}
            </Field>
            <Field label="Description in English" error={fieldError(save.error, 'descriptionEn')}>
              {(p) => <Textarea {...p} rows={3} maxLength={1000} value={form.descriptionEn} onChange={(e) => set('descriptionEn', e.target.value)} />}
            </Field>
            <Field label="Description in Arabic" error={fieldError(save.error, 'descriptionAr')}>
              {(p) => <Textarea {...p} dir="rtl" rows={3} maxLength={1000} value={form.descriptionAr} onChange={(e) => set('descriptionAr', e.target.value)} />}
            </Field>
            <Field label="Business phone" hint="The one contact residents see." error={fieldError(save.error, 'businessPhone')}>
              {(p) => <Input {...p} inputMode="tel" value={form.businessPhone} onChange={(e) => set('businessPhone', e.target.value)} />}
            </Field>
            <Field
              label="Notify email (staff only)"
              hint="Told of each new request, with no resident data and no link. Empty: nobody is emailed."
              error={fieldError(save.error, 'notifyEmail')}
            >
              {(p) => <Input {...p} type="email" value={form.notifyEmail} onChange={(e) => set('notifyEmail', e.target.value)} />}
            </Field>
            <Field label="Buildings served" hint="As the units name them, separated by commas. Empty: the whole compound." error={buildingError}>
              {(p) => <Input {...p} value={form.serviceBuildings} onChange={(e) => set('serviceBuildings', e.target.value)} />}
            </Field>
            <Checkbox label="Comes to the home" checked={form.homeVisit} onChange={(e) => set('homeVisit', e.target.checked)} />
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="button" disabled={!dirty} onClick={() => setForm(toForm(partner))}>
          Discard
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
          Save
        </Button>
      </span>
    </form>
  );
}
