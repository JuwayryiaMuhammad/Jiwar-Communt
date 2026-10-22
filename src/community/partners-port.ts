import { Injectable } from '@nestjs/common';
import { firstNameOf } from '../core/common/http/personal';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type { Capabilities } from './capabilities/capabilities';
import { CapabilitiesService } from './capabilities/capabilities.service';

/** A unit as a partner request names it. */
export interface PartnerUnit {
  id: string;
  code: string;
  building: string | null;
}

/**
 * What the partners domain reads from the community domain (ADR 0015,
 * 0060), and nothing else: what someone may do on a unit
 * (capabilitiesFor's `visitorsInvite`: the partner's staff come to the
 * door), the unit's code and building, the compound's buildings, and the
 * first names a partner may see. Every method takes the partners
 * transaction, so the answer is consistent with its write.
 */
@Injectable()
export class CommunityPartnersPort {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /** The account's capabilities on the unit, or null with no place there. */
  placeIn(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Capabilities | null> {
    return this.capabilities.placeOf(tx, accountId, unitId);
  }

  /** The units the account may invite visitors to now. */
  invitingUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    return this.capabilities.unitsWhere(tx, accountId, 'visitorsInvite');
  }

  unit(tx: TenantTxClient, unitId: string): Promise<PartnerUnit | null> {
    return tx.unit.findUnique({
      where: { id: unitId },
      select: { id: true, code: true, building: true },
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
   * First names, by account id: all a partner ever learns of who asked
   * (ADR 0060). An account that is not active has none.
   */
  async firstNames(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (!accountIds.length) return new Map();
    const rows = await tx.account.findMany({
      where: { id: { in: [...new Set(accountIds)] } },
      select: { id: true, fullName: true, status: true },
    });
    return new Map(
      rows.map((a) => [
        a.id,
        a.status === 'active' ? firstNameOf(a.fullName) : null,
      ]),
    );
  }
}
