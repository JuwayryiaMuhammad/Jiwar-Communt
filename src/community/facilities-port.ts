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

  /** Every active account that may book for the unit now. */
  bookers(tx: TenantTxClient, unitId: string): Promise<string[]> {
    return this.capabilities.holders(tx, unitId, 'bookings');
  }

  /** The units the account may book for now. */
  bookingUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    return this.capabilities.unitsWhere(tx, accountId, 'bookings');
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
