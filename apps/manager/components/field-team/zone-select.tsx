'use client';

import { unwrap } from '@jiwar/api';
import { useLocale, useT } from '@jiwar/i18n';
import { Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import type { SelectHTMLAttributes } from 'react';
import { api } from '@/lib/api';
import ar from '@/messages/ar/ops-field-team';
import en from '@/messages/en/ops-field-team';

interface Zone {
  id: string;
  nameEn: string;
  nameAr: string;
}

/**
 * The zones in service (ADR 0078), for a roster slot or a reinforcement call
 * (ADR 0090). Empty is the whole compound.
 */
export function ZoneSelect(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'>) {
  const t = useT(en, ar);
  const { locale } = useLocale();
  const zones = useQuery({
    queryKey: ['field-team', 'zones'],
    queryFn: async () => ((await unwrap(api.GET('/api/v1/staff/field-team/zones', {}))) as { data: Zone[] }).data,
  });
  return (
    <Select {...props}>
      <option value="">{t('wholeCompound')}</option>
      {(zones.data ?? []).map((z) => (
        <option key={z.id} value={z.id}>
          {locale === 'ar' ? z.nameAr : z.nameEn}
        </option>
      ))}
    </Select>
  );
}
