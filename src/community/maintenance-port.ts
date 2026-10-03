import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type { Capabilities } from './capabilities/capabilities';
import { CapabilitiesService } from './capabilities/capabilities.service';

/**
 * What the maintenance domain reads from the community domain (ADR 0015,
 * 0032), and nothing else: units, who may open tickets on a unit
 * (capabilitiesFor's `tickets`) and the unit's primary. Every method takes
 * the maintenance transaction, so the answer is consistent with its write.
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
