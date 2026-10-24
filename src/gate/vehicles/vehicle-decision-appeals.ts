import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Vehicle } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { addDays } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  DecisionAppeals,
  type DecisionAppealEffect,
  type OverturnInput,
} from '../../core/decision-appeals/decision-appeals';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { VehicleCore } from './vehicle-core';
import { asDate, MAX_PERMIT_DAYS, normalizeSticker } from './vehicle-rules';

/** A local day, YYYY-MM-DD. */
const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * A rejected vehicle appealed to the management (ADR 0059), registered with
 * core's DecisionAppeals. Its keepers (whoever keeps vehicles on the unit)
 * or the unit's primary appeal it.
 *
 * An overturn activates it through the checks of the staff's approval and
 * of a registration, in the vehicles' lock order (the unit's vehicles
 * lock, the plate's lock, the row): the manager gives the sticker and the
 * permit's last day, as an approval asks (`needs_sticker` without them);
 * its registrant may still keep vehicles on the unit; the unit has room
 * (a rejected vehicle frees its place); no other vehicle holds the plate;
 * the day is after today and at most 731 days ahead; the sticker was never
 * issued. A vehicle re-plated or removed since did not stand rejected as
 * appealed (`none`). Any refusal leaves it rejected, for the management to
 * follow up. Applied, its registrant is told as an approval tells them.
 */
@Injectable()
export class VehicleDecisionAppeals implements OnModuleInit {
  constructor(
    private readonly registry: DecisionAppeals,
    private readonly core: VehicleCore,
    private readonly community: CommunityGatePort,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registry.register('vehicle_rejection', {
      resolve: async (tx, id, accountId) => {
        const v = await this.lockRow(tx, id);
        if (!v || v.status === 'removed') return null;
        const place = await this.community.placeIn(tx, accountId, v.unitId);
        if (!place?.unitView) return null;
        return {
          unitId: v.unitId,
          decidedAt: v.status === 'rejected' ? v.decidedAt : null,
          deciderId: v.decidedById,
          mayAppeal:
            place.vehicles ||
            (await this.community.isPrimary(tx, v.unitId, accountId)),
          refused: v.status !== 'rejected' ? 'not_in_force' : null,
        };
      },
      // Nothing to mark: a rejected vehicle has no sweep, and a new plate
      // (a pending vehicle again) moots the appeal (`changed`).
      lodged: () => Promise.resolve(),
      closed: (tx, id, outcome, ev) => this.closed(tx, id, outcome, ev),
      describe: async (tx, id) => {
        const v = await tx.vehicle.findUnique({ where: { id } });
        if (!v) return null;
        return {
          status: v.status,
          type: v.type,
          rejectionReason: v.rejectionReason,
          decidedAt: v.decidedAt,
          version: v.version,
        };
      },
    });
  }

  private async closed(
    tx: TenantTxClient,
    id: string,
    outcome: 'upheld' | 'overturned' | 'withdrawn',
    ev: {
      now: Date;
      decidedById: string | null;
      decisionAt: Date;
      appealId: string;
      overturn?: OverturnInput;
    },
  ): Promise<DecisionAppealEffect> {
    if (outcome !== 'overturned') return { effect: 'none' };
    const seen = await tx.vehicle.findUnique({ where: { id } });
    if (!seen) return { effect: 'none', reason: 'changed' };
    // The vehicles' lock order: the unit, the plate, the row.
    await this.core.lockUnitVehicles(tx, seen.unitId);
    await this.core.lockPlate(tx, seen.plateKey ?? '');
    const v = await this.lockRow(tx, id);
    if (
      !v ||
      v.status !== 'rejected' ||
      v.plateKey !== seen.plateKey ||
      v.decidedAt?.getTime() !== ev.decisionAt.getTime()
    )
      return { effect: 'none', reason: 'changed' };
    const sticker = ev.overturn?.stickerNumber
      ? normalizeSticker(ev.overturn.stickerNumber)
      : null;
    const day = ev.overturn?.permitValidUntil ?? null;
    // A board's overturn names no deciding account: a person approves it.
    if (!sticker || !day || !LOCAL_DATE.test(day) || !ev.decidedById)
      return { effect: 'follow_up', reason: 'needs_sticker' };
    const registrant = await tx.account.findUnique({
      where: { id: v.registeredById },
      select: { status: true },
    });
    const place =
      registrant?.status === 'active'
        ? await this.community.placeIn(tx, v.registeredById, v.unitId)
        : null;
    if (!place?.vehicles)
      return { effect: 'follow_up', reason: 'registrant_gone' };
    const { maxVehiclesPerUnit } = await this.core.settings(tx);
    const held = await tx.vehicle.count({
      where: {
        unitId: v.unitId,
        status: { in: ['pending', 'active'] },
        id: { not: v.id },
      },
    });
    if (held >= maxVehiclesPerUnit)
      return { effect: 'follow_up', reason: 'unit_limit' };
    if (
      await tx.vehicle.count({
        where: { plateKey: v.plateKey, status: 'active' },
      })
    )
      return { effect: 'follow_up', reason: 'plate_active' };
    const { today } = await this.core.clock(tx);
    if (day < addDays(today, 1) || day > addDays(today, MAX_PERMIT_DAYS))
      return { effect: 'follow_up', reason: 'permit_date' };
    if (
      await tx.vehicleSticker.findFirst({
        where: { stickerNumber: sticker },
        select: { id: true },
      })
    )
      return { effect: 'follow_up', reason: 'sticker_used' };
    await tx.vehicleSticker.create({
      data: {
        id: newId(),
        tenantId: v.tenantId,
        vehicleId: id,
        stickerNumber: sticker,
        issuedById: ev.decidedById,
      },
    });
    await tx.vehicle.update({
      where: { id },
      data: {
        status: 'active',
        stickerNumber: sticker,
        permitValidUntil: asDate(day),
        rejectionReason: null,
        decidedById: ev.decidedById,
        decidedAt: ev.now,
      },
    });
    await this.audit.record(tx, {
      action: 'vehicle.approved',
      targetId: id,
      metadata: {
        unitId: v.unitId,
        stickerNumber: sticker,
        permitValidUntil: day,
        version: v.version,
        appealId: ev.appealId,
      },
    });
    await this.core.notify(
      tx,
      [v.registeredById],
      'vehicle.approved',
      id,
      {},
      ev.decidedById,
    );
    return { effect: 'applied' };
  }

  private async lockRow(
    tx: TenantTxClient,
    id: string,
  ): Promise<Vehicle | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vehicles WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.vehicle.findUniqueOrThrow({ where: { id } });
  }
}
