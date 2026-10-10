'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { api } from './api';

export type Me = Schema<'MeView'>;
export type Unit = Schema<'UnitView'>;
export type UnitDetail = Schema<'UnitDetailView'>;
export type UnitNeedingReview = Schema<'UnitNeedingReviewView'>;
export type Resident = Schema<'ResidentListItemView'>;
export type ResidentDetail = Schema<'ResidentDetailView'>;
export type Account = Schema<'AccountListItemView'>;
export type Registration = Schema<'PendingRegistrationView'>;
export type RegistrationLink = Schema<'RegistrationLinkResponse'>;
export type PendingMember = Schema<'PendingMemberView'>;
export type Engagement = Schema<'ReviewEngagementView'>;
export type EngagementStatus = Schema<'WorkerEngagementStatus'>;
export type ComplianceCase = Schema<'ComplianceCaseResponse'>;
export type CardIncident = Schema<'CardIncidentResponse'>;
export type Gate = Schema<'GateView'>;
export type Entry = Schema<'EntryListView'>;
export type Role = Schema<'RoleView'>;
export type Permission = Schema<'PermissionView'>;
export type Settings = Schema<'SettingsView'>;
export type AuditEntry = Schema<'AuditEntryView'>;
export type Ticket = Schema<'DispatchTicketView'>;
export type TicketDetail = Schema<'DispatchTicketDetailView'>;
export type TicketSla = Schema<'DispatchTicketSlaView'>;
export type TicketStatus = Schema<'TicketStatus'>;
export type TicketPriority = Schema<'TicketPriority'>;
export type Technician = Schema<'TechnicianOptionView'>;
export type Specialty = Schema<'SpecialtyView'>;
export type CategoryOption = Schema<'CategoryOptionView'>;
export type Visit = Schema<'DispatchVisitView'>;
export type TicketMessage = Schema<'DispatchMessageView'>;

export interface TicketFilters {
  status?: TicketStatus | '';
  priority?: TicketPriority | '';
  unassigned?: 'true' | '';
  overdue?: 'true' | '';
  escalated?: 'true' | '';
  technicianId?: string;
  categoryId?: string;
}
/** The same without the empty choices: what reaches the API. */
type TicketQuery = { [K in keyof TicketFilters]?: Exclude<TicketFilters[K], ''> };

/** Query keys: a prefix invalidates everything under it. */
export const keys = {
  me: ['me'] as const,
  units: ['units'] as const,
  unit: (id: string) => ['units', 'detail', id] as const,
  unitsReview: ['units', 'needing-review'] as const,
  residents: ['residents'] as const,
  resident: (id: string) => ['residents', 'detail', id] as const,
  accounts: ['accounts'] as const,
  registrations: ['registrations'] as const,
  registrationLinks: ['registration-links'] as const,
  household: ['household', 'pending'] as const,
  engagements: (status?: string) => ['worker-engagements', status ?? 'all'] as const,
  engagementsAll: ['worker-engagements'] as const,
  compliance: (status: string) => ['compliance-cases', status] as const,
  incidents: (status: string) => ['card-incidents', status] as const,
  gates: ['gates'] as const,
  entries: (filters: object) => ['gate-entries', filters] as const,
  roles: ['roles'] as const,
  permissions: ['permissions'] as const,
  settings: ['settings'] as const,
  audit: (filters: object) => ['audit', filters] as const,
  ticketsAll: ['tickets'] as const,
  tickets: (filters: object) => ['tickets', 'list', filters] as const,
  ticket: (id: string) => ['tickets', 'detail', id] as const,
  ticketPart: (id: string, part: string) => ['tickets', 'detail', id, part] as const,
  technicians: ['technicians'] as const,
  specialties: ['specialties'] as const,
  ticketCategories: ['ticket-categories'] as const,
};

/** Empty strings are dropped: the API validates every query value it gets. */
export function clean<T extends object>(filters: T): Partial<T> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;
}

export const fetchers = {
  me: () => unwrap(api.GET('/api/v1/me')),
  units: (cursor?: string, limit = 50) => unwrap(api.GET('/api/v1/units', { params: { query: { cursor, limit } } })),
  unit: (id: string) => unwrap(api.GET('/api/v1/units/{id}', { params: { path: { id } } })),
  unitsReview: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/units/needing-review', { params: { query: { cursor, limit } } })),
  residents: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/residents', { params: { query: { cursor, limit } } })),
  resident: (id: string) => unwrap(api.GET('/api/v1/residents/{id}', { params: { path: { id } } })),
  accounts: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/accounts', { params: { query: { cursor, limit } } })),
  registrations: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/registrations', { params: { query: { cursor, limit } } })),
  registrationLinks: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/registration-links', { params: { query: { cursor, limit } } })),
  household: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/household/pending', { params: { query: { cursor, limit } } })),
  engagements: (status: EngagementStatus | undefined, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/worker-engagements', { params: { query: { status, cursor, limit } } })),
  compliance: (status: 'open' | 'closed', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/compliance-cases', { params: { query: { status, cursor, limit } } })),
  incidents: (status: 'open' | 'closed', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/card-incidents', { params: { query: { status, cursor, limit } } })),
  gates: () => unwrap(api.GET('/api/v1/gates')),
  entries: (
    filters: { gateId?: string; direction?: 'in' | 'out'; subjectType?: Schema<'GateSubjectType'>; from?: string; to?: string },
    cursor?: string,
    limit = 50,
  ) => unwrap(api.GET('/api/v1/gate/entries', { params: { query: { ...clean(filters), cursor, limit } } })),
  roles: () => unwrap(api.GET('/api/v1/roles')),
  permissions: () => unwrap(api.GET('/api/v1/permissions')),
  settings: () => unwrap(api.GET('/api/v1/settings')),
  audit: (filters: { action?: string; targetType?: string; from?: string; to?: string }, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/audit', { params: { query: { ...clean(filters), cursor, limit } } })),
  tickets: (filters: TicketFilters, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/maintenance/tickets', { params: { query: { ...(clean(filters) as TicketQuery), cursor, limit } } })),
  ticket: (id: string) => unwrap(api.GET('/api/v1/maintenance/tickets/{id}', { params: { path: { id } } })),
  technicians: () => unwrap(api.GET('/api/v1/maintenance/technicians')),
  specialties: () => unwrap(api.GET('/api/v1/maintenance/specialties')),
  ticketCategories: () => unwrap(api.GET('/api/v1/ticket-categories')),
};

/** "100+" when the first page is full and the API says there is more. */
export function countOf(page: { data: unknown[]; nextCursor?: string | null } | undefined): string {
  if (!page) return '—';
  return page.nextCursor ? `${page.data.length}+` : String(page.data.length);
}
