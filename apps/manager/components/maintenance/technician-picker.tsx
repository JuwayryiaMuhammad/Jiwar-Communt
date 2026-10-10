'use client';

import { Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import type { SelectHTMLAttributes } from 'react';
import { fetchers, keys } from '@/lib/queries';

/**
 * The compound's technicians, the least loaded first within those available.
 * Each option says what a dispatcher weighs: availability and open tickets.
 */
export function TechnicianPicker(
  props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { exclude?: string | null; placeholder?: string },
) {
  const { exclude, placeholder = 'Select a technician…', ...rest } = props;
  const technicians = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians });
  const list = [...(technicians.data?.data ?? [])]
    .filter((t) => t.id !== exclude)
    .sort(
      (a, b) =>
        Number(b.availability.state === 'available') - Number(a.availability.state === 'available') ||
        a.workload - b.workload,
    );
  return (
    <Select {...rest}>
      <option value="">{technicians.isPending ? 'Loading technicians…' : placeholder}</option>
      {list.map((t) => (
        <option key={t.id} value={t.id}>
          {t.fullName ?? 'Technician'} · {t.availability.state === 'available' ? 'available' : 'unavailable'} ·{' '}
          {t.openTickets} open
        </option>
      ))}
    </Select>
  );
}
