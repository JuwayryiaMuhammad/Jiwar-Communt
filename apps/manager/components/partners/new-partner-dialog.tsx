'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type PartnerCategory } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-edit';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-edit';
import { CATEGORIES, looksLikePhone, word } from './logic';

/**
 * A new partner (ADR 0060): its names, its business phone — the one
 * contact residents see — and the category it serves; the sub-categories,
 * hours, prices, area and desk link are set on its page.
 */
export function NewPartnerDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const c = useCommonT();
  const { locale } = useLocale();
  const toast = useToast();
  const router = useRouter();
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState<PartnerCategory>('home_services');
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/partners', {
          body: { nameEn: nameEn.trim(), nameAr: nameAr.trim(), businessPhone: phone.trim(), services: [{ category }] },
        }),
      ),
    {
      invalidate: [keys.partnersAll],
      onDone: (created) => {
        toast.show(t('new.listed', { name: locale === 'ar' ? created.nameAr : created.nameEn }));
        router.push(`/partners/${created.id}`);
      },
    },
  );
  const ready = nameEn.trim() !== '' && nameAr.trim() !== '' && looksLikePhone(phone);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('new.title')}
      description={t('new.description')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('new.submit')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" maxLength={80} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <Field label={t('businessPhone')} hint={t('businessPhone.hintNew')} error={fieldError(save.error, 'businessPhone')}>
          {(p) => <Input {...p} className="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <Field label={t('category')}>
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as PartnerCategory)}>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {word(codes, 'category', cat)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
