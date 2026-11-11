'use client';

import { useFormat, useT } from '@jiwar/i18n';
import { Field, Select, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/po-common';
import en from '@/messages/en/po-common';

/** Who the API lets read the vendor register (`GET /staff/vendors`). */
export const VENDOR_READERS = ['vendors.manage', 'assets.manage', 'finance.budget', 'purchases.request', 'purchases.approve'] as const;

/** The active vendors, for the roles that may read the register. */
export function useVendorChoices() {
  const { can } = usePermissions();
  const allowed = VENDOR_READERS.some((p) => can(p));
  const query = useQuery({
    queryKey: keys.poVendors,
    queryFn: () => fetchers.vendors({ status: 'active' }, undefined, 100),
    enabled: allowed,
  });
  return { allowed, vendors: query.data?.data ?? [] };
}

/** The active stock items, for the roles that keep the stock. */
export function useStockChoices() {
  const { can } = usePermissions();
  const allowed = can('stock.manage');
  const query = useQuery({
    queryKey: keys.poStockItems,
    queryFn: () => fetchers.stockItems({ active: 'true' }, undefined, 100),
    enabled: allowed,
  });
  return { allowed, items: query.data?.data ?? [] };
}

/** The stores, for the roles that keep the stock. */
export function useStoreChoices(enabled = true) {
  const { can } = usePermissions();
  const allowed = can('stock.manage');
  const query = useQuery({ queryKey: keys.poStores, queryFn: fetchers.stores, enabled: allowed && enabled });
  return { allowed, stores: (query.data?.data ?? []).filter((s) => s.active) };
}

/** The lines of the active budget, for the roles that keep the budget. */
export function useBudgetLineChoices() {
  const { can } = usePermissions();
  const allowed = can('finance.budget');
  const query = useQuery({
    queryKey: keys.poBudgetLines,
    queryFn: () => fetchers.budgets('active', undefined, 1),
    enabled: allowed,
  });
  return { allowed, loading: query.isLoading, lines: query.data?.data[0]?.lines ?? [], year: query.data?.data[0]?.fiscalYear };
}

/** The budget line an order is paid from: the active budget's lines with what each has available. */
export function BudgetLineSelect({
  value,
  onChange,
  error,
  hint,
  disabled,
  optionalLabel,
}: {
  value: string;
  onChange: (id: string) => void;
  error?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  /** The text of the empty choice when the line may be left to the source. */
  optionalLabel?: string;
}) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const { allowed, loading, lines } = useBudgetLineChoices();
  if (!allowed) return hint ? <p className="hint">{hint}</p> : <p className="hint">{t('budget.noAccess')}</p>;
  return (
    <Field label={t('budget.label')} error={error} hint={hint}>
      {(p) => (
        <Select {...p} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">{optionalLabel ?? (loading || lines.length ? t('budget.choose') : t('budget.none'))}</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {t('budget.option', { category: label(l.category), available: f.money(l.available) })}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
