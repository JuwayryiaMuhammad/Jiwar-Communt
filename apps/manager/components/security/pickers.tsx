'use client';

import { useLocale, useT } from '@jiwar/i18n';
import { Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import type { SelectHTMLAttributes } from 'react';
import { nameIn } from '@/components/security/logic';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/guard-common';
import en from '@/messages/en/guard-common';

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { placeholder?: string };

/** The posts a guard works: gates and zones in service, as `gate:<id>` or `zone:<id>`. */
export function PostPicker(props: SelectProps & { gatesOnly?: boolean }) {
  const t = useT(en, ar);
  const { locale } = useLocale();
  const { placeholder = t('picker.post'), gatesOnly, ...rest } = props;
  const posts = useQuery({ queryKey: keys.securityPosts, queryFn: fetchers.securityPosts });
  return (
    <Select {...rest}>
      <option value="">{posts.isPending ? t('picker.loadingPosts') : placeholder}</option>
      <optgroup label={t('picker.gates')}>
        {(posts.data?.gates ?? []).map((g) => (
          <option key={g.id} value={`gate:${g.id}`}>
            {g.name}
          </option>
        ))}
      </optgroup>
      {gatesOnly ? null : (
        <optgroup label={t('picker.zones')}>
          {(posts.data?.zones ?? []).map((z) => (
            <option key={z.id} value={`zone:${z.id}`}>
              {nameIn(z, locale)}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}

/** The guards the roster may schedule: active `gate.operate` holders. */
export function GuardPicker(props: SelectProps) {
  const t = useT(en, ar);
  const { placeholder = t('picker.guard'), ...rest } = props;
  const guards = useQuery({ queryKey: keys.securityGuards, queryFn: fetchers.securityGuards });
  return (
    <Select {...rest}>
      <option value="">{guards.isPending ? t('picker.loadingGuards') : placeholder}</option>
      {(guards.data?.data ?? []).map((g) => (
        <option key={g.id} value={g.id}>
          {g.fullName ?? g.id}
        </option>
      ))}
    </Select>
  );
}
