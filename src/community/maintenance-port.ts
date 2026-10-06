import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type { Capabilities } from './capabilities/capabilities';
import { CapabilitiesService } from './capabilities/capabilities.service';

/** An active domestic worker of a unit, as a visit's receiver sees them. */
export interface VisitWorker {
  engagementId: string;
  workerId: string;
  fullName: string;
}

/**
 * What the maintenance domain reads from the community domain (ADR 0015,
 * 0032, 0034), and nothing else: units, who may open tickets on a unit
 * (capabilitiesFor's `tickets`) and since when someone no longer may, who
 * may let a technician in while nobody
 * is home (`visitConsent`), a unit's active domestic workers, and the
 * unit's primary. Every method takes the maintenance transaction, so the
 * answer is consistent with its write.
 */
@Injectable()
export class CommunityMaintenancePort {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /** An account's capabilities on a unit, or null when it has no place there. */
  placeIn(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Capabilities | null> {
    return this.capabilities.placeOf(tx, accountId, unitId);
  }

  /**
   * When the account lost `tickets` on the unit (ADR 0032), or null while it
   * has it: the latest end recorded here — an occupancy's `ended_at`, a
   * membership's `removed_at`, a revoked `tickets` grant's `revoked_at`.
   * None recorded (an owner who stopped residing leaves no time on the
   * row): the epoch, so the caller shows nothing rather than too much. Each
   * candidate is no later than the real moment, so neither is the answer.
   */
  async ticketsLostAt(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Date | null> {
    if ((await this.capabilities.placeOf(tx, accountId, unitId))?.tickets)
      return null;
    const occupancy = await tx.unitOccupancy.findFirst({
      where: { unitId, accountId, status: 'ended', endedAt: { not: null } },
      orderBy: { endedAt: 'desc' },
      select: { endedAt: true },
    });
    const membership = await tx.householdMember.findFirst({
      where: { unitId, accountId, status: 'removed', removedAt: { not: null } },
      orderBy: { removedAt: 'desc' },
      select: { removedAt: true },
    });
    const grant = await tx.householdMemberGrant.findFirst({
      where: {
        permission: 'tickets',
        revokedAt: { not: null },
        member: { unitId, accountId },
      },
      orderBy: { revokedAt: 'desc' },
      select: { revokedAt: true },
    });
    const ends = [occupancy?.endedAt, membership?.removedAt, grant?.revokedAt]
      .filter((d): d is Date => d instanceof Date)
      .map((d) => d.getTime());
    return new Date(ends.length ? Math.max(...ends) : 0);
  }

  /** The units where the account may open tickets now. */
  ticketUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    return this.capabilities.unitsWhere(tx, accountId, 'tickets');
  }

  unit(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<{ id: string; code: string } | null> {
    return tx.unit.findUnique({
      where: { id: unitId },
      select: { id: true, code: true },
    });
  }

  async unitCodes(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (!unitIds.length) return new Map();
    const units = await tx.unit.findMany({
      where: { id: { in: [...new Set(unitIds)] } },
      select: { id: true, code: true },
    });
    return new Map(units.map((u) => [u.id, u.code]));
  }

  /**
   * Whether the account may consent to a technician entering the unit while
   * nobody is home (ADR 0034): `visitConsent` there, and an active account
   * (never a frozen or erased one).
   */
  async mayConsent(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<boolean> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (account?.status !== 'active') return false;
    return (
      (await this.capabilities.placeOf(tx, accountId, unitId))?.visitConsent ===
      true
    );
  }

  /** Every active account that may consent on the unit (ADR 0034). */
  consenters(tx: TenantTxClient, unitId: string): Promise<string[]> {
    return this.capabilities.holders(tx, unitId, 'visitConsent');
  }

  /**
   * An engagement of the unit whose worker may receive a technician now
   * (ADR 0034): active, not past its end, the worker not banned. Null
   * otherwise. Read live: an engagement that ended or was suspended stops
   * qualifying at once, without telling maintenance.
   */
  async activeWorker(
    tx: TenantTxClient,
    unitId: string,
    engagementId: string,
  ): Promise<VisitWorker | null> {
    const e = await tx.workerEngagement.findFirst({
      where: {
        id: engagementId,
        unitId,
        status: 'active',
        OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
        worker: { bannedAt: null },
      },
      select: {
        id: true,
        worker: { select: { id: true, fullName: true } },
      },
    });
    return e
      ? {
          engagementId: e.id,
          workerId: e.worker.id,
          fullName: e.worker.fullName,
        }
      : null;
  }

  /** The unit's primary resident now (ADR 0016), or null. */
  async primaryOf(tx: TenantTxClient, unitId: string): Promise<string | null> {
    const row = await tx.unitOccupancy.findFirst({
      where: { unitId, status: 'active', isPrimary: true },
      select: { accountId: true },
    });
    return row?.accountId ?? null;
  }

  /** The units the account is the primary resident of now. */
  async primaryUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    const rows = await tx.unitOccupancy.findMany({
      where: { accountId, status: 'active', isPrimary: true },
      select: { unitId: true },
    });
    return rows.map((r) => r.unitId);
  }
}
