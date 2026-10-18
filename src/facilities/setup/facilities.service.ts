import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Facility, FacilityMode, Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  sortedWindows,
  uncoveredWindows,
  weeklyWindowProblems,
  windowCode,
  type WeeklyWindow,
} from '../../core/common/slots/weekly-windows';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { rulesOf, withDefaults, type FacilityRules } from './facility-rules';
import { upcomingClosures } from '../closures/closure-reads';
import { dbNow } from '../db-clock';
import {
  StaffFacilityView,
  type FacilityWithWindows,
  type ResidentFacility,
} from './views/facility.views';

export const FACILITY_RESOURCE = 'facility';

const RULE_FIELDS = [
  'slotMinutes',
  'capacity',
  'capacityUnit',
  'maxDaysAhead',
  'minMinutesBefore',
  'cancelCutoffMinutes',
  'maxGuests',
  'requiresApproval',
  'requiresMembership',
  'childOccasions',
  'weeklyQuota',
  'peakQuota',
] as const satisfies readonly (keyof FacilityRules)[];

export interface NewFacility extends Partial<FacilityRules> {
  mode: FacilityMode;
  nameEn: string;
  nameAr: string;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  position?: number;
}

export interface FacilityChange extends Partial<FacilityRules> {
  nameEn?: string;
  nameAr?: string;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  position?: number;
  active?: boolean;
}

export const facilityNotFound = () =>
  appError.notFound(ErrorCode.FACILITY_NOT_FOUND, 'Facility not found');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const plain = (w: WeeklyWindow): WeeklyWindow => ({
  weekday: w.weekday,
  startMinute: w.startMinute,
  endMinute: w.endMinute,
});

const WINDOWS_ORDER = [
  { weekday: 'asc' },
  { startMinute: 'asc' },
] as const satisfies Prisma.FacilityHoursOrderByWithRelationInput[];

/**
 * What the audit trail records of a facility: its mode, state and rules by
 * value, its names and descriptions as "changed" only (sensitive in the
 * catalog).
 */
function audited(f: Facility) {
  return {
    mode: f.mode,
    active: f.active,
    position: f.position,
    nameEn: f.nameEn,
    nameAr: f.nameAr,
    descriptionEn: f.descriptionEn,
    descriptionAr: f.descriptionAr,
    ...(rulesOf(f) ?? {}),
  };
}

/** A name, trimmed: both languages are required, so a blank one is missing. */
function name(field: string, value: string, errors: FieldError[]): string {
  const text = value.trim();
  if (!text) errors.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
  return text;
}

/** A description, trimmed: blank is none. */
const description = (value: string | null | undefined) =>
  value === undefined ? undefined : value?.trim() || null;

/**
 * The compound's facilities (ADR 0044): what they are, how a bookable one
 * is booked, its weekly hours and its peak times. Managed with
 * `facilities.manage`; read by every resident with `facilities.book` (the
 * active ones) and by the staff.
 *
 * Every change takes the facility's row `FOR UPDATE`; a booking holds it
 * `FOR SHARE` while it decides (see `lock`), so a booking is decided on one
 * set of rules, hours and peaks, never a mix. Bookings already made keep
 * their times whatever the hours and rules become.
 */
