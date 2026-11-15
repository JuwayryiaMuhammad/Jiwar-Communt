import { randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AccountType, OtpPurpose } from '@prisma/client';
import type { Locale } from '../common/i18n/locale';
import type { Env } from '../config/env.schema';
import { SecurityEventsService } from '../audit/security-events.service';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx } from '../database/tenant-tx.service';
import { IdentifierHasher } from './identifier';
import { OTP_CHANNEL, SMS_OTP_CHANNEL, type OtpChannel } from './otp-channel';
import { SmsLoginPolicy } from './sms-login.policy';
import { SmsDeliveryError } from './sms-otp.channel';

export interface UnlockedAccount {
  accountId: string;
  tenantId: string;
  tenantName: string;
  accountType: AccountType;
}

/**
 * One-time codes for the login bootstrap (ADR 0004).
 *
 * - One challenge per distinct destination email: a code unlocks only the
 *   accounts behind the address it was sent to.
 * - A login typed as a phone goes by SMS to that phone instead (ADR 0095):
 *   one challenge, unlocking the accounts whose login identifier is that
 *   phone, in every compound. If the text cannot go, the codes go by email
 *   exactly as above.
 * - A new request invalidates every older live challenge for the identifier.
 * - Codes are stored as HMAC(pepper, "otp:<challengeId>:<code>").
 */
