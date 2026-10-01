import { Injectable } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';

export const ATTENDANCE_MAX_DAYS = 93;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

export interface AttendanceDay {
  /** The compound's local date of the entry. */
  date: string;
  firstIn: Date;
  /** The last exit of that day's visits; null while still inside. */
  lastOut: Date | null;
  /** An exit was closed by the system, not seen by a guard. */
  unconfirmedExit: boolean;
  /** Every visit that day has a confirmed exit. */
  fullDay: boolean;
}

export interface Attendance {
  engagementId: string;
  from: string;
  to: string;
  days: AttendanceDay[];
  totalDays: number;
}

/**
 * A domestic worker's days at the compound (ADR 0028), from the gate log:
 * dates and times only, never the gate or the guard. For the people who
 * manage the engagement (WorkersAuthority) and the managers.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
    private readonly settings: TenantSettingsService,
  ) {}

  days(
    engagementId: string,
    range: { from?: string; to?: string },
  ): Promise<Attendance> {
    const tenantId = this.ctx.tenantId;
    // Input first: a bad range is a 400 whatever the engagement.
    checkFormats(range);
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await this.community.authorizeEngagement(tx, engagementId)))
        throw appError.notFound(
          ErrorCode.ENGAGEMENT_NOT_FOUND,
          'Engagement not found',
        );
      const tz = (await this.settings.inTx(tx, tenantId)).timezone;
      const today = localDate(new Date(), tz);
      const to = range.to ?? today;
      const from =
        range.from ??
        new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY)
          .toISOString()
          .slice(0, 10);
      checkRange(from, to);
      // A day either side: local dates straddle UTC midnight.
      const entries = await tx.gateEntry.findMany({
        where: {
          subjectType: 'worker_engagement',
          subjectId: engagementId,
          occurredAt: {
            gte: new Date(Date.parse(`${from}T00:00:00Z`) - DAY),
            lt: new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY),
          },
        },
        orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }, { id: 'asc' }],
      });
      const byDate = new Map<string, AttendanceDay>();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.direction !== 'in') continue;
        const date = localDate(e.occurredAt, tz);
        if (date < from || date > to) continue;
        const next = entries[i + 1];
        const out = next?.direction === 'out' ? next : null;
        const day = byDate.get(date) ?? {
          date,
          firstIn: e.occurredAt,
          lastOut: null,
          unconfirmedExit: false,
          fullDay: true,
        };
        if (out) {
          if (!day.lastOut || out.occurredAt > day.lastOut)
            day.lastOut = out.occurredAt;
          if (out.unconfirmed) {
            day.unconfirmedExit = true;
            day.fullDay = false;
          }
        } else {
          day.fullDay = false;
        }
        byDate.set(date, day);
      }
      const days = [...byDate.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      return { engagementId, from, to, days, totalDays: days.length };
    });
  }
}

function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function checkFormats(range: { from?: string; to?: string }): void {
  const fields: FieldError[] = [];
  for (const field of ['from', 'to'] as const) {
    const d = range[field];
    if (d !== undefined && !isDate(d))
      fields.push({ field, code: FieldErrorCode.INVALID_FORMAT });
  }
  if (fields.length)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid date', {
      fields,
    });
}

function isDate(d: string): boolean {
  return DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
}

function checkRange(from: string, to: string): void {
  // Formats were checked on the way in; defaults are always well formed.
  const fields: FieldError[] = [];
  {
    const span =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;
    if (span < 0 || span >= ATTENDANCE_MAX_DAYS)
      fields.push({
        field: 'to',
        code: FieldErrorCode.INVALID_VALUE,
        params: { maxDays: ATTENDANCE_MAX_DAYS },
      });
  }
  if (fields.length)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid range', {
      fields,
    });
}
