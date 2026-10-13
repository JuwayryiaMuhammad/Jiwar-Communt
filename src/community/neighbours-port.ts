import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { CapabilitiesService } from './capabilities/capabilities.service';
import { lockUnits } from './units/unit-lock';

/** A unit as the neighbours domain names it. */
export interface NeighbourUnit {
  id: string;
  code: string;
  /** Free text on the unit; a unit may have none. */
  building: string | null;
}

/** Who a notice to a unit goes to: the household living in it, or its owners. */
export type NoticeRecipientKind = 'household' | 'owners';

export interface NoticeRecipients {
  kind: NoticeRecipientKind;
  accountIds: string[];
}

/** Who can write in the neighbours domain at all: the people of a household. */
const AUTHOR_TYPES = ['resident', 'family'] as const;

/**
 * What the neighbours domain reads from the community domain (ADR 0015,
 * 0042), and nothing else: whether an account is one of the compound's
 * people, which units are theirs, a unit by its code, and who answers for
 * a unit. Every method takes the neighbours transaction, so the answer is
 * consistent with its write.
 */
@Injectable()
export class CommunityNeighboursPort {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /** Whether the account is an active resident or family account. */
  async isResident(tx: TenantTxClient, accountId: string): Promise<boolean> {
    return (
      (await tx.account.count({
        where: {
          id: accountId,
          status: 'active',
          type: { in: [...AUTHOR_TYPES] },
        },
      })) > 0
    );
  }

  /**
   * The units the account has a place in now: its active occupancies (a
   * landlord's included) and its active memberships of a household.
   */
  async places(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<NeighbourUnit[]> {
    const occupancies = await tx.unitOccupancy.findMany({
      where: { accountId, status: 'active' },
      select: { unit: { select: { id: true, code: true, building: true } } },
    });
    const memberships = await tx.householdMember.findMany({
      where: { accountId, status: 'active' },
      select: { unit: { select: { id: true, code: true, building: true } } },
    });
    const units = new Map<string, NeighbourUnit>();
    for (const p of [...occupancies, ...memberships])
      units.set(p.unit.id, p.unit);
    return [...units.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  /**
   * Whether the unit is one of the account's: a place there that sees the
   * unit (ADR 0020's `unitView`).
   */
  async hasUnit(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<boolean> {
    return (
      (await this.capabilities.placeOf(tx, accountId, unitId))?.unitView ===
      true
    );
  }

  /** The unit with exactly this code, whoever lives in it or nobody. */
  unitByCode(tx: TenantTxClient, code: string): Promise<NeighbourUnit | null> {
    return tx.unit.findFirst({
      where: { code: code.trim() },
      select: { id: true, code: true, building: true },
    });
  }

  unit(tx: TenantTxClient, unitId: string): Promise<NeighbourUnit | null> {
    return tx.unit.findUnique({
      where: { id: unitId },
      select: { id: true, code: true, building: true },
    });
  }

  async units(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, NeighbourUnit>> {
    if (!unitIds.length) return new Map();
    const units = await tx.unit.findMany({
      where: { id: { in: [...new Set(unitIds)] } },
      select: { id: true, code: true, building: true },
    });
    return new Map(units.map((u) => [u.id, u]));
  }

  lockUnit(tx: TenantTxClient, unitId: string): Promise<void> {
    return lockUnits(tx, [unitId]);
  }

  /**
   * Who answers for the unit now (ADR 0042):
   * - the household living in it: its primary and whoever the primary has
   *   delegated the household to (a live, unexpired delegation, ADR 0016);
   *   with nobody primary, everyone who lives there by an occupancy;
   * - nobody lives there: its owners.
   * Active accounts only. Call under the unit's lock when the answer is
   * written down.
   */
  async noticeRecipients(
    tx: TenantTxClient,
    unitId: string,
    now: Date,
  ): Promise<NoticeRecipients> {
    const residing = await tx.unitOccupancy.findMany({
      where: {
        unitId,
        status: 'active',
        resides: true,
        account: { status: 'active' },
      },
      select: { accountId: true, isPrimary: true },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
    const anyResiding = await tx.unitOccupancy.count({
      where: { unitId, status: 'active', resides: true },
    });
    if (!anyResiding) {
      const owners = await tx.unitOccupancy.findMany({
        where: {
          unitId,
          status: 'active',
          occupancyType: 'owner',
          account: { status: 'active' },
        },
        select: { accountId: true },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      });
      return { kind: 'owners', accountIds: owners.map((o) => o.accountId) };
    }
    const primary = residing.find((o) => o.isPrimary);
    if (!primary)
      return {
        kind: 'household',
        accountIds: residing.map((o) => o.accountId),
      };
    const delegations = await tx.householdDelegation.findMany({
      where: {
        unitId,
        delegatorAccountId: primary.accountId,
        revokedAt: null,
        expiresAt: { gt: now },
        scopes: { has: 'household' },
        delegate: { status: 'active' },
      },
      select: { delegateAccountId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      kind: 'household',
      accountIds: [
        ...new Set([
          primary.accountId,
          ...delegations.map((d) => d.delegateAccountId),
        ]),
      ],
    };
  }

  /**
   * Whether someone a notice went to still answers for the unit in the same
   * capacity: one of the household's recipients now, or still an owner. A
   * household that moved out, or a delegation that ended, no longer reads
   * what was sent to it.
   */
  async stillRecipient(
    tx: TenantTxClient,
    unitId: string,
    accountId: string,
    kind: NoticeRecipientKind,
    now: Date,
  ): Promise<boolean> {
    if (kind === 'owners')
      return (
        (await tx.unitOccupancy.count({
          where: {
            unitId,
            accountId,
            status: 'active',
            occupancyType: 'owner',
          },
        })) > 0
      );
    const current = await this.noticeRecipients(tx, unitId, now);
    return (
      current.kind === 'household' && current.accountIds.includes(accountId)
    );
  }
}
