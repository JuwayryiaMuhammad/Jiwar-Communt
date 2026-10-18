import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { UnitPermit, Vehicle, VisitorPass } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { localDate } from '../../core/common/slots/day-slots';
import {
  normalizePlate,
  PLATE_MAX,
  plateKey,
} from '../../core/common/vehicle-plate';
import type { Env } from '../../core/config/env.schema';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { GateSubjects, type Refusal } from '../entries/subjects';
import {
  VisitorParkingService,
  type GuardBooking,
  type GuardParking,
} from '../parking/visitor-parking.service';
import { ShiftsService } from '../shifts/shifts.service';
import { VehicleCore } from './vehicle-core';
import { dayOf, permitStatus, type PermitStatus } from './vehicle-rules';
import { BlocklistMatcher } from '../blocklist/blocklist-matcher';
import { LockdownCore } from '../lockdown/lockdown-core';

const DAY = 86_400_000;

export interface VehicleMatch {
  kind: 'vehicle';
  unitCode: string;
  vehicle: Vehicle;
  permitStatus: PermitStatus;
}

export interface PassMatch {
  kind: 'visitor_pass';
  unitCode: string;
  pass: VisitorPass;
  plate: string;
  /** Null: the pass lets its visitor in now. */
  refusal: Refusal | null;
  parking: GuardParking | null;
}

/** A move's truck, or an event guest's car (ADR 0049). */
export interface PermitMatch {
  kind: 'unit_permit';
  unitCode: string;
  permit: UnitPermit;
  plate: string;
  /** What to record the entry against. */
  subjectType: 'move_permit' | 'event_guest';
  subjectId: string;
  /** Null: the permit lets them in now. */
  refusal: Refusal | null;
}

export interface PlateLookup {
  plate: string;
  matches: (VehicleMatch | PassMatch | PermitMatch)[];
  /** The live blocklist entries for the plate (ADR 0053). */
  blocklist: { entryId: string; kind: 'ban' | 'watch' }[];
}

/**
 * The guard's plate lookup (ADR 0045), `gate.operate`, inside an open
 * shift and the guard's own rate limit. A plate is matched by its key:
 * the unit's pending and active vehicles (with the permit's status), and
 * the active visitor passes carrying it that are valid within a day (with
 * whether the visitor may come in now, and their parking booking). Never a
 * name: neither the registrant's nor the visitor's.
 *
 * Every lookup is audited (`gate.plate_lookup`, on the guard's shift) with
 * the ids it found and their count — never the plate, nor a hash of it: a
 * plate is a few letters and digits, so an unkeyed hash would be read back
 * by trying them all.
 */
