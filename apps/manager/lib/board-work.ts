// The dashboard's side of the board's work (ADR 0075): meetings and their
// action items, the handovers, the monthly report, the units' shares and
// the governance rules. Kept apart from queries.ts so the phase stands on
// its own; the types come from the regenerated contract.

import { unwrap, type Schema } from '@jiwar/api';
import { api } from '@/lib/api';

export type Meeting = Schema<'MeetingView'>;
export type MeetingDetail = Schema<'MeetingDetailView'>;
export type MeetingStatus = Schema<'BoardMeetingStatus'>;
export type MeetingAction = Schema<'MeetingActionView'>;
export type MeetingActionStatus = Schema<'BoardMeetingActionStatus'>;
export type AgendaKind = Schema<'BoardMeetingAgendaKind'>;
export type HandoverPack = Schema<'BoardHandoverPackView'>;
export type ManagerHandover = Schema<'ManagerHandoverView'>;
export type BoardReport = Schema<'BoardReportView'>;
export type UnitShares = Schema<'UnitSharesView'>;
export type GovernanceRules = Schema<'GovernanceRulesResponse'>;

export const boardWorkKeys = {
  meetings: (status: string) => ['governance', 'board', 'meetings', status] as const,
  meeting: (id: string) => ['governance', 'board', 'meeting', id] as const,
  actions: (status: string, mine: boolean) => ['governance', 'board', 'meeting-actions', status, mine] as const,
  pack: ['governance', 'board', 'handover-pack'] as const,
  myHandover: ['governance', 'handover', 'mine'] as const,
  handovers: ['governance', 'handovers'] as const,
  reports: ['governance', 'board', 'reports'] as const,
  shares: ['governance', 'unit-shares'] as const,
  rules: ['governance', 'rules'] as const,
};

export const boardWorkFetchers = {
  meetings: (status: MeetingStatus | '', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/board/meetings', { params: { query: { ...(status ? { status } : {}), cursor, limit } } })),
  meeting: (id: string) => unwrap(api.GET('/api/v1/board/meetings/{id}', { params: { path: { id } } })),
  actions: (status: MeetingActionStatus | '', mine: boolean, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/board/meeting-actions', {
        params: { query: { ...(status ? { status } : {}), ...(mine ? { mine: true } : {}), cursor, limit } },
      }),
    ),
  pack: () => unwrap(api.GET('/api/v1/board/handover-pack')),
  myHandover: () => unwrap(api.GET('/api/v1/staff/governance/handover')),
  handovers: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/board/manager-handovers', { params: { query: { cursor, limit } } })),
  reports: (cursor?: string, limit = 50) => unwrap(api.GET('/api/v1/board/reports', { params: { query: { cursor, limit } } })),
  shares: () => unwrap(api.GET('/api/v1/staff/governance/unit-shares')),
  rules: () => unwrap(api.GET('/api/v1/staff/governance/rules')),
};

// A meeting's kind and an agenda item's kind are named by the gov-codes
// catalog (`meetingKind.<code>`, `agendaKind.<code>`).

/**
 * A share as typed: up to three whole digits and four decimals, above 0, at
 * most 100. The problem is the gov-codes key that words it.
 */
export function shareProblem(value: string): 'share.format' | 'share.range' | null {
  const v = value.trim();
  if (v === '') return null;
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(v)) return 'share.format';
  const n = Number(v);
  if (n <= 0 || n > 100) return 'share.range';
  return null;
}
