import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Locale } from '../common/i18n/locale';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx } from '../database/tenant-tx.service';
import { EmailTemplates } from '../mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../mail/layout';
import { Outbox } from '../mail/outbox';
import { newId } from '../common/uuid';
import { Notifier } from '../notifications/notifier';
import { SecurityEventsService } from '../audit/security-events.service';
import { ActionTokens } from './action-tokens';
import { deviceIdentity, type DeviceType } from './devices';
import { IdentifierHasher } from './identifier';

export const NEW_DEVICE_EMAIL = 'account.new_device_login';

/** How long the alert's "not me" link works. */
export const NOT_ME_TTL_MS = 72 * 3_600_000;

const DEVICE_LABELS: Record<Locale, Record<DeviceType, string>> = {
  ar: {
    ios: 'تطبيق على iPhone',
    android: 'تطبيق على Android',
    desktop_web: 'متصفح على كمبيوتر',
    mobile_web: 'متصفح على هاتف',
    unknown: 'جهاز غير معروف',
  },
  en: {
    ios: 'the app on an iPhone',
    android: 'the app on Android',
    desktop_web: 'a browser on a computer',
    mobile_web: 'a browser on a phone',
    unknown: 'an unknown device',
  },
};

/**
 * The unusual-login alert (ADR 0036). At every login, before its session
 * is issued, the device is recorded under the account's row lock:
 *
 * - a device never seen on the account raises a critical notification
 *   (inbox and email) with the coarse device type and the time — never an
 *   IP or a place — and a "not me" action;
 * - the account's first device is the baseline and raises nothing (an
 *   account that only logged in before R1 gets its baseline at its next
 *   login);
 * - a known device only updates its last use.
 *
 * Fail-closed: a login that cannot record its device does not happen.
 */
@Injectable()
export class LoginAlerts implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly hasher: IdentifierHasher,
    private readonly notifier: Notifier,
    private readonly outbox: Outbox,
    private readonly tokens: ActionTokens,
    private readonly templates: EmailTemplates,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  onModuleInit(): void {
    // Critical: always delivered, whatever the preferences (ADR 0036). The
    // link is made here, at send time, from the token row's id.
    this.templates.register(
      NEW_DEVICE_EMAIL,
      (locale, p) => this.render(locale, p),
      { category: 'account_security', critical: true, soleRecord: false },
    );
  }

  async recordLogin(
    account: { accountId: string; tenantId: string },
    origin: { userAgent?: string | null; installId?: string | null },
    now: Date = new Date(),
  ): Promise<void> {
    const device = deviceIdentity(origin.userAgent, origin.installId);
    const deviceHash = this.hasher.hashDevice(
      account.accountId,
      device.source,
      device.material,
    );
    const alerted = await this.tenantTx.runInTenantUnsafe(
      account.tenantId,
      async (tx) => {
        // Two first logins at once: one is the baseline, the other alerts.
        await tx.$queryRaw`
          SELECT id FROM accounts WHERE id = ${account.accountId}::uuid
             FOR NO KEY UPDATE`;
        const known = await tx.knownDevice.findFirst({
          where: { accountId: account.accountId, deviceHash },
          select: { id: true },
        });
        if (known) {
          await tx.knownDevice.update({
            where: { id: known.id },
            data: { lastSeenAt: now },
          });
          return null;
        }
        const baseline =
          (await tx.knownDevice.count({
            where: { accountId: account.accountId },
          })) === 0;
        const created = await tx.knownDevice.create({
          data: {
            id: newId(),
            tenantId: account.tenantId,
            accountId: account.accountId,
            deviceHash,
            source: device.source,
            deviceType: device.deviceType,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        });
        if (baseline) return null;

        const at = now.toISOString();
        await this.notifier.notify(tx, [account.accountId], {
          kind: 'account.new_device_login',
          params: { deviceType: device.deviceType, at },
          targetId: created.id,
        });
        const holder = await tx.account.findUniqueOrThrow({
          where: { id: account.accountId },
          select: { email: true, preferredLocale: true },
        });
        if (holder.email) {
          const tokenId = await this.tokens.create(tx, {
            tenantId: account.tenantId,
            accountId: account.accountId,
            purpose: 'not_me',
            subjectId: created.id,
            expiresAt: new Date(now.getTime() + NOT_ME_TTL_MS),
          });
          const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
            where: { id: account.tenantId },
            select: { name: true },
          });
          const timeZone =
            (await tx.tenantSettings.findFirst({ select: { timezone: true } }))
              ?.timezone ?? 'Africa/Cairo';
          await this.outbox.enqueue(tx, {
            tenantId: account.tenantId,
            templateKey: NEW_DEVICE_EMAIL,
            locale: holder.preferredLocale,
            recipient: holder.email,
            // Codes and ids only: the link is derived when it is sent.
            params: {
              compoundName: tenant.name,
              deviceType: device.deviceType,
              at,
              timeZone,
              actionTokenId: tokenId,
            },
            recipientAccountId: account.accountId,
          });
        }
        return created.id;
      },
    );
    if (alerted)
      await this.securityEvents.record('login.new_device', {
        tenantId: account.tenantId,
        accountId: account.accountId,
        metadata: { deviceId: alerted, deviceType: device.deviceType },
      });
  }

  private render(locale: Locale, p: Record<string, unknown>): RenderedEmail {
    const compound = String(p.compoundName);
    const device =
      DEVICE_LABELS[locale][p.deviceType as DeviceType] ??
      DEVICE_LABELS[locale].unknown;
    const when = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: typeof p.timeZone === 'string' ? p.timeZone : 'Africa/Cairo',
    }).format(new Date(String(p.at)));
    const link = this.tokens.link(String(p.actionTokenId), 'not_me');
    const t =
      locale === 'ar'
        ? {
            subject: 'تسجيل دخول جديد إلى حسابك على جوار',
            lead: `سُجّل الدخول إلى حسابك في ${compound} من ${device} في ${when}.`,
            action: 'إذا لم يكن هذا أنت، أوقف الحساب الآن:',
            help: 'سيُوقف الحساب وتنتهي كل الجلسات، ثم تُعيد الإدارة تفعيله.',
          }
        : {
            subject: 'A new login to your Jiwar account',
            lead: `Someone logged in to your account in ${compound} from ${device} on ${when}.`,
            action: 'If this was not you, freeze the account now:',
            help: 'The account is frozen and every session ends; the management reactivates it.',
          };
    const lines = [t.lead, '', t.action, link, '', t.help];
    return {
      subject: t.subject,
      text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
      html: emailPage(
        locale,
        `<p>${escapeHtml(t.lead)}</p><p>${escapeHtml(t.action)}</p><p dir="ltr"><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p style="color:#666">${escapeHtml(t.help)}</p>`,
      ),
    };
  }
}