@Injectable()
export class PlateLookupService {
  private readonly perMinute: number;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
    private readonly subjects: GateSubjects,
    private readonly settings: TenantSettingsService,
    private readonly rateLimit: RateLimitService,
    private readonly core: VehicleCore,
    private readonly parking: VisitorParkingService,
    private readonly lockdown: LockdownCore,
    private readonly matcher: BlocklistMatcher,
    config: ConfigService<Env, true>,
  ) {
    this.perMinute = config.get('GATE_VERIFY_RATE_LIMIT_PER_MINUTE', {
      infer: true,
    });
  }

  async lookup(raw: string): Promise<PlateLookup> {
    const plate = normalizePlate(raw);
    if (!plate)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid plate', {
        fields: [
          {
            field: 'plate',
            code: FieldErrorCode.INVALID_FORMAT,
            params: { maxLength: PLATE_MAX },
          },
        ],
      });
    const key = plateKey(plate);
    // The shift first: a guard off duty learns nothing about any plate.
    const shift = await this.tenantTx.withTenantTx((tx) =>
      this.shifts.requireOpen(tx),
    );
    await this.rateLimit.consume(
      `gate-plate:account:${this.ctx.accountId}`,
      this.perMinute,
      60,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = localDate(now, timezone);
      // A lockdown (ADR 0053): nobody a plate names may come in now. A ban
      // on the plate refuses whoever it names; a watch only says so.
      const locked = (await this.lockdown.live(tx, shift.gateId)) !== null;
      const met = await this.matcher.check(tx, { plates: [plate] });
      const block: Refusal | null = locked
        ? 'lockdown_active'
        : met.kind === 'ban'
          ? 'entry_blocked'
          : null;
      const vehicles = await tx.vehicle.findMany({
        where: { plateKey: key, status: { in: ['pending', 'active'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const passes = await tx.visitorPass.findMany({
        where: {
          status: 'active',
          validFrom: { lt: new Date(now.getTime() + DAY) },
          validUntil: { gt: new Date(now.getTime() - DAY) },
          visitorDetails: { plateKey: key },
        },
        include: { visitorDetails: { select: { vehiclePlate: true } } },
        orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      });
      // A move's truck and an event guest's car (ADR 0049): approved
      // permits within a day of now, a guest still on the list.
      const near = {
        status: 'approved' as const,
        startsAt: { lt: new Date(now.getTime() + DAY) },
        endsAt: { gt: new Date(now.getTime() - DAY) },
      };
      const moves = await tx.unitPermit.findMany({
        where: { ...near, kind: 'move', plateKey: key },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      });
      const guests = await tx.permitGuest.findMany({
        where: {
          plateKey: key,
          removedAt: null,
          purgedAt: null,
          permitId: {
            in: (
              await tx.unitPermit.findMany({
                where: { ...near, kind: 'event' },
                select: { id: true },
              })
            ).map((p) => p.id),
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const events = new Map(
        (
          await tx.unitPermit.findMany({
            where: { id: { in: guests.map((g) => g.permitId) } },
          })
        ).map((p) => [p.id, p]),
      );
      const codes = await this.core.unitCodes(tx, [
        ...vehicles.map((v) => v.unitId),
        ...passes.map((p) => p.unitId),
        ...moves.map((m) => m.unitId),
        ...[...events.values()].map((e) => e.unitId),
      ]);
      const matches: (VehicleMatch | PassMatch | PermitMatch)[] = vehicles.map(
        (v) => ({
          kind: 'vehicle',
          unitCode: codes.get(v.unitId) ?? '',
          vehicle: v,
          permitStatus: permitStatus(
            v.status,
            dayOf(v.permitValidUntil),
            today,
          ),
        }),
      );
      for (const { visitorDetails, ...pass } of passes) {
        const subject = await this.subjects.pass(tx, pass);
        matches.push({
          kind: 'visitor_pass',
          unitCode: codes.get(pass.unitId) ?? '',
          pass,
          plate: visitorDetails?.vehiclePlate ?? plate,
          refusal:
            block ?? (await this.subjects.refusal(tx, subject, now, timezone)),
          parking: await this.parking.forPass(tx, pass.id, now),
        });
      }
      for (const [type, id, permit, shown] of [
        ...moves.map(
          (m) => ['move_permit', m.id, m, m.truckPlate ?? plate] as const,
        ),
        ...guests.map(
          (g) =>
            [
              'event_guest',
              g.id,
              events.get(g.permitId)!,
              g.vehiclePlate ?? plate,
            ] as const,
        ),
      ]) {
        const subject = await this.subjects.permitSubject(tx, type, id);
        matches.push({
          kind: 'unit_permit',
          unitCode: codes.get(permit.unitId) ?? '',
          permit,
          plate: shown,
          subjectType: type,
          subjectId: id,
          refusal: !subject
            ? 'unknown_code'
            : (block ??
              (await this.subjects.refusal(tx, subject, now, timezone))),
        });
      }
      await this.audit.record(tx, {
        action: 'gate.plate_lookup',
        targetId: shift.id,
        metadata: {
          vehicleIds: vehicles.map((v) => v.id),
          passIds: passes.map((p) => p.id),
          permitIds: moves.map((m) => m.id),
          guestIds: guests.map((g) => g.id),
          matches: matches.length,
        },
      });
      await this.matcher.record(tx, met, {
        source: 'plate_lookup',
        outcome: 'noted',
        gateId: shift.gateId,
        shiftId: shift.id,
      });
      return {
        plate,
        matches,
        blocklist: met.entries.map((e) => ({
          entryId: e.id,
          kind: e.kind as 'ban' | 'watch',
        })),
      };
    });
  }

  /**
   * The visitor bookings at the gate (ADR 0045), inside an open shift:
   * holding now or starting within two hours, with the unit and the area,
   * and the visitor's name for a booking without a pass — the only way the
   * guard can tell that visitor's car. A pass's booking shows on its verify.
   */
  async visitorParking(): Promise<GuardBooking[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOpen(tx);
      return this.parking.atGate(tx, await dbNow(tx));
    });
  }
}
