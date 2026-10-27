import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { IdentifierHasher, normalizeEmail } from '../auth/identifier';
import { OtpService } from '../auth/otp.service';
import { StepUpService } from '../auth/step-up.service';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import type { Locale } from '../common/i18n/locale';
import type { Env } from '../config/env.schema';
import { TenantTx } from '../database/tenant-tx.service';
import { EmailTemplates } from '../mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../mail/layout';
import { Outbox } from '../mail/outbox';
import { RateLimitService } from '../redis/rate-limit.service';
import { AccountWriter } from './account-writer';

/** Sent to the old address once the new one is the account's (ADR 0062). */
export const EMAIL_CHANGED_EMAIL = 'account.email_changed';

/**
 * An account changes its own email (ADR 0062), in two steps:
 *
 * 1. A step-up (a code to the current address, ADR 0036) proves the owner;
 *    spending it, the account names the new address, and a code goes there.
 * 2. That code proves the new address; the change is made as a manager's
 *    would be (AccountWriter.updateContact: login lookups replaced, pending
 *    codes voided), and the old address is told — without the new one.
 *
 * The code is keyed by the account and the exact address, so it confirms
 * only that change. Emails are not unique across accounts (one person may
 * hold several, product decision #4), so no address is "taken". The phone
 * and the name are not changed here: they are requests a manager decides
 * (IdentityChangesService), until an SMS channel can prove a number.
 */
@Injectable()
export class ContactChangeService implements OnModuleInit {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly hasher: IdentifierHasher,
    private readonly otp: OtpService,
    private readonly stepUp: StepUpService,
    private readonly rateLimit: RateLimitService,
    private readonly writer: AccountWriter,
    private readonly outbox: Outbox,
    private readonly templates: EmailTemplates,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    // Critical: about the account's own security, whatever the preferences.
    this.templates.register(
      EMAIL_CHANGED_EMAIL,
      // Nothing in the params: the old address learns neither the new one
      // nor anything about the account.
      (locale) => renderEmailChanged(locale),
      { category: 'account_security', critical: true, soleRecord: true },
    );
  }

  /** Step 1: spends the step-up and sends a code to the new address. */
  async requestEmail(input: { email: string }): Promise<void> {
    const email = normalizeEmail(input.email ?? '');
    if (!email)
      throw invalid('email', FieldErrorCode.INVALID_EMAIL, 'Invalid email');
    await this.limit('request');
    const account = await this.tenantTx.withTenantTx(async (tx) => {
      const me = await tx.account.findUniqueOrThrow({
        where: { id: this.ctx.accountId },
        select: { email: true, preferredLocale: true },
      });
      if (me.email === email)
        throw invalid(
          'email',
          FieldErrorCode.INVALID_VALUE,
          'This is the account’s email already',
        );
      await this.stepUp.consume(tx);
      await this.audit.record(tx, {
        action: 'account.contact_change_requested',
        targetId: this.ctx.accountId,
        metadata: { field: 'email' },
      });
      return me;
    });
    await this.otp.issueForContactChange(
      this.hasher.contactChangeKey(this.ctx.accountId, email),
      this.ctx.accountId,
      email,
      account.preferredLocale,
    );
  }

  /** Step 2: the code from the new address makes it the account's. */
  async verifyEmail(input: { email: string; code: string }): Promise<void> {
    const email = normalizeEmail(input.email ?? '');
    if (!email)
      throw invalid('email', FieldErrorCode.INVALID_EMAIL, 'Invalid email');
    await this.limit('verify');
    const ok = await this.otp.verifyContactChange(
      this.hasher.contactChangeKey(this.ctx.accountId, email),
      input.code ?? '',
    );
    if (!ok)
      throw appError.forbidden(
        ErrorCode.CONTACT_CODE_INVALID,
        'Invalid or expired code',
      );
    await this.tenantTx.withTenantTx(async (tx) => {
      // The account first (ADR 0036's lock order), as updateContact's
      // other callers hold it.
      await tx.$queryRaw`SELECT id FROM accounts
         WHERE id = ${this.ctx.accountId}::uuid FOR UPDATE`;
      const before = await tx.account.findUniqueOrThrow({
        where: { id: this.ctx.accountId },
        select: { email: true, preferredLocale: true, tenantId: true },
      });
      await this.writer.updateContact(tx, this.ctx.accountId, { email });
      if (before.email && before.email !== email)
        await this.outbox.enqueue(tx, {
          tenantId: before.tenantId,
          templateKey: EMAIL_CHANGED_EMAIL,
          locale: before.preferredLocale,
          recipient: before.email,
          params: {},
          recipientAccountId: null,
        });
    });
  }

  private limit(stage: 'request' | 'verify'): Promise<void> {
    return this.rateLimit.consume(
      `contact-change:${stage}:${this.ctx.accountId}`,
      this.config.get('OTP_RATE_LIMIT_PER_IDENTIFIER', { infer: true }),
      this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', { infer: true }),
    );
  }
}

function invalid(field: string, code: FieldErrorCode, message: string) {
  return appError.badRequest(ErrorCode.VALIDATION_FAILED, message, {
    fields: [{ field, code }],
  });
}

function renderEmailChanged(locale: Locale): RenderedEmail {
  const t =
    locale === 'ar'
      ? {
          subject: 'تغيّر البريد الإلكتروني لحسابك على جوار',
          lead: 'لم يعد هذا العنوان بريد حسابك على جوار: غيّره صاحب الحساب بعد تأكيد العنوان الجديد.',
          help: 'إذا لم تفعل ذلك، تواصل مع إدارة المجمع فورًا.',
        }
      : {
          subject: 'Your Jiwar account’s email changed',
          lead: 'This address is no longer your Jiwar account’s email: it was changed after the new address was confirmed.',
          help: 'If you did not do this, contact the compound management at once.',
        };
  const lines = [t.lead, '', t.help];
  return {
    subject: t.subject,
    text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
    html: emailPage(
      locale,
      `<p>${escapeHtml(t.lead)}</p><p style="color:#666">${escapeHtml(t.help)}</p>`,
    ),
  };
}