@Injectable()
export class FacilitiesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(FACILITY_RESOURCE, async (id) =>
      StaffFacilityView.from(await this.staffGet(id)),
    );
  }

  /**
   * The facility's row locked for the rest of the transaction: `share` by a
   * booking and whatever is decided by the rules, `update` by a change of
   * them. Not found for another compound's (RLS) or an unknown id.
   */
  async lock(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<Facility> {
    const rows =
      mode === 'share'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM facilities WHERE id = ${id}::uuid FOR SHARE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM facilities WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw facilityNotFound();
    return tx.facility.findUniqueOrThrow({ where: { id } });
  }

  /** The facility with its hours and peaks, in the caller's transaction. */
  async inTx(tx: TenantTxClient, id: string): Promise<FacilityWithWindows> {
    const facility = await tx.facility.findUnique({
      where: { id },
      include: {
        hours: { orderBy: [...WINDOWS_ORDER] },
        peakWindows: { orderBy: [...WINDOWS_ORDER] },
      },
    });
    if (!facility) throw facilityNotFound();
    return facility;
  }

  /** Every facility, retired ones included: the staff's list. */
  staffList(): Promise<FacilityWithWindows[]> {
    return this.tenantTx.withTenantTx((tx) => this.listIn(tx, {}));
  }

  staffGet(id: string): Promise<FacilityWithWindows> {
    return this.tenantTx.withTenantTx((tx) => this.inTx(tx, id));
  }

  /** The active facilities: what a resident sees. */
  residentList(): Promise<ResidentFacility[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.withClosures(tx, await this.listIn(tx, { active: true })),
    );
  }

  /** A retired facility is not found for a resident. */
  residentGet(id: string): Promise<ResidentFacility> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const facility = await this.inTx(tx, id);
      if (!facility.active) throw facilityNotFound();
      return (await this.withClosures(tx, [facility]))[0];
    });
  }

  /** Each facility with its closures not lifted and not over. */
  private async withClosures(
    tx: TenantTxClient,
    facilities: FacilityWithWindows[],
  ): Promise<ResidentFacility[]> {
    const closures = await upcomingClosures(
      tx,
      facilities.map((f) => f.id),
      await dbNow(tx),
    );
    return facilities.map((f) => ({
      ...f,
      closures: closures.filter((c) => c.facilityId === f.id),
    }));
  }

  private listIn(
    tx: TenantTxClient,
    where: Prisma.FacilityWhereInput,
  ): Promise<FacilityWithWindows[]> {
    return tx.facility.findMany({
      where,
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      include: {
        hours: { orderBy: [...WINDOWS_ORDER] },
        peakWindows: { orderBy: [...WINDOWS_ORDER] },
      },
    });
  }

  /**
   * A new facility. A bookable one names its slot length and capacity; the
   * other rules take their defaults. A walk-in one takes no rule. It starts
   * with no hours: it offers no slot until the manager sets them.
   */
  create(input: NewFacility): Promise<FacilityWithWindows> {
    const errors: FieldError[] = [];
    const nameEn = name('nameEn', input.nameEn, errors);
    const nameAr = name('nameAr', input.nameAr, errors);
    let rules: FacilityRules | null = null;
    if (input.mode === 'walk_in') {
      for (const field of RULE_FIELDS)
        if (input[field] !== undefined)
          errors.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
    } else {
      if (input.slotMinutes === undefined)
        errors.push({
          field: 'slotMinutes',
          code: FieldErrorCode.FIELD_REQUIRED,
        });
      if (input.capacity === undefined)
        errors.push({ field: 'capacity', code: FieldErrorCode.FIELD_REQUIRED });
      if (input.slotMinutes !== undefined && input.capacity !== undefined) {
        rules = withDefaults({
          ...input,
          slotMinutes: input.slotMinutes,
          capacity: input.capacity,
        });
        errors.push(...quotaErrors(rules));
      }
    }
    if (errors.length) throw invalid(errors);

    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: FACILITY_RESOURCE, id });
      const facility = await tx.facility.create({
        data: {
          id,
          tenantId,
          mode: input.mode,
          nameEn,
          nameAr,
          descriptionEn: description(input.descriptionEn) ?? null,
          descriptionAr: description(input.descriptionAr) ?? null,
          position: input.position ?? 0,
          ...(rules ?? {}),
        },
      });
      await this.audit.record(tx, {
        action: 'facility.created',
        targetId: facility.id,
        changes: diffChanges(null, audited(facility), 'facility.created'),
      });
      return this.inTx(tx, facility.id);
    });
  }

  /**
   * A change of names, order, state or rules. The mode never changes, and a
   * walk-in facility takes no rule. A retired facility takes no new booking;
   * bookings already made stay, as they do when a rule changes.
   */
  update(id: string, input: FacilityChange): Promise<FacilityWithWindows> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id, 'update');
      const errors: FieldError[] = [];
      const nameEn =
        input.nameEn === undefined
          ? undefined
          : name('nameEn', input.nameEn, errors);
      const nameAr =
        input.nameAr === undefined
          ? undefined
          : name('nameAr', input.nameAr, errors);
      const current = rulesOf(before);
      let rules: Partial<FacilityRules> = {};
      if (!current) {
        for (const field of RULE_FIELDS)
          if (input[field] !== undefined)
            errors.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
      } else {
        rules = Object.fromEntries(
          RULE_FIELDS.filter((f) => input[f] !== undefined).map((f) => [
            f,
            input[f],
          ]),
        );
        errors.push(...quotaErrors({ ...current, ...rules }));
      }
      if (errors.length) throw invalid(errors);

      const after = await tx.facility.update({
        where: { id },
        data: {
          nameEn,
          nameAr,
          descriptionEn: description(input.descriptionEn),
          descriptionAr: description(input.descriptionAr),
          position: input.position,
          active: input.active,
          ...rules,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(after),
        'facility.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'facility.updated',
          targetId: id,
          changes,
        });
      return this.inTx(tx, id);
    });
  }

  /**
   * The facility's opening hours, replaced as a whole. An empty set offers
   * no slot. Peak times must stay inside the hours: hours that would leave
   * one outside are refused (PEAK_OUTSIDE_HOURS) until the peaks change.
   */
  replaceHours(
    id: string,
    input: readonly WeeklyWindow[],
  ): Promise<FacilityWithWindows> {
    const windows = sortedWindows(input.map(plain));
    throwOnProblems(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, id, 'update');
      const current = await this.inTx(tx, id);
      if (uncoveredWindows(current.peakWindows, windows).length)
        throw invalid([
          { field: 'windows', code: FieldErrorCode.PEAK_OUTSIDE_HOURS },
        ]);
      await tx.facilityHours.deleteMany({ where: { facilityId: id } });
      await tx.facilityHours.createMany({
        data: windows.map((w) => ({
          id: newId(),
          tenantId: current.tenantId,
          facilityId: id,
          ...w,
        })),
      });
      await this.recordWindows(
        tx,
        id,
        'facility.hours_changed',
        current.hours,
        windows,
      );
      return this.inTx(tx, id);
    });
  }

  /**
   * A bookable facility's peak times, replaced as a whole: each inside the
   * hours. A slot that overlaps one is a peak slot, with its own quota.
   */
  replacePeaks(
    id: string,
    input: readonly WeeklyWindow[],
  ): Promise<FacilityWithWindows> {
    const windows = sortedWindows(input.map(plain));
    throwOnProblems(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      const facility = await this.lock(tx, id, 'update');
      if (facility.mode !== 'bookable')
        throw appError.conflict(
          ErrorCode.FACILITY_NOT_BOOKABLE,
          'A walk-in facility has no peak times',
        );
      const current = await this.inTx(tx, id);
      const outside = uncoveredWindows(input, current.hours);
      if (outside.length)
        throw invalid(
          outside.map((index) => ({
            field: `windows.${index}.startMinute`,
            code: FieldErrorCode.PEAK_OUTSIDE_HOURS,
          })),
        );
      await tx.facilityPeakWindow.deleteMany({ where: { facilityId: id } });
      await tx.facilityPeakWindow.createMany({
        data: windows.map((w) => ({
          id: newId(),
          tenantId: current.tenantId,
          facilityId: id,
          ...w,
        })),
      });
      await this.recordWindows(
        tx,
        id,
        'facility.peaks_changed',
        current.peakWindows,
        windows,
      );
      return this.inTx(tx, id);
    });
  }

  private async recordWindows(
    tx: TenantTxClient,
    id: string,
    action: 'facility.hours_changed' | 'facility.peaks_changed',
    before: readonly WeeklyWindow[],
    after: readonly WeeklyWindow[],
  ): Promise<void> {
    const changes = diffChanges(
      { windows: before.map(windowCode) },
      { windows: after.map(windowCode) },
      action,
    );
    if (Object.keys(changes).length)
      await this.audit.record(tx, { action, targetId: id, changes });
  }
}

/** The peak quota is at most the weekly one (CHECK facilities_peak_quota_within_weekly). */
function quotaErrors(
  rules: Pick<FacilityRules, 'weeklyQuota' | 'peakQuota'>,
): FieldError[] {
  return rules.peakQuota > rules.weeklyQuota
    ? [
        {
          field: 'peakQuota',
          code: FieldErrorCode.PEAK_QUOTA_ABOVE_WEEKLY,
          params: { max: rules.weeklyQuota },
        },
      ]
    : [];
}

function throwOnProblems(windows: readonly WeeklyWindow[]): void {
  const fields: FieldError[] = weeklyWindowProblems(windows).map((p) =>
    p.problem === 'overlaps'
      ? {
          field: `windows.${p.index}.startMinute`,
          code: FieldErrorCode.WINDOW_OVERLAP,
          params: { other: p.other },
        }
      : {
          field: `windows.${p.index}.endMinute`,
          code: FieldErrorCode.INVALID_SCHEDULE,
        },
  );
  if (fields.length) throw invalid(fields);
}
