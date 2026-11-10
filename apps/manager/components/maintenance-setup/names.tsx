'use client';

import { fieldError } from '@jiwar/api';
import { useLocale, useT } from '@jiwar/i18n';
import { Field, Input } from '@jiwar/ui';
import ar from '@/messages/ar/ms-common';
import en from '@/messages/en/ms-common';
import { KEY_PATTERN, suggestKey } from './format';

export interface Names {
  key: string;
  nameEn: string;
  nameAr: string;
}

export const NO_NAMES: Names = { key: '', nameEn: '', nameAr: '' };

export const namesReady = (n: Names, withKey: boolean) =>
  n.nameEn.trim() !== '' && n.nameAr.trim() !== '' && (!withKey || KEY_PATTERN.test(n.key));

/**
 * The two names every maintenance list item carries, and on creation its
 * stable code. The residents' app shows the name in their language; the code
 * never changes once created, so it is suggested from the English name and
 * left for the manager to settle before saving.
 */
export function NameFields({
  value,
  onChange,
  error,
  withKey,
  example,
}: {
  value: Names;
  onChange: (next: Names) => void;
  error: unknown;
  withKey: boolean;
  example: string;
}) {
  const t = useT(en, ar);
  // The code follows the English name until the manager edits it.
  const following = value.key === suggestKey(value.nameEn);
  return (
    <>
      <div className="form__row">
        <Field label={t('nameEn')} error={fieldError(error, 'nameEn')}>
          {(p) => (
            <Input
              {...p}
              dir="ltr"
              maxLength={80}
              value={value.nameEn}
              onChange={(e) =>
                onChange({
                  ...value,
                  nameEn: e.target.value,
                  key: withKey && following ? suggestKey(e.target.value) : value.key,
                })
              }
            />
          )}
        </Field>
        <Field label={t('nameAr')} error={fieldError(error, 'nameAr')}>
          {(p) => (
            <Input {...p} dir="rtl" lang="ar" maxLength={80} value={value.nameAr} onChange={(e) => onChange({ ...value, nameAr: e.target.value })} />
          )}
        </Field>
      </div>
      {withKey ? (
        <Field
          label={t('code')}
          hint={t('codeHint', { example })}
          error={
            fieldError(error, 'key') ??
            (value.key !== '' && !KEY_PATTERN.test(value.key) ? t('codeInvalid') : undefined)
          }
        >
          {(p) => <Input {...p} className="t-mono" dir="ltr" maxLength={40} value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value })} />}
        </Field>
      ) : null}
    </>
  );
}

/** A record's name in the page's language: the Arabic one in Arabic when it has one. */
export function useNameOf() {
  const { locale } = useLocale();
  return (x: { nameEn: string; nameAr?: string | null }) => (locale === 'ar' && x.nameAr ? x.nameAr : x.nameEn);
}
