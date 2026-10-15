import { Injectable } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';

export interface FamilyContact {
  accountId: string;
  name: string | null;
  role: 'owner' | 'tenant' | 'member';
  isPrimary: boolean;
  phone: string | null;
}

export interface GateContact {
  gateId: string;
  name: string;
  phone: string;
}

export interface ManagementContact {
  role: 'office' | 'duty' | 'emergency';
  phone: string;
}

export interface EmergencyContacts {
  family: FamilyContact[];
  gates: GateContact[];
  management: ManagementContact[];
}

/**
 * A unit's emergency contacts (ADR 0047), for anyone whose emergency button
 * the unit carries (capabilities.emergency):
 * - the family: the other people who live there, with their phones — only
 *   for someone who lives there too; a landlord gets none;
 * - the gates in service that have a phone;
 * - the management: the office, the duty manager and the compound's
 *   emergency number, each when set.
 * Every number is a person's own only among the family; the rest are the
 * compound's.
 */
@Injectable()
export class EmergencyContactsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
    private readonly settings: TenantSettingsService,
  ) {}

  forUnit(unitId: string): Promise<EmergencyContacts> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      const caps = await this.community.placeIn(tx, me, unitId);
      if (!caps?.emergency)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      let family: FamilyContact[] = [];
      if (caps.gateEntry) {
        const residents = (await this.community.residents(tx, unitId)).filter(
          (r) => r.accountId !== me,
        );
        const accounts = new Map(
          (
            await tx.account.findMany({
              where: { id: { in: residents.map((r) => r.accountId) } },
              select: { id: true, fullName: true, phone: true },
            })
          ).map((a) => [a.id, a]),
        );
        family = residents.map((r) => ({
          accountId: r.accountId,
          name: accounts.get(r.accountId)?.fullName ?? null,
          role: r.role,
          isPrimary: r.isPrimary,
          phone: accounts.get(r.accountId)?.phone ?? null,
        }));
      }
      const gates = await tx.gate.findMany({
        where: { status: 'active', phone: { not: null } },
        select: { id: true, name: true, phone: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      const s = await this.settings.inTx(tx, this.ctx.txTenantId);
      const management: ManagementContact[] = [
        { role: 'office' as const, phone: s.officePhone },
        { role: 'duty' as const, phone: s.dutyPhone },
        { role: 'emergency' as const, phone: s.emergencyPhone },
      ].flatMap((c) => (c.phone ? [{ role: c.role, phone: c.phone }] : []));
      return {
        family,
        gates: gates.map((g) => ({
          gateId: g.id,
          name: g.name,
          phone: g.phone!,
        })),
        management,
      };
    });
  }
}
