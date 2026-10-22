'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type PartnerCategory } from '@/lib/queries';
import { CATEGORIES, CATEGORY_TEXT, looksLikePhone } from './logic';

/**
 * A new partner (ADR 0060): its names, its business phone — the one
 * contact residents see — and the category it serves; the sub-categories,
 * hours, prices, area and desk link are set on its page.
 */
export function NewPartnerDialog({ onClose }: { onClose: () => void }) {
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
        toast.show(`${created.nameEn} is listed. Set its hours and desk link next.`);
        router.push(`/partners/${created.id}`);
      },
    },
  );
  const ready = nameEn.trim() !== '' && nameAr.trim() !== '' && looksLikePhone(phone);
  return (
    <Dialog
      open
      onClose={onClose}
      title="New partner"
      description="Residents see its names, what it does, its prices, hours and business phone. Never a person’s own number."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            List
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name in English" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name in Arabic" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" maxLength={80} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <Field label="Business phone" hint="E.164 or a local number." error={fieldError(save.error, 'businessPhone')}>
          {(p) => <Input {...p} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <Field label="Category">
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as PartnerCategory)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_TEXT[c]}
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
