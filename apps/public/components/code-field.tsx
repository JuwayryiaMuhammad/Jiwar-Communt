'use client';

import { useId } from 'react';
import { normalizeCode } from '@/lib/registration';
import { useLocale } from './locale';

/** The six-digit emailed code. */
export function CodeField({ value, onChange, disabled }: { value: string; onChange: (code: string) => void; disabled?: boolean }) {
  const { t } = useLocale();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{t('common.code.label')}</label>
      <input
        id={id}
        className="input input--code"
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        required
        aria-describedby={`${id}-hint`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(normalizeCode(e.target.value))}
      />
      <p id={`${id}-hint`} className="hint">
        {t('common.code.hint')}
      </p>
    </div>
  );
}
