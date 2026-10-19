import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ServiceVehicleVisit } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  normalizePlate,
  PLATE_MAX,
  plateKey,
} from '../../core/common/vehicle-plate';
import type { Env } from '../../core/config/env.schema';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { BlocklistMatcher, entryBlocked } from '../blocklist/blocklist-matcher';
import { dbNow } from '../db-clock';
import { LockdownCore } from '../lockdown/lockdown-core';
import { RosterCore } from '../roster/roster-core';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import { COMPANY_MAX, type ServiceVehicleKind } from './service-vehicle-rules';

export const SERVICE_VEHICLE_RESOURCE = 'service_vehicle_visit';
export const SERVICE_VEHICLE_EXITS_SWEEP = 'gate.service_vehicle_exits';
const PAGE = keysetCursor('enteredAt');

/** A ban refused the plate: what the entry's transaction answers then. */
const BLOCKED = Symbol('blocked');

export interface NewServiceVehicle {
  plate: string;
  kind: ServiceVehicleKind;
  company: string;
  unitCode?: string;
  facilityId?: string;
}

/** A visit as the gate and the management read it. Never who recorded it. */
export interface ServiceVehicleRecord {
  id: string;
  plate: string;
  kind: ServiceVehicleKind;
  company: string;
  unitCode: string | null;
  facility: { id: string; nameEn: string; nameAr: string } | null;
  enteredAt: Date;
  enteredGate: { id: string; name: string };
  exitedAt: Date | null;
  exitedGate: { id: string; name: string } | null;
  exitUnconfirmed: boolean;
}

export const serviceVehicleNotFound = () =>
  appError.notFound(
    ErrorCode.SERVICE_VEHICLE_NOT_FOUND,
    'Service vehicle not found',
  );

/**
 * Service vehicles at the gate (ADR 0056): tankers, waste trucks,
 * deliveries and others, in and out, recorded by a guard on shift at a
 * gate. The plate is matched as every plate: a lockdown refuses the entry,
 * a ban on the blocklist refuses it (recorded, the keepers told), a watch
 * lets it in and flags it. Exits are always recorded.
 *
 * A plate is inside once at a time: the entry takes the plate's lock (an
 * advisory key on its folded form), so two entries of one plate at once
 * come in once; the table's partial unique index says the same.
 *
 * Lock order: the guard's account (FOR SHARE), the shift (FOR SHARE), the
 * lockdown row (FOR SHARE), the blocklist (shared), the plate's lock, the
 * visit's row.
 */
