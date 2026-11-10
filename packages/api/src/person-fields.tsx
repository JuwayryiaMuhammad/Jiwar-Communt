'use client';

import { Field, Input, Select } from '@jiwar/ui';
import { useT } from '@jiwar/i18n';
import { fieldError } from './field-error';
import ar from './messages/ar/person.ts';
import en from './messages/en/person.ts';

/**
 * Identity every account carries (ADR 0018): an Egyptian national ID, or a
 * passport with nationality and birth date. Shared by new managers,
 * residents and staff.
 */
export interface Person {
  fullName: string;
  idDocumentType: 'national_id' | 'passport';
  idDocumentNumber: string;
  phone: string;
  email: string;
  nationality?: string;
  birthDate?: string;
  preferredLocale?: 'ar' | 'en';
}

export const emptyPerson: Person = {
  fullName: '',
  idDocumentType: 'national_id',
  idDocumentNumber: '',
  phone: '',
  email: '',
  preferredLocale: 'ar',
};

/** Only what the chosen document needs: a passport adds nationality and birth date. */
export function personPayload(p: Person, options: { locale?: boolean } = { locale: true }): Person {
  const base: Person = {
    fullName: p.fullName.trim(),
    idDocumentType: p.idDocumentType,
    idDocumentNumber: p.idDocumentNumber.trim(),
    phone: p.phone.trim(),
    email: p.email.trim(),
    ...(options.locale && p.preferredLocale ? { preferredLocale: p.preferredLocale } : {}),
  };
  return p.idDocumentType === 'passport'
    ? { ...base, nationality: p.nationality?.trim().toUpperCase(), birthDate: p.birthDate }
    : base;
}

/** `prefix` maps API field errors such as `manager.email` onto these inputs. */
export function PersonFields({
  value,
  onChange,
  error,
  prefix = '',
  locale = true,
}: {
  value: Person;
  onChange: (next: Person) => void;
  error: unknown;
  prefix?: string;
  locale?: boolean;
}) {
  const t = useT(en, ar);
  const set = <K extends keyof Person>(key: K, v: Person[K]) => onChange({ ...value, [key]: v });
  const err = (field: string) => fieldError(error, prefix + field);
  const passport = value.idDocumentType === 'passport';

  return (
    <>
      <Field label={t('fullName')} error={err('fullName')}>
        {(p) => <Input {...p} value={value.fullName} onChange={(e) => set('fullName', e.target.value)} />}
      </Field>
      <div className="form__row">
        <Field label={t('email')} hint={t('emailHint')} error={err('email')}>
          {(p) => <Input {...p} type="email" value={value.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
        <Field label={t('phone')} hint={t('phoneHint')} error={err('phone')}>
          {(p) => <Input {...p} type="tel" value={value.phone} onChange={(e) => set('phone', e.target.value)} />}
        </Field>
      </div>
      <div className="form__row">
        <Field label={t('document')} error={err('idDocumentType')}>
          {(p) => (
            <Select
              {...p}
              value={value.idDocumentType}
              onChange={(e) => set('idDocumentType', e.target.value as Person['idDocumentType'])}
            >
              <option value="national_id">{t('nationalId')}</option>
              <option value="passport">{t('passport')}</option>
            </Select>
          )}
        </Field>
        <Field label={passport ? t('passportNumber') : t('nationalIdNumber')} error={err('idDocumentNumber')}>
          {(p) => (
            <Input
              {...p}
              inputMode={passport ? 'text' : 'numeric'}
              value={value.idDocumentNumber}
              onChange={(e) => set('idDocumentNumber', e.target.value)}
            />
          )}
        </Field>
      </div>
      {passport ? (
        <div className="form__row">
          <Field label={t('nationality')} hint={t('nationalityHint')} error={err('nationality')}>
            {(p) => (
              <Input {...p} maxLength={2} value={value.nationality ?? ''} onChange={(e) => set('nationality', e.target.value)} />
            )}
          </Field>
          <Field label={t('birthDate')} error={err('birthDate')}>
            {(p) => (
              <Input {...p} type="date" value={value.birthDate ?? ''} onChange={(e) => set('birthDate', e.target.value)} />
            )}
          </Field>
        </div>
      ) : null}
      {locale ? (
        <Field label={t('emailLanguage')} error={err('preferredLocale')}>
          {(p) => (
            <Select
              {...p}
              value={value.preferredLocale ?? 'ar'}
              onChange={(e) => set('preferredLocale', e.target.value as Person['preferredLocale'])}
            >
              <option value="ar">{t('arabic')}</option>
              <option value="en">{t('english')}</option>
            </Select>
          )}
        </Field>
      ) : null}
    </>
  );
}
