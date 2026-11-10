'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type StaffPartner } from '@/lib/queries';
import ar from '@/messages/ar/partners-edit';
import en from '@/messages/en/partners-edit';

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
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(c('saved'));
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
        <CardHeader title={t('details.title')} />
        <CardBody>
          <div className="form">
            <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
              {(p) => <Input {...p} maxLength={80} value={form.nameEn} onChange={(e) => set('nameEn', e.target.value)} />}
            </Field>
            <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
              {(p) => <Input {...p} dir="rtl" maxLength={80} value={form.nameAr} onChange={(e) => set('nameAr', e.target.value)} />}
            </Field>
            <Field label={t('details.descriptionEn')} error={fieldError(save.error, 'descriptionEn')}>
              {(p) => <Textarea {...p} rows={3} maxLength={1000} value={form.descriptionEn} onChange={(e) => set('descriptionEn', e.target.value)} />}
            </Field>
            <Field label={t('details.descriptionAr')} error={fieldError(save.error, 'descriptionAr')}>
              {(p) => <Textarea {...p} dir="rtl" rows={3} maxLength={1000} value={form.descriptionAr} onChange={(e) => set('descriptionAr', e.target.value)} />}
            </Field>
            <Field label={t('businessPhone')} hint={t('details.phoneHint')} error={fieldError(save.error, 'businessPhone')}>
              {(p) => <Input {...p} className="ltr" inputMode="tel" value={form.businessPhone} onChange={(e) => set('businessPhone', e.target.value)} />}
            </Field>
            <Field
              label={t('details.notifyEmail')}
              hint={t('details.notifyEmailHint')}
              error={fieldError(save.error, 'notifyEmail')}
            >
              {(p) => <Input {...p} className="ltr" type="email" value={form.notifyEmail} onChange={(e) => set('notifyEmail', e.target.value)} />}
            </Field>
            <Field label={t('details.buildings')} hint={t('details.buildingsHint')} error={buildingError}>
              {(p) => <Input {...p} value={form.serviceBuildings} onChange={(e) => set('serviceBuildings', e.target.value)} />}
            </Field>
            <Checkbox label={t('details.homeVisit')} checked={form.homeVisit} onChange={(e) => set('homeVisit', e.target.checked)} />
          </div>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="button" disabled={!dirty} onClick={() => setForm(toForm(partner))}>
          {t('discard')}
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
          {c('save')}
        </Button>
      </span>
    </form>
  );
}
