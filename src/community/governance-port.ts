import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { CapabilitiesService } from './capabilities/capabilities.service';

/** An owner as the board register and its pickers show them. */
export interface GovernanceOwner {
  accountId: string;
  fullName: string | null;
  /** The codes of the units they own now, sorted. */
  unitCodes: string[];
}

/**
 * What the governance domain reads from the community domain (ADR 0015,
 * 0051), and nothing else: who owns which unit (capabilitiesFor's
 * governanceVote and governanceCandidacy), whose hand casts each unit's one
 * vote, and the names and codes the board's views show. Every method takes
 * the governance transaction, so the answer is consistent with its write.
 */
@Injectable()
export class CommunityGovernancePort {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /** The units whose vote the account may cast now: the units it owns. */
  voteUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    return this.capabilities.unitsWhere(tx, accountId, 'governanceVote');
  }

  /**
   * Who may take a staff decision about a unit to the board (ADR 0055): an
   * active account that owns the unit now (landlords too), or its primary
   * occupant (who may be a tenant).
   */
  async mayAppealFor(
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
      (await tx.unitOccupancy.count({
        where: {
          accountId,
          unitId,
          status: 'active',
          OR: [{ occupancyType: 'owner' }, { isPrimary: true }],
        },
      })) > 0
    );
  }

  /** The units the account may appeal for now (owned, or its primary's). */
  async appealUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    const rows = await tx.unitOccupancy.findMany({
      where: {
        accountId,
        status: 'active',
        OR: [{ occupancyType: 'owner' }, { isPrimary: true }],
      },
      select: { unitId: true },
      distinct: ['unitId'],
    });
    return rows.map((r) => r.unitId);
  }

  /**
   * Everyone living in or owning the unit now (every active occupancy:
   * owners, landlords, tenants): who is recused from the board's motion on
   * an appeal about it (ADR 0055).
   */
  async unitPeople(tx: TenantTxClient, unitId: string): Promise<string[]> {
    const rows = await tx.unitOccupancy.findMany({
      where: { unitId, status: 'active' },
      select: { accountId: true },
      distinct: ['accountId'],
    });
    return rows.map((r) => r.accountId).sort();
  }

  /** Whether the account may sit on the board or stand: it owns a unit. */
  async isOwner(tx: TenantTxClient, accountId: string): Promise<boolean> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (account?.status !== 'active') return false;
    return (
      (await this.capabilities.unitsWhere(tx, accountId, 'governanceCandidacy'))
        .length > 0
    );
  }

  /**
   * The account that casts each unit's one vote (ADR 0051): the primary
   * occupant when they own the unit, else the unit's longest-standing
   * active owner (earliest start, then id). A unit no active account owns
   * has no voice and is not in the map. Read once, when a vote opens: the
   * electorate is that snapshot.
   */
  async votingOwners(tx: TenantTxClient): Promise<Map<string, string>> {
    const owners = await tx.unitOccupancy.findMany({
      where: { status: 'active', occupancyType: 'owner' },
      select: { unitId: true, accountId: true },
      orderBy: [
        { unitId: 'asc' },
        { isPrimary: 'desc' },
        { startedAt: 'asc' },
        { id: 'asc' },
      ],
    });
    const active = new Set(
      (
        await tx.account.findMany({
          where: {
            id: { in: [...new Set(owners.map((o) => o.accountId))] },
            status: 'active',
          },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    const out = new Map<string, string>();
    for (const o of owners) {
      if (out.has(o.unitId) || !active.has(o.accountId)) continue;
      const caps = await this.capabilities.placeOf(tx, o.accountId, o.unitId);
      if (caps?.governanceVote) out.set(o.unitId, o.accountId);
    }
    return out;
  }

  /** Every active account that owns a unit now, by id: who may stand. */
  async owners(tx: TenantTxClient): Promise<string[]> {
    const rows = await tx.unitOccupancy.findMany({
      where: { status: 'active', occupancyType: 'owner' },
      select: { accountId: true },
      distinct: ['accountId'],
    });
    const out: string[] = [];
    for (const { accountId } of rows.sort((a, b) =>
      a.accountId < b.accountId ? -1 : 1,
    ))
      if (await this.isOwner(tx, accountId)) out.push(accountId);
    return out;
  }

  /**
   * Owners for the manager's pickers: name and units, searched by name or
   * unit code (case-insensitive), at most `limit`.
   */
  async ownerDirectory(
    tx: TenantTxClient,
    search: string | undefined,
    limit: number,
  ): Promise<GovernanceOwner[]> {
    const q = search?.trim();
    const rows = await tx.unitOccupancy.findMany({
      where: {
        status: 'active',
        occupancyType: 'owner',
        account: { status: 'active' },
        ...(q
          ? {
              OR: [
                { account: { fullName: { contains: q, mode: 'insensitive' } } },
                { unit: { code: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: {
        accountId: true,
        account: { select: { fullName: true } },
        unit: { select: { code: true } },
      },
      orderBy: [{ accountId: 'asc' }],
    });
    const byAccount = new Map<string, GovernanceOwner>();
    for (const r of rows) {
      const o = byAccount.get(r.accountId) ?? {
        accountId: r.accountId,
        fullName: r.account.fullName,
        unitCodes: [],
      };
      o.unitCodes.push(r.unit.code);
      byAccount.set(r.accountId, o);
    }
    return [...byAccount.values()]
      .map((o) => ({ ...o, unitCodes: o.unitCodes.sort() }))
      .sort(
        (a, b) =>
          (a.fullName ?? '').localeCompare(b.fullName ?? '') ||
          (a.accountId < b.accountId ? -1 : 1),
      )
      .slice(0, limit);
  }

  /**
   * A unit in the building the account owns now (ADR 0059: who may be its
   * representative), the oldest first; null when it owns none there or is
   * not active.
   */
  async ownedUnitIn(
    tx: TenantTxClient,
    accountId: string,
    building: string,
  ): Promise<string | null> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (account?.status !== 'active') return null;
    const row = await tx.unitOccupancy.findFirst({
      where: {
        accountId,
        status: 'active',
        occupancyType: 'owner',
        unit: { building },
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { unitId: true },
    });
    return row?.unitId ?? null;
  }

  /**
   * As ownedUnitIn, at a board decision: the owner's occupancy row there
   * is share-locked, so an occupancy ending meanwhile either committed
   * first (and it owns none) or waits for the decision, whose new term its
   * residence check then sees and ends (ADR 0059).
   */
  async lockOwnedUnitIn(
    tx: TenantTxClient,
    accountId: string,
    building: string,
  ): Promise<string | null> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (account?.status !== 'active') return null;
    const rows = await tx.$queryRaw<{ unit_id: string }[]>`
      SELECT o.unit_id FROM unit_occupancies o
        JOIN units u ON u.tenant_id = o.tenant_id AND u.id = o.unit_id
       WHERE o.account_id = ${accountId}::uuid AND o.status = 'active'
         AND o.occupancy_type = 'owner' AND u.building = ${building}
       ORDER BY o.started_at, o.id
       FOR SHARE OF o`;
    return rows[0]?.unit_id ?? null;
  }

  /** The compound's buildings, as its units name them, sorted. */
  async buildings(tx: TenantTxClient): Promise<string[]> {
    const rows = await tx.unit.findMany({
      where: { building: { not: null } },
      select: { building: true },
      distinct: ['building'],
      orderBy: { building: 'asc' },
    });
    return rows.map((r) => r.building!);
  }

  /**
   * The active owners of a unit in the building (who may be its
   * representative): name and the codes of their units there, by name.
   */
  async buildingOwners(
    tx: TenantTxClient,
    building: string,
  ): Promise<GovernanceOwner[]> {
    const rows = await tx.unitOccupancy.findMany({
      where: {
        status: 'active',
        occupancyType: 'owner',
        account: { status: 'active' },
        unit: { building },
      },
      select: {
        accountId: true,
        account: { select: { fullName: true } },
        unit: { select: { code: true } },
      },
      orderBy: [{ accountId: 'asc' }],
    });
    const byAccount = new Map<string, GovernanceOwner>();
    for (const r of rows) {
      const o = byAccount.get(r.accountId) ?? {
        accountId: r.accountId,
        fullName: r.account.fullName,
        unitCodes: [],
      };
      o.unitCodes.push(r.unit.code);
      byAccount.set(r.accountId, o);
    }
    return [...byAccount.values()]
      .map((o) => ({ ...o, unitCodes: o.unitCodes.sort() }))
      .sort(
        (a, b) =>
          (a.fullName ?? '').localeCompare(b.fullName ?? '') ||
          (a.accountId < b.accountId ? -1 : 1),
      );
  }

  /** Whether any unit of the compound is in the building. */
  async buildingExists(tx: TenantTxClient, building: string): Promise<boolean> {
    return (await tx.unit.count({ where: { building } })) > 0;
  }

  /**
   * The units, with a building, where the account has a place now: an
   * active occupancy (an owner, a tenant, a landlord) or an active
   * household membership. Who a building's representative is told to, and
   * who may write to them (ADR 0059).
   */
  async buildingPlaces(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<{ unitId: string; code: string; building: string }[]> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (account?.status !== 'active') return [];
    const occupancies = await tx.unitOccupancy.findMany({
      where: { accountId, status: 'active' },
      select: { unitId: true },
    });
    const members = await tx.householdMember.findMany({
      where: { accountId, status: 'active' },
      select: { unitId: true },
    });
    const ids = [...new Set([...occupancies, ...members].map((r) => r.unitId))];
    if (!ids.length) return [];
    const units = await tx.unit.findMany({
      where: { id: { in: ids }, building: { not: null } },
      select: { id: true, code: true, building: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });
    return units.map((u) => ({
      unitId: u.id,
      code: u.code,
      building: u.building!,
    }));
  }

  /** Full names by account id; an erased account has none. */
  async names(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (!accountIds.length) return new Map();
    const rows = await tx.account.findMany({
      where: { id: { in: [...new Set(accountIds)] } },
      select: { id: true, fullName: true, status: true },
    });
    return new Map(
      rows.map((a) => [a.id, a.status === 'erased' ? null : a.fullName]),
    );
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
}
