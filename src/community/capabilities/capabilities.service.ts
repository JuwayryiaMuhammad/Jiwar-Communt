import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  capabilitiesFor,
  NONE,
  type Capabilities,
  type Subject,
  type UnitState,
} from './capabilities';

/** A yes/no capability (ADR 0020), e.g. visitorsInvite or tickets. */
export type CapabilityFlag = {
  [K in keyof Capabilities]: Capabilities[K] extends boolean ? K : never;
}[keyof Capabilities];

/**
 * Loads the subject and the unit state, then asks capabilitiesFor. The one
 * reader other domains call (through the community index), so the rules
 * live in a single pure function (ADR 0020).
 */
@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
  ) {}

  /**
   * The caller's capabilities on a unit — what the apps show or hide. A
   * unit the caller has no place in (no occupancy, membership or archive)
   * is "not found", like any unit they cannot see: all-false would confirm
   * that the id exists.
   */
  mine(unitId: string): Promise<Capabilities> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const subject = await this.subject(tx, this.ctx.accountId, unitId);
      if (!subject) {
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      }
      return capabilitiesFor(subject, await this.unitState(tx, unitId));
    });
  }

  /**
   * An account's capabilities on a unit: its active occupancy, else its
   * active membership, else its most recent ended occupancy (the archive).
   * Nothing at all → every flag false.
   */
  async forAccountOnUnit(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Capabilities> {
    return (await this.placeOf(tx, accountId, unitId)) ?? { ...NONE };
  }

  /** As forAccountOnUnit, but null when the account has no place on the unit. */
  async placeOf(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Capabilities | null> {
    const subject = await this.subject(tx, accountId, unitId);
    if (!subject) return null;
    return capabilitiesFor(subject, await this.unitState(tx, unitId));
  }

  /**
   * Every active account whose capabilities on the unit carry `flag`: the
   * people other domains tell (ADR 0020 decides, never the caller).
   */
  async holders(
    tx: TenantTxClient,
    unitId: string,
    flag: CapabilityFlag,
  ): Promise<string[]> {
    const occupants = await tx.unitOccupancy.findMany({
      where: { unitId, status: 'active' },
      select: { accountId: true },
    });
    const members = await tx.householdMember.findMany({
      where: { unitId, status: 'active', accountId: { not: null } },
      select: { accountId: true },
    });
    const candidates = [
      ...new Set([
        ...occupants.map((o) => o.accountId),
        ...members.map((m) => m.accountId!),
      ]),
    ];
    const active = await tx.account.findMany({
      where: { id: { in: candidates }, status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const out: string[] = [];
    for (const a of active) {
      const caps = await this.placeOf(tx, a.id, unitId);
      if (caps?.[flag]) out.push(a.id);
    }
    return out;
  }

  /** The units where the account's capabilities carry `flag`. */
  async unitsWhere(
    tx: TenantTxClient,
    accountId: string,
    flag: CapabilityFlag,
  ): Promise<string[]> {
    const occupancies = await tx.unitOccupancy.findMany({
      where: { accountId, status: 'active' },
      select: { unitId: true },
    });
    const memberships = await tx.householdMember.findMany({
      where: { accountId, status: 'active' },
      select: { unitId: true },
    });
    const units = [
      ...new Set([
        ...occupancies.map((o) => o.unitId),
        ...memberships.map((m) => m.unitId),
      ]),
    ];
    const out: string[] = [];
    for (const unitId of units) {
      const caps = await this.placeOf(tx, accountId, unitId);
      if (caps?.[flag]) out.push(unitId);
    }
    return out;
  }

  async unitState(tx: TenantTxClient, unitId: string): Promise<UnitState> {
    const unit = await tx.unit.findUnique({
      where: { id: unitId },
      select: {
        closedSince: true,
        reviewFlags: { where: { clearedAt: null }, select: { reason: true } },
      },
    });
    if (!unit) {
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    }
    return {
      closed: unit.closedSince !== null,
      reviewReasons: unit.reviewFlags.map((f) => f.reason),
    };
  }

  private async subject(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Subject | null> {
    const occupancy = await tx.unitOccupancy.findFirst({
      where: { unitId, accountId },
      // Active first, then the latest ended one.
      orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
    });
    if (occupancy?.status === 'active') return occupancySubject(occupancy);
    const member = await tx.householdMember.findFirst({
      where: { unitId, accountId, status: 'active' },
      include: {
        grants: {
          where: { revokedAt: null },
          select: { permission: true, capPerOperation: true },
        },
      },
    });
    if (member) {
      return {
        kind: 'member',
        status: member.status,
        isMinor: member.isMinor,
        hasAccount: member.accountId !== null,
        grants: member.grants.map((g) => ({
          permission: g.permission,
          capPerOperation: g.capPerOperation?.toFixed(2) ?? null,
        })),
      };
    }
    return occupancy ? occupancySubject(occupancy) : null;
  }
}

function occupancySubject(o: {
  occupancyType: 'owner' | 'tenant';
  resides: boolean;
  isPrimary: boolean;
  status: 'active' | 'ended';
  handedOverAt: Date | null;
}): Subject {
  return {
    kind: 'occupancy',
    occupancyType: o.occupancyType,
    resides: o.resides,
    isPrimary: o.isPrimary,
    status: o.status,
    handedOverAt: o.handedOverAt,
  };
}
