import { createHash } from 'node:crypto';
import type { Ticket } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';

/** The hazards a permit covers (ADR 0067); the migration's CHECKs repeat them. */
export const HAZARDS = REASON_CODES.workHazard;
export type Hazard = (typeof HAZARDS)[number];

export const WORK_PERMIT_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'revoked',
  'closed',
] as const;
export type WorkPermitStatus = (typeof WORK_PERMIT_STATUSES)[number];
export const OPEN_PERMIT: readonly WorkPermitStatus[] = [
  'requested',
  'approved',
];

/** A permit is for today's work: a day at most, as the CHECK says. */
export const MAX_PERMIT_HOURS = 24;
export const PRECAUTIONS_MAX = 2000;
export const INSTRUCTION_MAX = 4000;
/** A technician asks for a permit on a ticket in their hands, not one that ended. */
export const PERMIT_TICKET_STATUSES = [
  'assigned',
  'en_route',
  'in_progress',
  'on_hold',
] as const;

/** Every hazard of `lists`, once, in the closed list's order. */
export const unionOf = (...lists: readonly (readonly string[])[]): Hazard[] =>
  HAZARDS.filter((h) => lists.some((l) => l.includes(h)));

/**
 * What a technician acknowledges (ADR 0067): SHA-256 of the instruction's
 * canonical form — its id, version and both texts — with who acknowledged
 * it, for which ticket and cycle. The stored hash proves later exactly what
 * they were shown, as a checklist run's attestation does (ADR 0064).
 */
export function acknowledgementDigest(a: {
  instructionId: string;
  version: number;
  textEn: string;
  textAr: string;
  accountId: string;
  ticketId: string;
  cycle: number;
}): string {
  const canonical = JSON.stringify([
    'jiwar:safety-acknowledgement:v1',
    a.instructionId,
    a.version,
    a.textEn,
    a.textAr,
    a.accountId,
    a.ticketId,
    a.cycle,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** The hazards the ticket's work needs a permit for: its category's and its asset type's. */
export async function hazardsOf(
  tx: TenantTxClient,
  ticket: Pick<Ticket, 'categoryId' | 'assetId'>,
): Promise<Hazard[]> {
  const category = await tx.ticketCategory.findUnique({
    where: { id: ticket.categoryId },
    select: { requiresPermit: true },
  });
  const asset = ticket.assetId
    ? await tx.asset.findUnique({
        where: { id: ticket.assetId },
        select: { typeId: true },
      })
    : null;
  const type = asset
    ? await tx.assetType.findUnique({
        where: { id: asset.typeId },
        select: { requiresPermit: true },
      })
    : null;
  return unionOf(category?.requiresPermit ?? [], type?.requiresPermit ?? []);
}

/**
 * Whether the work may start, by field safety (ADR 0067), next to the
 * quote's rule (ADR 0058) and under the same ticket lock, which every
 * permit write takes first: every hazard the work needs has an approved
 * permit of this cycle that has not expired (read FOR SHARE), else 409
 * WORK_PERMIT_REQUIRED {hazards}; and the category's current safety
 * instructions are acknowledged by who starts it for this ticket and
 * cycle, else 409 SAFETY_ACK_REQUIRED {instructionId, version}.
 */
export async function assertSafeToStart(
  tx: TenantTxClient,
  ticket: Ticket,
  accountId: string,
): Promise<void> {
  const hazards = await hazardsOf(tx, ticket);
  if (hazards.length) {
    const now = await dbNow(tx);
    const held = await tx.$queryRaw<{ hazard: string }[]>`
      SELECT hazard FROM work_permits
       WHERE ticket_id = ${ticket.id}::uuid AND cycle = ${ticket.cycle}
         AND status = 'approved' AND expires_at > ${now}
       ORDER BY id FOR SHARE`;
    const missing = hazards.filter((h) => !held.some((p) => p.hazard === h));
    if (missing.length)
      throw appError.conflict(
        ErrorCode.WORK_PERMIT_REQUIRED,
        'The work needs an approved permit for its hazards first',
        { params: { hazards: missing } },
      );
  }
  const current = await tx.safetyInstruction.findFirst({
    where: { categoryId: ticket.categoryId },
    orderBy: { version: 'desc' },
    select: { id: true, version: true },
  });
  if (!current) return;
  const acknowledged = await tx.safetyAcknowledgement.count({
    where: {
      instructionId: current.id,
      accountId,
      ticketId: ticket.id,
      cycle: ticket.cycle,
    },
  });
  if (!acknowledged)
    throw appError.conflict(
      ErrorCode.SAFETY_ACK_REQUIRED,
      'Acknowledge the safety instructions first',
      { params: { instructionId: current.id, version: current.version } },
    );
}
