import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../accounts/account-lifecycle';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { RequestContext } from '../common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../common/errors';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Outbox } from '../mail/outbox';
import {
  DELIVERY_CHANNELS,
  NOTIFICATION_CATEGORIES,
  type DeliveryChannel,
  type NotificationCategory,
} from './categories';
import type { DeliveryPrefs } from './delivery-decision';
import { DeliveryPreferences } from './delivery-preferences';
import { parseTime } from './zoned-time';

/** The pause choices (ADR 0036); `null` turns a pause off. */
export const PAUSE_CHOICES = ['1h', '8h', 'until_resumed'] as const;
export type PauseChoice = (typeof PAUSE_CHOICES)[number];

const PAUSE_MS: Record<Exclude<PauseChoice, 'until_resumed'>, number> = {
  '1h': 3_600_000,
  '8h': 8 * 3_600_000,
};

export interface CategoryPreference {
  category: NotificationCategory;
  email: boolean;
  push: boolean;
}

export interface PreferencesUpdate {
  /** Only the switches named change; absent ones keep their value. */
  categories?: {
    category: NotificationCategory;
    email?: boolean;
    push?: boolean;
  }[];
  /** `null` removes quiet hours; absent keeps them. */
  quietHours?: { start: string; end: string } | null;
  /** `null` turns a pause off; absent keeps it. */
  pause?: PauseChoice | null;
}

export interface PreferencesRead {
  categories: CategoryPreference[];
  quietHours: { start: string; end: string } | null;
  /** A timed pause that has ended reads as none. */
  pause: { until: Date | null } | null;
  timeZone: string;
}

/** An assisted change (ADR 0036): who acted for the account, and why. */
export interface Assist {
  reasonCode: string;
}

/**
 * An account's delivery preferences (ADR 0036): category × channel
 * switches, quiet hours in the compound's time zone, and a pause. The inbox
 * records everything whatever they say; they govern email now and push
 * later. Critical kinds ignore them.
 *
 * Every change locks the account's settings row (created first when
 * missing), so two changes never lose each other's switches, and decides
 * the account's held mail again in the same transaction.
 */
