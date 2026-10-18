import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { CapabilitiesService } from './capabilities/capabilities.service';
import { HouseholdAuthority } from './households/household-authority';
import { lockUnits } from './units/unit-lock';

/** Which capacities a piece of community content is put to. */
export type AudienceOccupancy = 'everyone' | 'owners' | 'tenants';

/**
 * Who an announcement, an event or a poll is for (ADR 0040): the whole
 * compound (`buildings: null`) or the units of some buildings, and within
 * them everyone, the owners only or the tenants only.
 */
export interface Audience {
  buildings: readonly string[] | null;
  occupancy: AudienceOccupancy;
}

/**
 * One place an account holds now: an active occupancy of a unit, or an
 * active membership of its household. Someone who left has none.
 */
export interface CommunityPlace {
  accountId: string;
  unitId: string;
  /** The unit's building as the compound wrote it, or none. */
  building: string | null;
  role: 'owner' | 'tenant' | 'family';
  /** The unit has an active tenant: a member of it lives in a tenant's household. */
  rented: boolean;
}

/**
 * Whether a place is in an audience (ADR 0040), the one rule every reader
 * and every notice shares:
 *
 * - a unit without a building is in whole-compound audiences only;
 * - `owners` are the unit's active owners, landlords included, and nobody
 *   else: not a tenant, not a member of any household;
 * - `tenants` are the unit's active tenants and the members of a rented
 *   unit's household;
 * - `everyone` is every place.
 */
export function inAudience(place: CommunityPlace, audience: Audience): boolean {
  if (
    audience.buildings !== null &&
    (place.building === null || !audience.buildings.includes(place.building))
  )
    return false;
  switch (audience.occupancy) {
    case 'everyone':
      return true;
    case 'owners':
      return place.role === 'owner';
    case 'tenants':
      return (
        place.role === 'tenant' || (place.role === 'family' && place.rented)
      );
  }
}

/** Who has a place at all: the people of a household, and landlords. */
const PLACE_TYPES = ['resident', 'family'] as const;

/**
 * What the engagement domain reads from the community domain (ADR 0015,
 * 0040), and nothing else: the places an account holds now, who an
 * audience is at this moment, who casts a unit's vote, and the names and
 * codes its staff views show. Every method takes the engagement
 * transaction, so the answer is consistent with its write.
 *
 * An audience is never stored as a list of people: it is read here, from
 * the occupancies and households as they are when asked. A newcomer is in
 * it from the day they arrive; someone who left is in none.
 */
