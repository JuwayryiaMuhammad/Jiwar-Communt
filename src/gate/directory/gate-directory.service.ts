import { Injectable } from '@nestjs/common';
import type { GateKind, Place } from '@prisma/client';
import {
  firstNameRef,
  type FirstNameRefView,
} from '../../core/common/http/personal';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { ShiftsService } from '../shifts/shifts.service';

/** A post's guards on shift: who, never how to reach them. */
export interface DirectoryGuards {
  guards: FirstNameRefView[];
}

export interface DirectoryGate extends DirectoryGuards {
  id: string;
  name: string;
  kind: GateKind;
  /** The gate's own phone (ADR 0043): to call the post, never a person. */
  phone: string | null;
}

export interface DirectoryZone extends DirectoryGuards {
  zone: Place;
}

export interface GateDirectory {
  gates: DirectoryGate[];
  zones: DirectoryZone[];
}

/**
 * The gate directory (ADR 0056), for a guard on duty at any post: the
 * compound's active gates with their gates' phones, and who is on shift at
 * each gate and in each zone — by first name, the rule for what guards see
 * of one another (ADR 0050). Never a personal phone, nor any guard's
 * contact: the gate's phone is the post's.
 */
@Injectable()
export class GateDirectoryService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly shifts: ShiftsService,
  ) {}

  directory(): Promise<GateDirectory> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOnDuty(tx);
      const gates = await tx.gate.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, kind: true, phone: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      const shifts = await tx.guardShift.findMany({
        where: { endedAt: null },
        select: { gateId: true, placeId: true, guardAccountId: true },
      });
      const accounts = new Map(
        (
          await tx.account.findMany({
            where: {
              id: { in: [...new Set(shifts.map((s) => s.guardAccountId))] },
              // A guard: active, their role still operating the gate.
              status: 'active',
              role: { permissions: { some: { permission: 'gate.operate' } } },
            },
            select: { id: true, fullName: true, status: true },
            orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
          })
        ).map((a) => [a.id, a]),
      );
      const at = (match: (s: (typeof shifts)[number]) => boolean) =>
        [...accounts.values()]
          .filter((a) =>
            shifts.some((s) => match(s) && s.guardAccountId === a.id),
          )
          .map((a) => firstNameRef(a));
      const placeIds = [
        ...new Set(shifts.flatMap((s) => (s.placeId ? [s.placeId] : []))),
      ];
      const places = await tx.place.findMany({
        where: { id: { in: placeIds } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      return {
        gates: gates.map((g) => ({
          ...g,
          guards: at((s) => s.gateId === g.id),
        })),
        zones: places.map((zone) => ({
          zone,
          guards: at((s) => s.placeId === zone.id),
        })),
      };
    });
  }
}
