'use client';

import { Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import type { SelectHTMLAttributes } from 'react';
import { fetchers, keys } from '@/lib/queries';

/**
 * Units by code, from the first 100. The API has no unit search yet
 * (docs/api/v0-notes.md); a larger compound needs it before this scales.
 */
export function UnitPicker(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { placeholder?: string }) {
  const { placeholder = 'Select a unit…', ...rest } = props;
  const units = useQuery({ queryKey: [...keys.units, 'picker'], queryFn: () => fetchers.units(undefined, 100) });
  const list = [...(units.data?.data ?? [])].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return (
    <Select {...rest}>
      <option value="">{units.isPending ? 'Loading units…' : placeholder}</option>
      {list.map((u) => (
        <option key={u.id} value={u.id}>
          {u.code}
          {u.building ? ` · ${u.building}` : ''}
        </option>
      ))}
    </Select>
  );
}
