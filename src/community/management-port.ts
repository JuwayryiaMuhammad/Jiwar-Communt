import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { CapabilitiesService } from './capabilities/capabilities.service';

/** Someone a request may be opened for: an id and a name. */
export interface RequestAuthor {
  id: string;
  fullName: string | null;
}

/** Who can be a request's author at all: the people of a household. */
const AUTHOR_TYPES = ['resident', 'family'] as const;

/**
 * What the management domain reads from the community domain (ADR 0015,
 * 0039), and nothing else: whether an account may be a request's author
 * (an active resident or family account), whether a unit is one of the
 * author's, a unit's people, its primary (ADR 0059), and unit codes. Every method takes the
 * management transaction, so the answer is consistent with its write.
 */
@Injectable()
export class CommunityManagementPort {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /**
   * The account as a request's author, or null: active, and a resident or
   * a family account (a landlord is a resident account).
   */
  author(tx: TenantTxClient, accountId: string): Promise<RequestAuthor | null> {
    return tx.account.findFirst({
      where: {
        id: accountId,
        status: 'active',
        type: { in: [...AUTHOR_TYPES] },
      },
      select: { id: true, fullName: true },
    });
  }

  /**
   * Whether the unit is one of the account's: a place there that sees the
   * unit (ADR 0020's `unitView`) — an occupant, a landlord, a member of its
   * household. Someone who left it no longer names it on a new request.
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

  /**
   * Everyone a request may be opened for on the unit, by name: the accounts
   * `author` accepts for whom `hasUnit` is true there.
   */
  async authorsOf(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<RequestAuthor[]> {
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
    if (!candidates.length) return [];
    const accounts = await tx.account.findMany({
      where: {
        id: { in: candidates },
        status: 'active',
        type: { in: [...AUTHOR_TYPES] },
      },
      select: { id: true, fullName: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
    const out: RequestAuthor[] = [];
    for (const a of accounts)
      if (await this.hasUnit(tx, a.id, unitId)) out.push(a);
    return out;
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

  /** The unit's primary resident now, or null (ADR 0059: told of an appeal). */
  async primaryOf(tx: TenantTxClient, unitId: string): Promise<string | null> {
    const row = await tx.unitOccupancy.findFirst({
      where: { unitId, status: 'active', isPrimary: true },
      select: { accountId: true },
    });
    return row?.accountId ?? null;
  }

  /** The units the account is the primary resident of now (ADR 0059). */
  async primaryUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    const rows = await tx.unitOccupancy.findMany({
      where: { accountId, status: 'active', isPrimary: true },
      select: { unitId: true },
    });
    return rows.map((r) => r.unitId);
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