@Injectable()
export class NotificationPreferencesService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
    private readonly reader: DeliveryPreferences,
    private readonly outbox: Outbox,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    // Erasure (ADR 0023): nothing of the account's preferences stays.
    this.lifecycle.onErasing(async (tx, account) => {
      await tx.notificationChannelPref.deleteMany({
        where: { accountId: account.id },
      });
      await tx.notificationSettings.deleteMany({
        where: { accountId: account.id },
      });
      return [];
    });
  }

  async mine(now: Date = new Date()): Promise<PreferencesRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.read(tx, this.ctx.accountId, now),
    );
  }

  async update(
    input: PreferencesUpdate,
    now: Date = new Date(),
  ): Promise<PreferencesRead> {
    checkUpdate(input);
    return this.tenantTx.withTenantTx((tx) =>
      this.apply(tx, this.ctx.accountId, input, null, now),
    );
  }

  /**
   * The change itself, for the account or on its behalf (`assist`), under
   * the settings row's lock.
   */
  async apply(
    tx: TenantTxClient,
    accountId: string,
    input: PreferencesUpdate,
    assist: Assist | null,
    now: Date,
  ): Promise<PreferencesRead> {
    await tx.$executeRaw`
      INSERT INTO notification_settings (tenant_id, account_id, updated_at)
      VALUES (${this.ctx.tenantId}::uuid, ${accountId}::uuid, ${now})
      ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`
      SELECT account_id FROM notification_settings
       WHERE account_id = ${accountId}::uuid FOR UPDATE`;
    const before = snapshot(await this.read(tx, accountId, now));

    for (const c of input.categories ?? []) {
      for (const channel of DELIVERY_CHANNELS) {
        const enabled = c[channel];
        if (enabled === undefined) continue;
        await tx.notificationChannelPref.upsert({
          where: {
            tenantId_accountId_category_channel: {
              tenantId: this.ctx.tenantId,
              accountId,
              category: c.category,
              channel,
            },
          },
          create: {
            tenantId: this.ctx.tenantId,
            accountId,
            category: c.category,
            channel,
            enabled,
          },
          update: { enabled },
        });
      }
    }
    const settings: {
      quietStartMinute?: number | null;
      quietEndMinute?: number | null;
      pausedUntil?: Date | null;
      pausedIndefinitely?: boolean;
    } = {};
    if (input.quietHours !== undefined) {
      settings.quietStartMinute = input.quietHours
        ? parseTime(input.quietHours.start)
        : null;
      settings.quietEndMinute = input.quietHours
        ? parseTime(input.quietHours.end)
        : null;
    }
    if (input.pause !== undefined) {
      settings.pausedIndefinitely = input.pause === 'until_resumed';
      settings.pausedUntil =
        input.pause === '1h' || input.pause === '8h'
          ? new Date(now.getTime() + PAUSE_MS[input.pause])
          : null;
    }
    if (Object.keys(settings).length)
      await tx.notificationSettings.updateMany({
        where: { accountId },
        data: settings,
      });

    const after = await this.read(tx, accountId, now);
    const changes = diffChanges(
      before,
      snapshot(after),
      'notification_preferences.changed',
    );
    if (Object.keys(changes).length) {
      await this.audit.record(tx, {
        action: 'notification_preferences.changed',
        targetId: accountId,
        changes,
        metadata: assist
          ? { assisted: true, reasonCode: assist.reasonCode }
          : { assisted: false },
      });
    }
    await this.outbox.redecideHeld(
      tx,
      accountId,
      await this.reader.load(tx, accountId),
      now,
    );
    return after;
  }

  /** The account's preferences as they apply at `now`. */
  async read(
    tx: TenantTxClient,
    accountId: string,
    now: Date,
  ): Promise<PreferencesRead> {
    const prefs = await this.reader.load(tx, accountId);
    return {
      categories: NOTIFICATION_CATEGORIES.map((category) => ({
        category,
        email: enabled(prefs, category, 'email'),
        push: enabled(prefs, category, 'push'),
      })),
      quietHours: prefs.quietHours,
      pause:
        prefs.pause && (prefs.pause.until === null || prefs.pause.until > now)
          ? prefs.pause
          : null,
      timeZone: prefs.timeZone,
    };
  }
}

function enabled(
  prefs: DeliveryPrefs,
  category: NotificationCategory,
  channel: DeliveryChannel,
): boolean {
  return prefs.channels[category]?.[channel] ?? true;
}

/** The audit's flat view: codes, `HH:MM` and instants, never a name. */
function snapshot(p: PreferencesRead): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of p.categories) {
    out[`${c.category}.email`] = c.email;
    out[`${c.category}.push`] = c.push;
  }
  out.quietHours = p.quietHours
    ? `${p.quietHours.start}-${p.quietHours.end}`
    : null;
  out.pause = p.pause
    ? p.pause.until === null
      ? 'until_resumed'
      : p.pause.until
    : null;
  return out;
}

/**
 * The shapes the DTO cannot check: each category at most once, quiet hours
 * as `HH:MM` with a start other than the end. Field errors like the DTO's.
 */
export function checkUpdate(input: PreferencesUpdate): void {
  const fields: FieldError[] = [];
  const seen = new Set<string>();
  (input.categories ?? []).forEach((c, i) => {
    if (
      !c ||
      !(NOTIFICATION_CATEGORIES as readonly string[]).includes(c.category)
    ) {
      fields.push({
        field: `categories.${i}.category`,
        code: FieldErrorCode.INVALID_VALUE,
        params: { allowed: [...NOTIFICATION_CATEGORIES] },
      });
      return;
    }
    if (seen.has(c.category))
      fields.push({
        field: `categories.${i}.category`,
        code: FieldErrorCode.DUPLICATE_VALUE,
      });
    seen.add(c.category);
    for (const channel of DELIVERY_CHANNELS) {
      const v = c[channel];
      if (v !== undefined && typeof v !== 'boolean')
        fields.push({
          field: `categories.${i}.${channel}`,
          code: FieldErrorCode.INVALID_TYPE,
        });
    }
    for (const key of Object.keys(c))
      if (
        key !== 'category' &&
        !(DELIVERY_CHANNELS as readonly string[]).includes(key)
      )
        fields.push({
          field: `categories.${i}.${key}`,
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
  });
  const q = input.quietHours;
  if (q) {
    for (const key of ['start', 'end'] as const)
      if (typeof q[key] !== 'string' || parseTime(q[key]) === null)
        fields.push({
          field: `quietHours.${key}`,
          code: FieldErrorCode.INVALID_FORMAT,
        });
    for (const key of Object.keys(q))
      if (key !== 'start' && key !== 'end')
        fields.push({
          field: `quietHours.${key}`,
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    if (!fields.length && q.start === q.end)
      fields.push({
        field: 'quietHours',
        code: FieldErrorCode.INVALID_SCHEDULE,
      });
  }
  if (fields.length)
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Invalid notification preferences',
      { fields },
    );
}
