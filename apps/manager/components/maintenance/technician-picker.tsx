'use client';

import { useT } from '@jiwar/i18n';
import { Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import type { SelectHTMLAttributes } from 'react';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/maint-common';
import en from '@/messages/en/maint-common';

/**
 * The compound's technicians, the least loaded first within those available.
 * Each option says what a dispatcher weighs: availability and open tickets.
 */
export function TechnicianPicker(
  props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { exclude?: string | null; placeholder?: string },
) {
  const t = useT(en, ar);
  const { exclude, placeholder = t('picker.select'), ...rest } = props;
  const technicians = useQuery({ queryKey: keys.technicians, queryFn: fetchers.technicians });
  const list = [...(technicians.data?.data ?? [])]
    .filter((x) => x.id !== exclude)
    .sort(
      (a, b) =>
        Number(b.availability.state === 'available') - Number(a.availability.state === 'available') ||
        a.workload - b.workload,
    );
  return (
    <Select {...rest}>
      <option value="">{technicians.isPending ? t('picker.loading') : placeholder}</option>
      {list.map((x) => (
        <option key={x.id} value={x.id}>
          {t('picker.option', { name: x.fullName ?? t('picker.technician'), state: x.availability.state, n: x.openTickets })}
        </option>
      ))}
    </Select>
  );
}
