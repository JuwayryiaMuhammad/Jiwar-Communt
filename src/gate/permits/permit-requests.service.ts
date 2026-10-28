import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/common/cls/request-context';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import {
  addDays,
  localDate,
  zonedInstant,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import { normalizePlate, PLATE_MAX } from '../../core/common/vehicle-plate';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { PermitCore } from './permit-core';
import { PERMIT_RESOURCE, type PermitRecord } from './permit-records';
import { isWorkDay, minuteOf, PERMIT_LIMITS, timeOf } from './permit-rules';
import { PermitSettingsService } from './permit-settings.service';
import {
  clean,
  daysOf,
  invalid,
  PermitsService,
  startOfDay,
} from './permits.service';
import { BlocklistMatcher } from '../blocklist/blocklist-matcher';

const HOUR_MS = 3_600_000;
/** An event may start up to this long ago (a request sent at the door). */
const START_GRACE_MS = 5 * 60_000;

export interface NewGuest {
  fullName: string;
  vehiclePlate?: string;
}

/** The guests as stored: tidied names and plates, or the fields at fault. */
export function checkGuests(
  guests: readonly NewGuest[],
  field: string,
  fields: FieldError[],
): { fullName: string; vehiclePlate: string | null }[] {
  return guests.map((g, i) => {
    let plate: string | null = null;
    if (g.vehiclePlate !== undefined) {
      plate = normalizePlate(g.vehiclePlate);
      if (!plate)
        fields.push({
          field: `${field}.${i}.vehiclePlate`,
          code: FieldErrorCode.INVALID_FORMAT,
          params: { maxLength: PLATE_MAX },
        });
    }
    return { fullName: clean(g.fullName), vehiclePlate: plate };
  });
}

/**
 * Moves, material exits and events, the household's side (ADR 0049). A
 * move and a material exit are the unit's primary's; an event, anyone the
 * unit lets invite visitors. Each goes through PermitsService.open for the
 * unit's limit, the number, the audit and the management told.
 */
