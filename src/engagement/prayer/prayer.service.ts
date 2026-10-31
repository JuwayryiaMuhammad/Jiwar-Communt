import { Injectable } from '@nestjs/common';
import { Prisma, type EngagementSettings } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { localDate, type LocalDate } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import {
  prayerTimes,
  type AsrMadhab,
  type PrayerDay,
  type PrayerMethod,
} from './prayer-times';

export interface PrayerSettingsView {
  latitude: string | null;
  longitude: string | null;
  prayerMethod: PrayerMethod;
  asrMadhab: AsrMadhab;
}

export interface PrayerRead extends PrayerDay {
  on: LocalDate;
  timeZone: string;
}

function view(s: EngagementSettings): PrayerSettingsView {
  return {
    latitude: s.latitude?.toFixed(6) ?? null,
    longitude: s.longitude?.toFixed(6) ?? null,
    prayerMethod: s.prayerMethod as PrayerMethod,
    asrMadhab: s.asrMadhab as AsrMadhab,
  };
}

/**
 * Prayer times (ADR 0071): computed on read for a day of the compound,
 * from where it is, its calculation method and its school for Asr. The
 * manager sets those (`content.manage`); nothing else is stored.
 */
@Injectable()
export class PrayerService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly tenantSettings: TenantSettingsService,
    private readonly audit: AuditService,
  ) {}

  /** A day's times (today by default), or PRAYER_PLACE_NOT_SET. */
  get(on?: LocalDate): Promise<PrayerRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const read = await this.forDay(tx, on);
      if (!read)
        throw appError.conflict(
          ErrorCode.PRAYER_PLACE_NOT_SET,
          'The compound has not set where it is',
        );
      return read;
    });
  }

  /** In the caller's transaction (the brief): null when no place is set. */
  async forDay(tx: TenantTxClient, on?: LocalDate): Promise<PrayerRead | null> {
    const s = await tx.engagementSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
    if (s.latitude === null || s.longitude === null) return null;
    const { timezone } = await this.tenantSettings.inTx(
      tx,
      this.ctx.txTenantId,
    );
    const day = on ?? localDate(await dbNow(tx), timezone);
    return {
      on: day,
      timeZone: timezone,
      ...prayerTimes(
        day,
        { latitude: s.latitude.toNumber(), longitude: s.longitude.toNumber() },
        s.prayerMethod as PrayerMethod,
        s.asrMadhab as AsrMadhab,
      ),
    };
  }

  settings(): Promise<PrayerSettingsView> {
    return this.tenantTx.withTenantTx(async (tx) =>
      view(
        await tx.engagementSettings.findUniqueOrThrow({
          where: { tenantId: this.ctx.tenantId },
        }),
      ),
    );
  }

  /** Both coordinates, or neither (`null` both clears the place). */
  update(input: Partial<PrayerSettingsView>): Promise<PrayerSettingsView> {
    const both = 'latitude' in input || 'longitude' in input;
    if (both && (input.latitude === null) !== (input.longitude === null))
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid place', {
        fields: [{ field: 'longitude', code: FieldErrorCode.INVALID_VALUE }],
      });
    if (
      both &&
      (input.latitude === undefined) !== (input.longitude === undefined)
    )
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid place', {
        fields: [
          {
            field: input.latitude === undefined ? 'latitude' : 'longitude',
            code: FieldErrorCode.FIELD_REQUIRED,
          },
        ],
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`
        SELECT tenant_id FROM engagement_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await tx.engagementSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.tenantId },
      });
      const decimal = (v: string | null | undefined) =>
        v === undefined ? undefined : v === null ? null : new Prisma.Decimal(v);
      const after = await tx.engagementSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: {
          latitude: decimal(input.latitude),
          longitude: decimal(input.longitude),
          prayerMethod: input.prayerMethod,
          asrMadhab: input.asrMadhab,
        },
      });
      const changes = diffChanges(
        { ...view(before) },
        { ...view(after) },
        'engagement.prayer_settings_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'engagement.prayer_settings_changed',
          targetId: this.ctx.tenantId,
          changes,
        });
      return view(after);
    });
  }
}