@Injectable()
export class OtpService implements OnModuleInit {
  private readonly logger = new Logger(OtpService.name);
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly fixedCode: string | undefined;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly hasher: IdentifierHasher,
    @Inject(OTP_CHANNEL) private readonly channel: OtpChannel,
    @Inject(SMS_OTP_CHANNEL) private readonly smsChannel: OtpChannel,
    private readonly smsPolicy: SmsLoginPolicy,
    private readonly securityEvents: SecurityEventsService,
  ) {
    this.ttlSeconds = config.get('OTP_TTL_SECONDS', { infer: true });
    this.maxAttempts = config.get('OTP_MAX_ATTEMPTS', { infer: true });
    this.fixedCode = config.get('OTP_FIXED_CODE', { infer: true });
  }

  onModuleInit(): void {
    if (this.fixedCode !== undefined) {
      this.logger.warn(
        '⚠️  OTP_FIXED_CODE is active — never use in production. Every login code is the fixed value.',
      );
    }
  }

  /**
   * Issues fresh challenges for an identifier hash and sends the codes: by
   * SMS to the phone when the login was typed as one and SMS may be used
   * for it, otherwise (or when the text fails) by email to each distinct
   * address. Does the same bookkeeping whether or not the identifier
   * exists; callers run it off the request path so response time reveals
   * nothing either. `phone` (E.164) lives in memory for this call only: it
   * is never stored, logged or recorded, and an unknown phone gets no text.
   */
  async issue(
    identifierHash: string,
    locale: Locale,
    phone: string | null = null,
  ): Promise<void> {
    const accounts = await this.resolveAccounts(identifierHash);

    let keepLive: string | null = null;
    if (
      phone !== null &&
      accounts.length > 0 &&
      this.smsPolicy.available(phone)
    ) {
      const outcome = await this.issueBySms(
        identifierHash,
        locale,
        phone,
        accounts,
      );
      if (outcome.delivered) return;
      keepLive = outcome.keepLive;
    }
    await this.issueByEmail(identifierHash, locale, accounts, keepLive);
  }

  /**
   * One challenge to the phone, unlocking every active account whose login
   * identifier is that phone (holding the phone is the proof, so it does
   * not matter which email each account has, or whether it has one).
   * Returns whether the text went; when it did not, the caller falls back
   * to email and `keepLive` names the challenge that must stay usable
   * (the text may still arrive after a timeout).
   */
  private async issueBySms(
    identifierHash: string,
    locale: Locale,
    phone: string,
    accounts: ResolvedAccount[],
  ): Promise<{ delivered: boolean; keepLive: string | null }> {
    const cap = await this.smsPolicy.admit(identifierHash);
    if (cap !== null) {
      this.securityEvents.recordInBackground('otp.sms_capped', {
        identifierHash,
        metadata: { locale, cap },
      });
      return { delivered: false, keepLive: null };
    }

    const id = newId();
    const code =
      this.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.globalDb.otpChallenge.create({
      data: {
        id,
        purpose: 'login',
        identifierHash,
        accountIds: accounts.map((a) => a.accountId),
        codeHash: this.hasher.hashOtp(id, code),
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      },
    });
    await this.invalidateOlderLogin(identifierHash, id, null);

    try {
      await this.smsChannel.send({
        to: phone,
        code,
        ttlSeconds: this.ttlSeconds,
        locale,
        purpose: 'login',
      });
    } catch (error) {
      const failure =
        error instanceof SmsDeliveryError
          ? error
          : new SmsDeliveryError('unknown', 'ERROR');
      // The kind and a provider code only: the provider's own message may
      // echo the number, so it is never read, let alone logged.
      this.logger.warn(
        `SMS login code not sent (${failure.kind} ${failure.code}); falling back to email`,
      );
      const hasEmail = accounts.some((a) => !!a.email);
      this.securityEvents.recordInBackground('otp.sms_failed', {
        identifierHash,
        metadata: {
          locale,
          reason: failure.kind,
          code: failure.code,
          fallback: hasEmail ? 'email' : 'none',
        },
      });
      // A refusal means the code never left: it dies. A timeout may have
      // delivered it: it stays usable beside the emailed ones.
      const ambiguous = failure.kind === 'unknown';
      if (!ambiguous) {
        await this.globalDb.otpChallenge.updateMany({
          where: { id, consumedAt: null },
          data: { invalidatedAt: new Date() },
        });
      }
      return { delivered: false, keepLive: ambiguous ? id : null };
    }

    this.securityEvents.recordInBackground('otp.requested', {
      identifierHash,
      metadata: { locale, destinations: 1, channel: 'sms' },
    });
    this.securityEvents.recordInBackground('otp.sms_sent', {
      identifierHash,
      metadata: { locale },
    });
    return { delivered: true, keepLive: null };
  }

  /** One challenge per distinct email behind the matched accounts. */
  private async issueByEmail(
    identifierHash: string,
    locale: Locale,
    accounts: ResolvedAccount[],
    keepLive: string | null,
  ): Promise<void> {
    const destinations = new Map<string, string[]>();
    for (const a of accounts) {
      if (!a.email) continue;
      destinations.set(a.email, [
        ...(destinations.get(a.email) ?? []),
        a.accountId,
      ]);
    }

    const now = Date.now();
    const expiresAt = new Date(now + this.ttlSeconds * 1000);
    // UUIDv7 ids are time-ordered, so "older than this batch" is `id < first`.
    // Concurrent requests then always leave exactly the newest batch live.
    const batch = [...destinations].map(([email, accountIds]) => ({
      id: newId(),
      email,
      accountIds,
      code:
        this.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0'),
    }));
    const threshold = batch[0]?.id ?? newId();

    if (batch.length > 0) {
      await this.globalDb.otpChallenge.createMany({
        data: batch.map((c) => ({
          id: c.id,
          purpose: 'login' as const,
          identifierHash,
          accountIds: c.accountIds,
          codeHash: this.hasher.hashOtp(c.id, c.code),
          expiresAt,
        })),
      });
    }
    await this.invalidateOlderLogin(identifierHash, threshold, keepLive);

    // Recorded for registered and unregistered identifiers alike (account_id
    // stays null in both), and never awaited: a slow or hung insert must
    // neither delay the response (this whole method runs off the request
    // path) nor hold back the email below.
    this.securityEvents.recordInBackground('otp.requested', {
      identifierHash,
      metadata: { locale, destinations: batch.length },
    });
    for (const c of batch) {
      await this.channel.send({
        to: c.email,
        code: c.code,
        ttlSeconds: this.ttlSeconds,
        locale,
        purpose: 'login',
      });
    }
  }

  /** Ends every live login challenge of the identifier older than `threshold`, bar `keepLive`. */
  private async invalidateOlderLogin(
    identifierHash: string,
    threshold: string,
    keepLive: string | null,
  ): Promise<void> {
    await this.globalDb.otpChallenge.updateMany({
      where: {
        purpose: 'login',
        identifierHash,
        id: { lt: threshold, ...(keepLive ? { not: keepLive } : {}) },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
  }

  /**
   * Checks a code against the identifier's live login challenges. Every live
   * challenge spends an attempt; a match consumes it and returns the active
   * accounts it unlocks. Null on any failure.
   */
  async verify(
    identifierHash: string,
    code: string,
  ): Promise<UnlockedAccount[] | null> {
    const challenge = await this.consume('login', identifierHash, code);
    return challenge
      ? this.unlockedAccounts(identifierHash, challenge.accountIds)
      : null;
  }

  /**
   * An invite-acceptance code (ADR 0016), keyed by the invite token HMAC and
   * sent to exactly one email. Challenges carry their purpose, so this code
   * can never log anyone in, and a login code can never accept an invite.
   * Older live invite codes for the same key are invalidated.
   */
  async issueForInvite(
    key: string,
    email: string,
    locale: Locale,
    purpose: 'invite_accept' | 'proxy_accept' = 'invite_accept',
  ): Promise<void> {
    const id = newId();
    const code =
      this.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.globalDb.otpChallenge.create({
      data: {
        id,
        purpose,
        identifierHash: key,
        accountIds: [],
        codeHash: this.hasher.hashOtp(id, code),
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      },
    });
    await this.globalDb.otpChallenge.updateMany({
      where: {
        purpose,
        identifierHash: key,
        id: { lt: id },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
    await this.channel.send({
      to: email,
      code,
      ttlSeconds: this.ttlSeconds,
      locale,
      purpose,
    });
  }

  /**
   * A registration code (ADR 0024), keyed by the request HMAC and sent to
   * the email the registrant typed — whatever the link, unit or phone, so
   * the work is the same for every input. Older live codes for the same
   * key are invalidated.
   */
  async issueForRegistration(
    key: string,
    email: string,
    locale: Locale,
  ): Promise<void> {
    const id = newId();
    const code =
      this.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.globalDb.otpChallenge.create({
      data: {
        id,
        purpose: 'registration',
        identifierHash: key,
        accountIds: [],
        codeHash: this.hasher.hashOtp(id, code),
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      },
    });
    await this.globalDb.otpChallenge.updateMany({
      where: {
        purpose: 'registration',
        identifierHash: key,
        id: { lt: id },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
    this.securityEvents.recordInBackground('otp.requested', {
      identifierHash: key,
      metadata: { locale, purpose: 'registration' },
    });
    await this.channel.send({
      to: email,
      code,
      ttlSeconds: this.ttlSeconds,
      locale,
      purpose: 'registration',
    });
  }

  /**
   * A step-up code (ADR 0036), keyed by what it unlocks — a session, or an
   * email action token — and sent to the account's own email. Older live
   * codes for the same key are invalidated. It can never log anyone in.
   */
  async issueForStepUp(
    key: string,
    accountId: string,
    email: string,
    locale: Locale,
  ): Promise<void> {
    const id = newId();
    const code =
      this.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.globalDb.otpChallenge.create({
      data: {
        id,
        purpose: 'step_up',
        identifierHash: key,
        accountIds: [accountId],
        codeHash: this.hasher.hashOtp(id, code),
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      },
    });
    await this.globalDb.otpChallenge.updateMany({
      where: {
        purpose: 'step_up',
        identifierHash: key,
        id: { lt: id },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
    await this.channel.send({
      to: email,
      code,
      ttlSeconds: this.ttlSeconds,
      locale,
      purpose: 'step_up',
    });
  }

  /**
   * The code that proves an account's new email (ADR 0062), keyed by the
   * account and the exact address, sent to that address. Older live codes
   * for the same key are invalidated. It can never log anyone in.
   */
  async issueForContactChange(
    key: string,
    accountId: string,
    email: string,
    locale: Locale,
  ): Promise<void> {
    const id = newId();
    const code =
      this.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.globalDb.otpChallenge.create({
      data: {
        id,
        purpose: 'contact_change',
        identifierHash: key,
        accountIds: [accountId],
        codeHash: this.hasher.hashOtp(id, code),
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      },
    });
    await this.globalDb.otpChallenge.updateMany({
      where: {
        purpose: 'contact_change',
        identifierHash: key,
        id: { lt: id },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });
    await this.channel.send({
      to: email,
      code,
      ttlSeconds: this.ttlSeconds,
      locale,
      purpose: 'contact_change',
    });
  }

  /** True when the code matches a live contact-change challenge, which it consumes. */
  async verifyContactChange(key: string, code: string): Promise<boolean> {
    return (await this.consume('contact_change', key, code)) !== null;
  }

  /** True when the code matches a live step-up challenge, which it consumes. */
  async verifyStepUp(key: string, code: string): Promise<boolean> {
    return (await this.consume('step_up', key, code)) !== null;
  }

  /** True when the code matches a live registration challenge, which it consumes. */
  async verifyRegistration(key: string, code: string): Promise<boolean> {
    return (await this.consume('registration', key, code)) !== null;
  }

  /** True when the code matches a live invite challenge, which it consumes. */
  async verifyInvite(
    key: string,
    code: string,
    purpose: 'invite_accept' | 'proxy_accept' = 'invite_accept',
  ): Promise<boolean> {
    return (await this.consume(purpose, key, code)) !== null;
  }

  /**
   * Spends one attempt on every live challenge of (purpose, key); consumes
   * and returns the one the code matches.
   */
  private async consume(purpose: OtpPurpose, key: string, code: string) {
    const live = await this.globalDb.otpChallenge.findMany({
      where: {
        purpose,
        identifierHash: key,
        consumedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: this.maxAttempts },
      },
    });

    for (const challenge of live) {
      // Spend the attempt atomically before comparing, so parallel guesses
      // cannot exceed the cap.
      const spent = await this.globalDb.otpChallenge.updateMany({
        where: {
          id: challenge.id,
          consumedAt: null,
          invalidatedAt: null,
          attempts: { lt: this.maxAttempts },
        },
        data: { attempts: { increment: 1 } },
      });
      if (spent.count === 0) continue;
      if (
        !safeEqualHex(
          this.hasher.hashOtp(challenge.id, code),
          challenge.codeHash,
        )
      ) {
        if (purpose === 'login' && challenge.attempts + 1 >= this.maxAttempts) {
          // This wrong guess used the last attempt: the code is burnt.
          await this.securityEvents.record('otp.challenge_exhausted', {
            identifierHash: key,
            metadata: { challengeId: challenge.id, attempts: this.maxAttempts },
          });
        }
        continue;
      }
      const consumed = await this.globalDb.otpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return consumed.count === 0 ? null : challenge;
    }
    return null;
  }

  /**
   * Active accounts for the identifier, in active compounds, with the email
   * each uses (null when it has none).
   */
  private async resolveAccounts(
    identifierHash: string,
  ): Promise<ResolvedAccount[]> {
    const rows = await this.globalDb.loginIdentifier.findMany({
      where: { identifierHash, status: 'active', tenant: { status: 'active' } },
      orderBy: { accountId: 'asc' },
    });

    const accounts: ResolvedAccount[] = [];
    for (const row of rows) {
      // The email lives in tenant data behind RLS. Read exactly this account,
      // in exactly the tenant the lookup row names (ADR 0004).
      const account = await this.tenantTx.runInTenantUnsafe(
        row.tenantId,
        (tx) =>
          tx.account.findUnique({
            where: { id: row.accountId },
            select: { email: true, status: true },
          }),
      );
      // An erased account is never active.
      if (account?.status !== 'active') continue;
      accounts.push({ accountId: row.accountId, email: account.email || null });
    }
    return accounts;
  }

  private async unlockedAccounts(
    identifierHash: string,
    accountIds: string[],
  ): Promise<UnlockedAccount[]> {
    const rows = await this.globalDb.loginIdentifier.findMany({
      where: {
        identifierHash,
        accountId: { in: accountIds },
        status: 'active',
        tenant: { status: 'active' },
      },
      include: { tenant: { select: { name: true } } },
      orderBy: { accountId: 'asc' },
    });
    return rows.map((r) => ({
      accountId: r.accountId,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      accountType: r.accountType,
    }));
  }
}

interface ResolvedAccount {
  accountId: string;
  email: string | null;
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
