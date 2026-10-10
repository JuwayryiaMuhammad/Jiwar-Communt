'use client';

import { fieldError } from '@jiwar/api';
import { Field, Input } from '@jiwar/ui';
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
  // The code follows the English name until the manager edits it.
  const following = value.key === suggestKey(value.nameEn);
  return (
    <>
      <div className="form__row">
        <Field label="Name (English)" error={fieldError(error, 'nameEn')}>
          {(p) => (
            <Input
              {...p}
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
        <Field label="Name (Arabic)" error={fieldError(error, 'nameAr')}>
          {(p) => (
            <Input {...p} dir="rtl" lang="ar" maxLength={80} value={value.nameAr} onChange={(e) => onChange({ ...value, nameAr: e.target.value })} />
          )}
        </Field>
      </div>
      {withKey ? (
        <Field
          label="Code"
          hint={`Lowercase letters, digits and underscores, e.g. ${example}. It can never be changed later.`}
          error={
            fieldError(error, 'key') ??
            (value.key !== '' && !KEY_PATTERN.test(value.key) ? 'Start with a letter; 2 to 40 lowercase letters, digits or underscores.' : undefined)
          }
        >
          {(p) => <Input {...p} className="t-mono" maxLength={40} value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value })} />}
        </Field>
      ) : null}
    </>
  );
}
