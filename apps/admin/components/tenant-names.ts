'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { keys, listTenants } from '@/lib/queries';

/**
 * Logs carry tenant ids only. The first 100 compounds name them; beyond
 * that the short id is shown.
 */
export function useTenantNames() {
  const tenants = useQuery({ queryKey: [...keys.tenants, 'names'], queryFn: () => listTenants(undefined, 100) });
  const names = useMemo(() => new Map((tenants.data?.data ?? []).map((t) => [t.id, t.name])), [tenants.data]);
  return { names, tenants: tenants.data?.data ?? [] };
}
