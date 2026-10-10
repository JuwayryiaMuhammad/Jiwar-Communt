'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { fetchers, keys, type Me } from './queries';

/**
 * What the signed-in account may do, from `GET /me` (the role's permissions
 * as the API checks them). For showing an action only to those who may take
 * it: the API still decides, and a 403 is handled where it lands.
 */
export function usePermissions(): {
  me: Me | undefined;
  /** False until `/me` has answered: nothing is shown as allowed before. */
  ready: boolean;
  /** Why `/me` could not be read, if it could not. */
  error: unknown;
  can: (...permissions: string[]) => boolean;
} {
  const query = useQuery({ queryKey: keys.me, queryFn: fetchers.me, staleTime: 300_000 });
  const held = new Set(query.data?.permissions ?? []);
  return {
    me: query.data,
    ready: query.data !== undefined,
    error: query.error,
    can: (...permissions) => permissions.every((p) => held.has(p)),
  };
}

/** Renders its children only for a role holding every listed permission. */
export function Can({ permission, children }: { permission: string | string[]; children: ReactNode }) {
  const { can } = usePermissions();
  return can(...(Array.isArray(permission) ? permission : [permission])) ? <>{children}</> : null;
}
