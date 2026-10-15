import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type { Capabilities } from './capabilities/capabilities';
import { CapabilitiesService } from './capabilities/capabilities.service';

/** A unit as the finance views name it: its code and building, never a person. */
export interface FinanceUnit {
  id: string;
  code: string;
  building: string | null;
}

/**
 * What the finance domain reads from the community domain (ADR 0015, 0046),
 * and nothing else: what someone may do with a unit's money
 * (capabilitiesFor's financeView, financePay and the member's cap per
 * operation), who on a unit is told about it, and which units an issue
 * reaches. Every method takes the finance transaction, so the answer is
 * consistent with its write.
 */
@Injectable()
export class CommunityFinancePort {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /** The account's capabilities on the unit, or null with no place there. */
  placeIn(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Capabilities | null> {
    return this.capabilities.placeOf(tx, accountId, unitId);
  }

  /** Every active account that sees the unit's money now: who is told. */
  financeHolders(tx: TenantTxClient, unitId: string): Promise<string[]> {
    return this.capabilities.holders(tx, unitId, 'financeView');
  }

  /** The units whose money the account sees now. */
  financeUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    return this.capabilities.unitsWhere(tx, accountId, 'financeView');
  }

  /**
   * The units an issue reaches, by id: one unit, a building's, or every
   * unit of the compound. Units of another compound are invisible (RLS).
   */
  async unitsFor(
    tx: TenantTxClient,
    target: { unitId: string } | { building: string } | 'all',
  ): Promise<FinanceUnit[]> {
    return tx.unit.findMany({
      where:
        target === 'all'
          ? {}
          : 'unitId' in target
            ? { id: target.unitId }
            : { building: target.building },
      select: { id: true, code: true, building: true },
      orderBy: { id: 'asc' },
    });
  }

  async units(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, FinanceUnit>> {
    if (!unitIds.length) return new Map();
    const units = await tx.unit.findMany({
      where: { id: { in: [...new Set(unitIds)] } },
      select: { id: true, code: true, building: true },
    });
    return new Map(units.map((u) => [u.id, u]));
  }

  /** Names of staff accounts for a staff view; an erased account has none. */
  async staffNames(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (!accountIds.length) return new Map();
    const rows = await tx.account.findMany({
      where: {
        id: { in: [...new Set(accountIds)] },
        type: { in: ['manager', 'staff'] },
      },
      select: { id: true, fullName: true, status: true },
    });
    return new Map(
      rows.map((a) => [a.id, a.status === 'erased' ? null : a.fullName]),
    );
  }
}
