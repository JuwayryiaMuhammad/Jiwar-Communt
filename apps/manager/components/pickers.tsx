'use client';

import { useFormat, useLocale, useT } from '@jiwar/i18n';
import type { SelectHTMLAttributes } from 'react';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';
import { SearchSelect, type PickOption, type PickPage } from './search-select';

/** How many choices a picker lists at a time; the rest is reached by typing. */
const PAGE = 50;

/** The API searches from two characters; a single one lists the first page. */
const term = (q: string) => (q.length >= 2 ? q : undefined);

type Aria = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value' | 'onChange'>;

/** What the pickers share: the chosen id (with its words, for a message) and a placeholder. */
interface PickerProps extends Aria {
  value: string;
  onChange: (id: string, text: string) => void;
  placeholder?: string;
  enabled?: boolean;
}

/**
 * The compound's accounts by name (ADR 0072), narrowed to a side — the staff
 * and managers who can own an item, the managers, the households' people —
 * and to those who can sign in. `exclude` leaves one out (not yourself).
 */
export function AccountPicker({
  group,
  exclude,
  onChange,
  ...rest
}: PickerProps & { group: 'staff' | 'managers' | 'households'; exclude?: string }) {
  const t = useT(en, ar);
  return (
    <SearchSelect
      {...rest}
      queryKey={[...keys.accounts, 'picker', group]}
      hide={exclude ? new Set([exclude]) : undefined}
      onChange={(id, option) => onChange(id, option?.label ?? '')}
      fetchOptions={async (q): Promise<PickPage> => {
        const page = await fetchers.accountsFind(q ? term(q) : undefined, group, PAGE);
        return {
          options: page.data
            .filter((a) => !a.erased)
            .map((a) => ({ id: a.id, label: a.fullName ?? t('erased') })),
          more: page.nextCursor !== null,
        };
      }}
    />
  );
}

/** The residents by name, with their units (ADR 0072). */
export function ResidentPicker({ onChange, ...rest }: PickerProps & { decorate?: (option: PickOption) => string }) {
  const t = useT(en, ar);
  const f = useFormat();
  return (
    <SearchSelect
      {...rest}
      queryKey={[...keys.residents, 'picker']}
      onChange={(id, option) => onChange(id, option?.label ?? '')}
      fetchOptions={async (q): Promise<PickPage> => {
        const page = await fetchers.residentsFind(q ? term(q) : undefined, PAGE);
        return {
          options: page.data
            .filter((r) => !r.erased && r.status === 'active')
            .map((r) => ({
              id: r.id,
              label: `${r.fullName ?? t('erased')}${r.units?.length ? ` · ${f.list(r.units.map((u) => u.unitCode))}` : ''}`,
            })),
          more: page.nextCursor !== null,
        };
      }}
    />
  );
}

/** The assets in service by code or name (ADR 0072). */
export function AssetPicker({ onChange, ...rest }: PickerProps & { hide?: ReadonlySet<string> }) {
  const { locale } = useLocale();
  return (
    <SearchSelect
      {...rest}
      queryKey={[...keys.assetsAll, 'picker', locale]}
      onChange={(id, option) => onChange(id, option?.label ?? '')}
      fetchOptions={async (q): Promise<PickPage> => {
        const page = await fetchers.assetsFind(q || undefined, 'in_service', PAGE);
        return {
          options: page.data.map((a) => ({ id: a.id, label: `${a.code} · ${locale === 'ar' ? a.nameAr : a.nameEn}` })),
          more: page.nextCursor !== null,
        };
      }}
    />
  );
}

/** The active vendors by name (ADR 0072). */
export function VendorPicker({ onChange, ...rest }: PickerProps & { hide?: ReadonlySet<string> }) {
  return (
    <SearchSelect
      {...rest}
      queryKey={[...keys.vendorsAll, 'picker']}
      onChange={(id, option) => onChange(id, option?.label ?? '')}
      fetchOptions={async (q): Promise<PickPage> => {
        const page = await fetchers.vendors({ status: 'active', q }, undefined, PAGE);
        return {
          options: page.data.map((v) => ({ id: v.id, label: `${v.reference} · ${v.name}` })),
          more: page.nextCursor !== null,
        };
      }}
    />
  );
}