@Injectable()
export class ServiceVehiclesService implements OnModuleInit {
  private readonly unconfirmedAfterMs: number;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly shifts: ShiftsService,
    private readonly community: CommunityGatePort,
    private readonly safety: SafetyCore,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
    private readonly lockdown: LockdownCore,
    private readonly matcher: BlocklistMatcher,
    private readonly roster: RosterCore,
    config: ConfigService<Env, true>,
  ) {
    this.unconfirmedAfterMs =
      config.get('GATE_UNCONFIRMED_EXIT_HOURS', { infer: true }) * 3_600_000;
  }

  onModuleInit(): void {
    this.idempotency.renderer(SERVICE_VEHICLE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.render(tx, await this.row(tx, id)),
      ),
    );
    // Inside past GATE_UNCONFIRMED_EXIT_HOURS: the system's unconfirmed
    // exit, as for every subject of the gate log (ADR 0028), so the plate
    // may come in again.
    this.sweep.register(SERVICE_VEHICLE_EXITS_SWEEP, (now) =>
      this.sweep.forEachTenant(async (tx) => {
        const before = new Date(now.getTime() - this.unconfirmedAfterMs);
        const due = await tx.serviceVehicleVisit.findMany({
          where: { exitedAt: null, enteredAt: { lt: before } },
          select: { id: true },
        });
        let closed = 0;
        for (const v of due) {
          const held = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM service_vehicle_visits
             WHERE id = ${v.id}::uuid AND exited_at IS NULL FOR UPDATE SKIP LOCKED`;
          if (!held.length) continue;
          const row = await this.row(tx, v.id);
          await tx.serviceVehicleVisit.update({
            where: { id: v.id },
            data: {
              exitedAt: await dbNow(tx),
              exitedGateId: row.enteredGateId,
              exitUnconfirmed: true,
            },
          });
          await this.cls.run({ ifNested: 'inherit' }, async () => {
            this.cls.set('auditActor', { type: 'system', id: null });
            await this.audit.record(tx, {
              action: 'service_vehicle.exit_unconfirmed',
              targetId: v.id,
              metadata: { gateId: row.enteredGateId },
            });
          });
          closed++;
        }
        return closed;
      }),
    );
  }

  /** In at the guard's gate. */
  async enter(input: NewServiceVehicle): Promise<ServiceVehicleRecord> {
    const plate = normalizePlate(input.plate);
    const company = input.company.trim().replace(/\s+/g, ' ');
    const fields: FieldError[] = [];
    if (!plate)
      fields.push({
        field: 'plate',
        code: FieldErrorCode.INVALID_FORMAT,
        params: { maxLength: PLATE_MAX },
      });
    // A blank company is no company.
    if (!company || company.length > COMPANY_MAX)
      fields.push({
        field: 'company',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: COMPANY_MAX },
      });
    // A unit or a facility served, never both.
    if (input.unitCode !== undefined && input.facilityId !== undefined)
      fields.push({
        field: 'facilityId',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid service vehicle',
        { fields },
      );
    const made = await this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      await this.lockdown.refuseIn(tx, shift.gateId, await dbNow(tx));
      const met = await this.matcher.check(tx, { plates: [plate] });
      if (met.kind === 'ban') {
        await this.matcher.record(tx, met, {
          source: 'service_vehicle',
          outcome: 'refused',
          gateId: shift.gateId,
          shiftId: shift.id,
        });
        return BLOCKED;
      }
      const id = newId();
      await this.idempotency.claim(tx, { type: SERVICE_VEHICLE_RESOURCE, id });
      // One plate at a time: an entry of the same plate waits here.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`service-vehicle-plate:${tenantId}:${plateKey(plate!)}`}))`;
      const inside = await tx.serviceVehicleVisit.findFirst({
        where: { plateKey: plateKey(plate!), exitedAt: null },
        select: { id: true },
      });
      if (inside)
        throw appError.conflict(
          ErrorCode.SERVICE_VEHICLE_INSIDE,
          'This vehicle is inside: record its exit first',
          { params: { id: inside.id } },
        );
      let unitId: string | null = null;
      if (input.unitCode !== undefined) {
        const unit = await this.community.unitByCode(tx, input.unitCode.trim());
        if (!unit)
          throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
        unitId = unit.id;
      }
      if (
        input.facilityId !== undefined &&
        !(await tx.facility.findUnique({
          where: { id: input.facilityId },
          select: { id: true },
        }))
      )
        throw appError.notFound(
          ErrorCode.FACILITY_NOT_FOUND,
          'Facility not found',
        );
      const visit = await tx.serviceVehicleVisit.create({
        data: {
          id,
          tenantId,
          plate: plate!,
          kind: input.kind,
          company,
          unitId,
          facilityId: input.facilityId ?? null,
          enteredAt: await dbNow(tx),
          enteredGateId: shift.gateId,
          enteredShiftId: shift.id,
          enteredById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'service_vehicle.entered',
        targetId: id,
        metadata: {
          kind: input.kind,
          unitId,
          facilityId: input.facilityId ?? null,
          gateId: shift.gateId,
          shiftId: shift.id,
        },
      });
      // A watched plate: in, and the keepers told.
      await this.matcher.record(tx, met, {
        source: 'service_vehicle',
        outcome: 'flagged',
        subject: { type: 'service_vehicle', id },
        gateId: shift.gateId,
        shiftId: shift.id,
      });
      return this.render(tx, visit);
    });
    if (made === BLOCKED) throw entryBlocked();
    return made;
  }

  /** Out at the guard's gate, once. */
  exit(id: string): Promise<ServiceVehicleRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      await this.row(tx, id);
      await this.idempotency.claim(tx, { type: SERVICE_VEHICLE_RESOURCE, id });
      await tx.$queryRaw`SELECT id FROM service_vehicle_visits WHERE id = ${id}::uuid FOR UPDATE`;
      const visit = await this.row(tx, id);
      if (visit.exitedAt)
        throw appError.conflict(
          ErrorCode.SERVICE_VEHICLE_NOT_INSIDE,
          'Its exit was recorded already',
        );
      const updated = await tx.serviceVehicleVisit.update({
        where: { id },
        data: {
          exitedAt: await dbNow(tx),
          exitedGateId: shift.gateId,
          exitedShiftId: shift.id,
          exitedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'service_vehicle.exited',
        targetId: id,
        metadata: { gateId: shift.gateId, shiftId: shift.id },
      });
      return this.render(tx, updated);
    });
  }

  /** The gate: who is inside now, newest first. */
  inside(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<ServiceVehicleRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOpen(tx);
      return this.page(tx, { exitedAt: null }, q);
    });
  }

  /**
   * The management's log: the visits that came in on the compound's days
   * asked (today by default, 31 at most), newest first.
   */
  log(q: {
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ServiceVehicleRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const period = await this.roster.period(tx, q, { back: 0, span: 0 });
      return this.page(
        tx,
        { enteredAt: { gte: period.start, lt: period.end } },
        q,
      );
    });
  }

  private async page(
    tx: TenantTxClient,
    where: Prisma.ServiceVehicleVisitWhereInput,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<ServiceVehicleRecord>> {
    const limit = clampLimit(q.limit);
    const rows = await tx.serviceVehicleVisit.findMany({
      where: {
        AND: [
          where,
          ...(PAGE.after(q.cursor) as Prisma.ServiceVehicleVisitWhereInput[]),
        ],
      },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    const page = PAGE.toPage(rows, limit);
    const items: ServiceVehicleRecord[] = [];
    for (const r of page.items) items.push(await this.render(tx, r));
    return { items, nextCursor: page.nextCursor };
  }

  private async row(
    tx: TenantTxClient,
    id: string,
  ): Promise<ServiceVehicleVisit> {
    const row = await tx.serviceVehicleVisit.findUnique({ where: { id } });
    if (!row) throw serviceVehicleNotFound();
    return row;
  }

  private async render(
    tx: TenantTxClient,
    v: ServiceVehicleVisit,
  ): Promise<ServiceVehicleRecord> {
    const gates = new Map(
      (
        await tx.gate.findMany({
          where: {
            id: {
              in: [
                v.enteredGateId,
                ...(v.exitedGateId ? [v.exitedGateId] : []),
              ],
            },
          },
          select: { id: true, name: true },
        })
      ).map((g) => [g.id, g]),
    );
    // The facility's names: read, never imported (nothing imports facilities).
    const facility = v.facilityId
      ? await tx.facility.findUnique({
          where: { id: v.facilityId },
          select: { id: true, nameEn: true, nameAr: true },
        })
      : null;
    return {
      id: v.id,
      plate: v.plate,
      kind: v.kind as ServiceVehicleKind,
      company: v.company,
      unitCode: v.unitId ? await this.community.unitCode(tx, v.unitId) : null,
      facility,
      enteredAt: v.enteredAt,
      enteredGate: gates.get(v.enteredGateId)!,
      exitedAt: v.exitedAt,
      exitedGate: v.exitedGateId ? (gates.get(v.exitedGateId) ?? null) : null,
      exitUnconfirmed: v.exitUnconfirmed,
    };
  }
}
