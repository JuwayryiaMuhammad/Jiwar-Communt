import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type { Capabilities } from './capabilities/capabilities';
import { CapabilitiesService } from './capabilities/capabilities.service';
import { isPrimary } from './households/household-authority';

/** An account as a staff view of a booking names it: a name, or none once erased. */
export interface FacilityAccount {
  id: string;
  fullName: string | null;
  erased: boolean;
}

/**
 * Someone a club membership may cover (ADR 0044): one of the unit's
 * residing occupancies, or one of its household members (a minor too).
 */
export interface ClubPerson {
  kind: 'occupancy' | 'member';
  /** The occupancy's id, or the household member's. */
  id: string;
  accountId: string | null;
  fullName: string | null;
  isMinor: boolean;
}

/**
 * What the facilities domain reads from the community domain (ADR 0015,
 * 0044), and nothing else: what someone may do on a unit (capabilitiesFor's
 * `bookings`), who a unit's primary is, whether its household is under a
 * separation, who on a unit is told, and the codes and names the staff
 * views show. Every method takes the facilities transaction, so the answer
 * is consistent with its write.
 */
@Injectable()
export class CommunityFacilitiesPort {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /** The account's capabilities on the unit, or null with no place there. */
  placeIn(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Capabilities | null> {
    return this.capabilities.placeOf(tx, accountId, unitId);
  }

  /** Whether the account is the unit's primary occupant now. */
  isPrimary(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<boolean> {
    return isPrimary(tx, unitId, accountId);
  }

  /**
   * Whether the unit's household is under a separation review (ADR 0021):
   * then a member's activity is not shown to the primary.
   */
  async separated(tx: TenantTxClient, unitId: string): Promise<boolean> {
    const flag = await tx.unitReviewFlag.findFirst({
      where: { unitId, reason: 'separation', clearedAt: null },
      select: { id: true },
    });
    return flag !== null;
  }

  /**
   * Whether `memberId` is one of the unit's active minors, read FOR SHARE:
   * a removal waits for the booking naming them (ADR 0054).
   */
  async isMinorOf(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM household_members
       WHERE id = ${memberId}::uuid AND unit_id = ${unitId}::uuid
         AND status = 'active' AND is_minor
         FOR SHARE`;
    return rows.length > 0;
  }

  /**
   * The first names of members who are still active minors of these units
   * (ADR 0054): a booking's occasion, for the household's own views.
   */
  async minorFirstNames(
    tx: TenantTxClient,
    members: readonly { memberId: string; unitId: string }[],
  ): Promise<Map<string, string | null>> {
    if (!members.length) return new Map();
    const rows = await tx.householdMember.findMany({
      where: {
        id: { in: [...new Set(members.map((m) => m.memberId))] },
        status: 'active',
        isMinor: true,
      },
      select: { id: true, unitId: true, fullName: true },
    });
    const of = new Map(rows.map((r) => [r.id, r]));
    return new Map(
      members.map((m) => {
        const r = of.get(m.memberId);
        return [
          m.memberId,
          r && r.unitId === m.unitId
            ? (r.fullName ?? '').trim().split(/\s+/)[0] || null
            : null,
        ];
      }),
    );
  }

  /** Every active account that may book for the unit now. */
  bookers(tx: TenantTxClient, unitId: string): Promise<string[]> {
    return this.capabilities.holders(tx, unitId, 'bookings');
  }

  /** The units the account has a place in now. */
  places(tx: TenantTxClient, accountId: string): Promise<string[]> {
    return this.capabilities.unitsWhere(tx, accountId, 'unitView');
  }

  /** The units the account may book for now. */
  bookingUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    return this.capabilities.unitsWhere(tx, accountId, 'bookings');
  }

  /**
   * The unit's people now, as a club membership names them: its residing
   * occupancies and its active household members. Erased people have no
   * name.
   */
  async clubPeople(tx: TenantTxClient, unitId: string): Promise<ClubPerson[]> {
    const occupancies = await tx.unitOccupancy.findMany({
      where: { unitId, status: 'active', resides: true },
      select: {
        id: true,
        accountId: true,
        account: { select: { fullName: true, status: true } },
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
    const members = await tx.householdMember.findMany({
      where: { unitId, status: 'active' },
      select: {
        id: true,
        accountId: true,
        fullName: true,
        isMinor: true,
        account: { select: { fullName: true, status: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return [
      ...occupancies.map((o) => ({
        kind: 'occupancy' as const,
        id: o.id,
        accountId: o.accountId,
        fullName: o.account.status === 'erased' ? null : o.account.fullName,
        isMinor: false,
      })),
      ...members.map((m) => ({
        kind: 'member' as const,
        id: m.id,
        accountId: m.accountId,
        fullName:
          m.account?.status === 'erased'
            ? null
            : (m.fullName ?? m.account?.fullName ?? null),
        isMinor: m.isMinor,
      })),
    ];
  }

  /** The account's places on the unit now, by id: what a membership covers. */
  async placeIds(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<{ occupancyIds: string[]; memberIds: string[] }> {
    const occupancies = await tx.unitOccupancy.findMany({
      where: { unitId, accountId, status: 'active' },
      select: { id: true },
    });
    const members = await tx.householdMember.findMany({
      where: { unitId, accountId, status: 'active' },
      select: { id: true },
    });
    return {
      occupancyIds: occupancies.map((o) => o.id),
      memberIds: members.map((m) => m.id),
    };
  }

  /** A unit by its code, or null. */
  unitByCode(
    tx: TenantTxClient,
    code: string,
  ): Promise<{ id: string; code: string } | null> {
    return tx.unit.findFirst({
      where: { code },
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

  /** Names for a staff view, by account id; an erased account has none. */
  async accounts(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<Map<string, FacilityAccount>> {
    if (!accountIds.length) return new Map();
    const rows = await tx.account.findMany({
      where: { id: { in: [...new Set(accountIds)] } },
      select: { id: true, fullName: true, status: true },
    });
    return new Map(
      rows.map((a) => [
        a.id,
        {
          id: a.id,
          fullName: a.status === 'erased' ? null : a.fullName,
          erased: a.status === 'erased',
        },
      ]),
    );
  }
}
