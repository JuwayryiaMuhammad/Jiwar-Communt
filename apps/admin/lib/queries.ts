'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { api } from './api';

export type Tenant = Schema<'TenantView'>;
export type TenantDetail = Schema<'TenantDetailView'>;
export type Manager = Schema<'ManagerView'>;
export type SecurityEvent = Schema<'SecurityEventView'>;
export type AuditEntry = Schema<'PlatformAuditEntryView'>;

export const keys = {
  tenants: ['tenants'] as const,
  tenant: (id: string) => ['tenants', id] as const,
  events: (filters: object) => ['security-events', filters] as const,
  audit: (filters: object) => ['platform-audit', filters] as const,
};

export function listTenants(cursor?: string, limit = 50) {
  return unwrap(api.GET('/api/v1/platform/tenants', { params: { query: { cursor, limit } } }));
}

export function getTenant(id: string) {
  return unwrap(api.GET('/api/v1/platform/tenants/{id}', { params: { path: { id } } }));
}

export interface EventFilters {
  event?: string;
  tenantId?: string;
  accountId?: string;
  from?: string;
  to?: string;
}

/** Empty strings are dropped: the API validates every query value it gets. */
function clean<T extends object>(filters: T): Partial<T> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;
}

export function listEvents(filters: EventFilters, cursor?: string, limit = 50) {
  return unwrap(
    api.GET('/api/v1/platform/security-events', {
      params: { query: { ...clean(filters), cursor, limit } },
    }),
  );
}

export interface AuditFilters {
  action?: string;
  targetTenantId?: string;
  from?: string;
  to?: string;
}

export function listAudit(filters: AuditFilters, cursor?: string, limit = 50) {
  return unwrap(
    api.GET('/api/v1/platform/audit', {
      params: { query: { ...clean(filters), cursor, limit } },
    }),
  );
}