@Injectable()
export class CommunityEngagementPort {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly household: HouseholdAuthority,
  ) {}

  /**
   * The caller runs the unit's household: its primary or a `household`
   * delegate (ADR 0016). Registers the unit's children (ADR 0054).
   */
  async requireHousehold(tx: TenantTxClient, unitId: string): Promise<void> {
    await this.household.require(tx, unitId, 'household');
  }

  /**
   * One of the unit's active minors, read FOR SHARE (a removal waits for
   * the registration naming them, ADR 0054): their name and birth date.
   */
  async minorOf(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<{ memberId: string; fullName: string; birthDate: Date } | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM household_members
       WHERE id = ${memberId}::uuid AND unit_id = ${unitId}::uuid
         AND status = 'active' AND is_minor
         FOR SHARE`;
    if (!rows.length) return null;
    const m = await tx.householdMember.findUniqueOrThrow({
      where: { id: memberId },
      select: { fullName: true, birthDate: true },
    });
    return { memberId, fullName: m.fullName ?? '', birthDate: m.birthDate };
  }

  /** Members' first names (the household's own views), null once gone. */
  async memberFirstNames(
    tx: TenantTxClient,
    memberIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (!memberIds.length) return new Map();
    const rows = await tx.householdMember.findMany({
      where: { id: { in: [...new Set(memberIds)] } },
      select: { id: true, fullName: true },
    });
    return new Map(
      rows.map((m) => [
        m.id,
        (m.fullName ?? '').trim().split(/\s+/)[0] || null,
      ]),
    );
  }

  /** The places the account holds now, by unit. */
  async places(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<CommunityPlace[]> {
    return (await this.placesWhere(tx, { accountId })).sort((a, b) =>
      a.unitId.localeCompare(b.unitId),
    );
  }

  /**
   * Everyone in the audience now, one row per account and unit. Active
   * accounts only: a frozen or erased one is told nothing.
   */
  async members(
    tx: TenantTxClient,
    audience: Audience,
  ): Promise<CommunityPlace[]> {
    const all = await this.placesWhere(
      tx,
      audience.buildings === null ? {} : { buildings: audience.buildings },
    );
    return all.filter((p) => inAudience(p, audience));
  }

  /** The compound's buildings, as its units name them. */
  async buildings(tx: TenantTxClient): Promise<string[]> {
    const rows = await tx.unit.findMany({
      where: { building: { not: null } },
      distinct: ['building'],
      select: { building: true },
      orderBy: { building: 'asc' },
    });
    return rows.map((r) => r.building!);
  }

  /**
   * Whether the account casts the unit's vote in a poll put to `audience`
   * (ADR 0040). It must be in the audience through that unit, and then:
   *
   * - a poll put to the owners: any active owner of the unit;
   * - any other poll: the unit's primary occupant, or a member the primary
   *   gave `polls_vote`. A unit nobody lives in has no primary: there its
   *   owner votes, or the unit would have no voice.
   */
  async mayVote(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
    audience: Audience,
  ): Promise<boolean> {
    const place = (await this.placesWhere(tx, { accountId, unitId }))[0];
    if (!place || !inAudience(place, audience)) return false;
    const caps = await this.capabilities.placeOf(tx, accountId, unitId);
    if (!caps) return false;
    if (audience.occupancy === 'owners') return caps.pollsVoteAsOwner;
    if (caps.pollsVote) return true;
    if (!caps.pollsVoteAsOwner) return false;
    const primary = await tx.unitOccupancy.findFirst({
      where: { unitId, status: 'active', isPrimary: true },
      select: { id: true },
    });
    return primary === null;
  }

  /** The units whose vote the account casts in a poll put to `audience`. */
  async votableUnits(
    tx: TenantTxClient,
    accountId: string,
    audience: Audience,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const place of await this.places(tx, accountId))
      if (await this.mayVote(tx, accountId, place.unitId, audience))
        out.push(place.unitId);
    return out;
  }

  /** Every unit of the compound, by id. */
  async unitIds(tx: TenantTxClient): Promise<string[]> {
    const units = await tx.unit.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return units.map((u) => u.id);
  }

  /**
   * The unit's row, locked for the rest of the transaction: two members of
   * one household casting its vote at once go one after the other.
   */
  lockUnit(tx: TenantTxClient, unitId: string): Promise<void> {
    return lockUnits(tx, [unitId]);
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

  /** Names for a staff view (an event's attendee list), by account id. */
  async names(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (!accountIds.length) return new Map();
    const accounts = await tx.account.findMany({
      where: { id: { in: [...new Set(accountIds)] } },
      select: { id: true, fullName: true },
    });
    return new Map(accounts.map((a) => [a.id, a.fullName]));
  }

  private async placesWhere(
    tx: TenantTxClient,
    filter: {
      accountId?: string;
      unitId?: string;
      buildings?: readonly string[];
    },
  ): Promise<CommunityPlace[]> {
    const unit = {
      ...(filter.unitId ? { id: filter.unitId } : {}),
      ...(filter.buildings ? { building: { in: [...filter.buildings] } } : {}),
    };
    const account: Prisma.AccountWhereInput = {
      status: 'active',
      type: { in: [...PLACE_TYPES] },
    };
    const occupancies = await tx.unitOccupancy.findMany({
      where: { status: 'active', accountId: filter.accountId, unit, account },
      select: {
        accountId: true,
        unitId: true,
        occupancyType: true,
        unit: { select: { building: true } },
      },
    });
    const memberships = await tx.householdMember.findMany({
      where: {
        status: 'active',
        accountId: filter.accountId ?? { not: null },
        unit,
        account,
      },
      select: {
        accountId: true,
        unitId: true,
        unit: { select: { building: true } },
      },
    });
    const unitIds = [
      ...new Set([...occupancies, ...memberships].map((p) => p.unitId)),
    ];
    const tenants = unitIds.length
      ? await tx.unitOccupancy.findMany({
          where: {
            unitId: { in: unitIds },
            status: 'active',
            occupancyType: 'tenant',
          },
          distinct: ['unitId'],
          select: { unitId: true },
        })
      : [];
    const rented = new Set(tenants.map((t) => t.unitId));
    const seen = new Set<string>();
    const out: CommunityPlace[] = [];
    // An occupancy first: someone who owns a unit and is also listed in its
    // household is its owner.
    for (const o of occupancies) {
      seen.add(`${o.accountId}:${o.unitId}`);
      out.push({
        accountId: o.accountId,
        unitId: o.unitId,
        building: o.unit.building,
        role: o.occupancyType,
        rented: rented.has(o.unitId),
      });
    }
    for (const m of memberships) {
      if (seen.has(`${m.accountId}:${m.unitId}`)) continue;
      out.push({
        accountId: m.accountId!,
        unitId: m.unitId,
        building: m.unit.building,
        role: 'family',
        rented: rented.has(m.unitId),
      });
    }
    return out;
  }
}