@Injectable()
export class PermitRequestsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly core: PermitCore,
    private readonly settings: PermitSettingsService,
    private readonly permits: PermitsService,
    private readonly matcher: BlocklistMatcher,
  ) {}

  /** Opens the transaction every request shares, up to the claimed key. */
  private request<T>(
    unitId: string,
    kind: 'move' | 'material_exit' | 'event',
    run: (
      tx: TenantTxClient,
      ctx: { id: string; now: Date; timeZone: string; today: string },
    ) => Promise<T>,
  ): Promise<T> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.core.requireRequester(tx, unitId, kind);
      await this.core.lockUnit(tx, unitId);
      const now = await dbNow(tx);
      const timeZone = await this.core.timeZone(tx);
      return run(tx, {
        id: newId(),
        now,
        timeZone,
        today: localDate(now, timeZone),
      });
    });
  }

  /** A furniture move on one day, within a window, by a truck. */
  createMove(
    unitId: string,
    input: {
      date: string;
      window: { from: string; to: string };
      truckPlate: string;
      itemsDescription: string;
      direction: 'in' | 'out';
    },
  ): Promise<PermitRecord> {
    return this.request(unitId, 'move', async (tx, at) => {
      const rules = await this.settings.rules(tx, this.ctx.txTenantId, 'share');
      const fields: FieldError[] = [];
      const max = addDays(at.today, PERMIT_LIMITS.maxDaysAhead);
      const dateInRange = input.date >= at.today && input.date <= max;
      if (!dateInRange)
        fields.push({
          field: 'date',
          code: FieldErrorCode.DAY_OUT_OF_RANGE,
          params: { min: at.today, max },
        });
      else if (!isWorkDay(rules, input.date))
        fields.push({ field: 'date', code: FieldErrorCode.NOT_A_WORK_DAY });
      const from = minuteOf(input.window.from);
      const to = minuteOf(input.window.to);
      const startsAt = zonedInstant(input.date, from, at.timeZone);
      const endsAt = zonedInstant(input.date, to, at.timeZone);
      if (to <= from)
        fields.push({
          field: 'window.to',
          code: FieldErrorCode.ENDS_BEFORE_START,
        });
      else if (from < rules.workFrom || to > rules.workTo)
        fields.push({
          field: 'window',
          code: FieldErrorCode.OUTSIDE_WORK_HOURS,
          params: { from: timeOf(rules.workFrom), to: timeOf(rules.workTo) },
        });
      // Over already (a day out of range is said once, on `date`).
      else if (
        dateInRange &&
        (!startsAt || !endsAt || endsAt.getTime() <= at.now.getTime())
      )
        fields.push({ field: 'window.to', code: FieldErrorCode.INVALID_VALUE });
      const plate = normalizePlate(input.truckPlate);
      if (!plate)
        fields.push({
          field: 'truckPlate',
          code: FieldErrorCode.INVALID_FORMAT,
          params: { maxLength: PLATE_MAX },
        });
      const items = clean(input.itemsDescription);
      if (!items)
        fields.push({
          field: 'itemsDescription',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: 1000 },
        });
      if (fields.length) throw invalid(fields);
      await this.idempotency.claim(tx, { type: PERMIT_RESOURCE, id: at.id });
      // The truck's plate on the blocklist (ADR 0053): noted, never refused.
      await this.matcher.noteRecorded(
        tx,
        'move_permit',
        { type: 'move_permit', id: at.id },
        plate,
      );
      return this.permits.open(
        tx,
        {
          kind: 'move',
          unitId,
          startsAt: startsAt!,
          endsAt: endsAt!,
          data: {
            truckPlate: plate,
            itemsDescription: items,
            // The way it goes, and the move it serves when one is planned
            // (ADR 0063); a permit asked first serves no move.
            moveDirection: input.direction,
            moveId: await this.core.plannedMove(tx, unitId, input.direction),
          },
          metadata: {
            date: input.date,
            window: `${input.window.from}-${input.window.to}`,
            truckPlate: true,
            itemsDescription: true,
            direction: input.direction,
          },
        },
        at.id,
      );
    });
  }

  /** Goods taken out: an item list and an optional photo, for up to 7 days. */
  createMaterialExit(
    unitId: string,
    input: {
      validFrom: string;
      validUntil: string;
      items: { name: string; quantity: number }[];
      photoFileId?: string;
    },
  ): Promise<PermitRecord> {
    return this.request(unitId, 'material_exit', async (tx, at) => {
      const fields: FieldError[] = [];
      const max = addDays(at.today, PERMIT_LIMITS.maxDaysAhead);
      if (input.validFrom < at.today || input.validFrom > max)
        fields.push({
          field: 'validFrom',
          code: FieldErrorCode.DAY_OUT_OF_RANGE,
          params: { min: at.today, max },
        });
      if (input.validUntil < input.validFrom)
        fields.push({
          field: 'validUntil',
          code: FieldErrorCode.ENDS_BEFORE_START,
        });
      else if (
        daysOf(input.validFrom, input.validUntil).length >
        PERMIT_LIMITS.materialExitMaxDays
      )
        fields.push({
          field: 'validUntil',
          code: FieldErrorCode.PERIOD_TOO_LONG,
          params: { maxDays: PERMIT_LIMITS.materialExitMaxDays },
        });
      const items = input.items.map((i) => ({
        name: clean(i.name),
        quantity: i.quantity,
      }));
      items.forEach((i, n) => {
        if (!i.name)
          fields.push({
            field: `items.${n}.name`,
            code: FieldErrorCode.INVALID_LENGTH,
            params: { min: 1, max: 80 },
          });
      });
      if (fields.length) throw invalid(fields);
      await this.idempotency.claim(tx, { type: PERMIT_RESOURCE, id: at.id });
      let photo: string | null = null;
      if (input.photoFileId) {
        const file = await this.files.claim(
          tx,
          input.photoFileId,
          'permit_photo',
        );
        if (!file)
          throw invalid([
            { field: 'photoFileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ]);
        await this.files.attach(tx, file);
        photo = file.id;
      }
      return this.permits.open(
        tx,
        {
          kind: 'material_exit',
          unitId,
          startsAt: startOfDay(input.validFrom, at.timeZone),
          endsAt: startOfDay(addDays(input.validUntil, 1), at.timeZone),
          data: { items, photoFileId: photo },
          metadata: {
            validFrom: input.validFrom,
            validUntil: input.validUntil,
            itemCount: items.length,
            photo: photo !== null,
          },
        },
        at.id,
      );
    });
  }

  /**
   * A private event with its guest list. Up to 20 guests it is approved at
   * once (nobody told) and may hold 20; more waits for the management and
   * may hold as many as were listed.
   */
  createEvent(
    unitId: string,
    input: {
      startsAt: Date;
      endsAt: Date;
      title?: string;
      guests: NewGuest[];
    },
  ): Promise<PermitRecord> {
    return this.request(unitId, 'event', async (tx, at) => {
      const fields: FieldError[] = [];
      const max = addDays(at.today, PERMIT_LIMITS.maxDaysAhead);
      if (input.startsAt.getTime() < at.now.getTime() - START_GRACE_MS)
        fields.push({ field: 'startsAt', code: FieldErrorCode.INVALID_VALUE });
      else if (localDate(input.startsAt, at.timeZone) > max)
        fields.push({
          field: 'startsAt',
          code: FieldErrorCode.DAY_OUT_OF_RANGE,
          params: { min: at.today, max },
        });
      const length = input.endsAt.getTime() - input.startsAt.getTime();
      if (length <= 0)
        fields.push({
          field: 'endsAt',
          code: FieldErrorCode.ENDS_BEFORE_START,
        });
      else if (length > PERMIT_LIMITS.eventMaxHours * HOUR_MS)
        fields.push({
          field: 'endsAt',
          code: FieldErrorCode.WINDOW_TOO_LONG,
          params: { maxHours: PERMIT_LIMITS.eventMaxHours },
        });
      const guests = checkGuests(input.guests, 'guests', fields);
      if (fields.length) throw invalid(fields);
      await this.idempotency.claim(tx, { type: PERMIT_RESOURCE, id: at.id });
      const atOnce = guests.length <= PERMIT_LIMITS.eventGuestsWithoutApproval;
      const record = await this.permits.open(
        tx,
        {
          kind: 'event',
          unitId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          data: {
            title: input.title ? clean(input.title) || null : null,
            guestLimit: atOnce
              ? PERMIT_LIMITS.eventGuestsWithoutApproval
              : guests.length,
          },
          metadata: {
            title: input.title !== undefined,
            guests: guests.length,
          },
          autoApprove: atOnce,
        },
        at.id,
      );
      const rows = guests.map((g) => ({
        id: newId(),
        tenantId: this.ctx.txTenantId,
        permitId: at.id,
        fullName: g.fullName,
        vehiclePlate: g.vehiclePlate,
        addedById: this.ctx.accountId,
      }));
      await tx.permitGuest.createMany({ data: rows });
      // Their cars' plates on the blocklist (ADR 0053): noted, never refused.
      for (const g of rows)
        await this.matcher.noteRecorded(
          tx,
          'event_guest',
          { type: 'event_guest', id: g.id },
          g.vehiclePlate,
        );
      return this.permits.reload(tx, record);
    });
  }
}
