'use client';

import { useT } from '@jiwar/i18n';
import type { SelectHTMLAttributes } from 'react';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';
import { SearchSelect } from './search-select';

/**
 * Units by code (ADR 0072): the first 50 at once, any other by typing part
 * of its code, which the API searches. `onChange` answers like a select's,
 * with the chosen unit's id in `target.value`.
 */
export function UnitPicker({
  onChange,
  placeholder,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'onChange'> & {
  value: string;
  onChange?: (e: { target: { value: string } }) => void;
  placeholder?: string;
}) {
  const t = useT(en, ar);
  return (
    <SearchSelect
      {...rest}
      value={rest.value}
      placeholder={placeholder ?? t('pickUnit')}
      queryKey={[...keys.units, 'picker']}
      onChange={(id) => onChange?.({ target: { value: id } })}
      fetchOptions={async (q) => {
        const page = await fetchers.unitsFind(q || undefined, 50);
        return {
          options: page.data.map((u) => ({ id: u.id, label: `${u.code}${u.building ? ` · ${u.building}` : ''}` })),
          more: page.nextCursor !== null,
        };
      }}
    />
  );
}
