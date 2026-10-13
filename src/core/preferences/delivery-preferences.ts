import { Injectable } from '@nestjs/common';
import type { NotificationSettings } from '@prisma/client';
import type { TenantTxClient } from '../database/tenant-tx.service';
import type { NotificationCategory, DeliveryChannel } from './categories';
import { DEFAULT_PREFS, type DeliveryPrefs } from './delivery-decision';

/** The compound's zone when its settings row is missing (the column default). */
export const DEFAULT_TIME_ZONE = 'Africa/Cairo';

/** `HH:MM` from minutes after midnight. */
export function timeOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Reads an account's delivery preferences (ADR 0036) inside the caller's
 * tenant transaction: the outbox decides with them at enqueue, and again
 * whenever they change. No rows mean the defaults.
 */
@Injectable()
export class DeliveryPreferences {
  async load(tx: TenantTxClient, accountId: string): Promise<DeliveryPrefs> {
    const settings = await tx.notificationSettings.findFirst({
      where: { accountId },
    });
    const switches = await tx.notificationChannelPref.findMany({
      where: { accountId },
      select: { category: true, channel: true, enabled: true },
    });
    return {
      ...DEFAULT_PREFS(await this.timeZone(tx)),
      channels: channelsOf(switches),
      quietHours: quietOf(settings),
      pause: pauseOf(settings),
    };
  }

  /** The same for several accounts at once (a fan-out), in three queries. */
  async loadMany(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<Map<string, DeliveryPrefs>> {
    const ids = [...new Set(accountIds)];
    const out = new Map<string, DeliveryPrefs>();
    if (!ids.length) return out;
    const settings = await tx.notificationSettings.findMany({
      where: { accountId: { in: ids } },
    });
    const switches = await tx.notificationChannelPref.findMany({
      where: { accountId: { in: ids } },
      select: { accountId: true, category: true, channel: true, enabled: true },
    });
    const timeZone = await this.timeZone(tx);
    for (const id of ids) {
      const own = settings.find((s) => s.accountId === id) ?? null;
      out.set(id, {
        ...DEFAULT_PREFS(timeZone),
        channels: channelsOf(switches.filter((s) => s.accountId === id)),
        quietHours: quietOf(own),
        pause: pauseOf(own),
      });
    }
    return out;
  }

  /** The compound's time zone, which quiet hours are read in. */
  async timeZone(tx: TenantTxClient): Promise<string> {
    const row = await tx.tenantSettings.findFirst({
      select: { timezone: true },
    });
    return row?.timezone ?? DEFAULT_TIME_ZONE;
  }
}

export function channelsOf(
  rows: {
    category: NotificationCategory;
    channel: DeliveryChannel;
    enabled: boolean;
  }[],
): DeliveryPrefs['channels'] {
  const out: DeliveryPrefs['channels'] = {};
  for (const r of rows)
    out[r.category] = { ...out[r.category], [r.channel]: r.enabled };
  return out;
}

export function quietOf(
  s: NotificationSettings | null,
): DeliveryPrefs['quietHours'] {
  return s && s.quietStartMinute !== null && s.quietEndMinute !== null
    ? { start: timeOf(s.quietStartMinute), end: timeOf(s.quietEndMinute) }
    : null;
}

export function pauseOf(
  s: NotificationSettings | null,
): DeliveryPrefs['pause'] {
  if (!s) return null;
  if (s.pausedIndefinitely) return { until: null };
  return s.pausedUntil ? { until: s.pausedUntil } : null;
}
