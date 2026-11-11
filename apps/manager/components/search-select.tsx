'use client';

import { useT } from '@jiwar/i18n';
import { Input, Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type SelectHTMLAttributes } from 'react';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';

/** One choice of a picker: the id the form sends and the words that name it. */
export interface PickOption {
  id: string;
  label: string;
}

/** What a page of a search answers: the choices, and whether the API has more of them. */
export interface PickPage {
  options: PickOption[];
  more: boolean;
}

/**
 * A picker that asks the API for what was typed (ADR 0072), so a compound
 * with more than a page of units, residents, accounts or vendors can still
 * pick any one. Shows the first page of the list at once; typing narrows it
 * on the server after a short pause. The chosen option stays in the list
 * while the search changes. `fetchOptions` is called with the typed text
 * (empty before anything is typed).
 */
export function SearchSelect({
  value,
  onChange,
  queryKey,
  fetchOptions,
  enabled = true,
  placeholder,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value' | 'onChange'> & {
  value: string;
  onChange: (id: string, option: PickOption | null) => void;
  /** Unique to what is listed; the typed text is added to it. */
  queryKey: readonly unknown[];
  fetchOptions: (q: string) => Promise<PickPage>;
  enabled?: boolean;
  placeholder?: string;
}) {
  const t = useT(en, ar);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<PickOption | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const page = useQuery({ queryKey: [...queryKey, 'pick', q], queryFn: () => fetchOptions(q), enabled, placeholderData: (prev) => prev });
  const found = page.data?.options ?? [];
  const kept = value && chosen?.id === value && !found.some((o) => o.id === value) ? [chosen] : [];
  const options = [...kept, ...found];
  return (
    <div className="stack stack--sm">
      <Input
        type="search"
        aria-label={t('pickSearch')}
        placeholder={t('pickSearch')}
        value={text}
        maxLength={64}
        autoComplete="off"
        disabled={rest.disabled}
        onChange={(e) => setText(e.target.value)}
      />
      <Select
        {...rest}
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.id === e.target.value) ?? null;
          setChosen(next);
          onChange(e.target.value, next);
        }}
      >
        <option value="">{page.isPending && enabled ? t('pickLoading') : (placeholder ?? t('pickSelect'))}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      {page.isSuccess && found.length === 0 ? <span className="field__hint">{t('pickNone')}</span> : null}
      {page.isSuccess && page.data.more ? <span className="field__hint">{t('pickMore')}</span> : null}
    </div>
  );
}
