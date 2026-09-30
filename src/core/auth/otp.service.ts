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
import { OTP_CHANNEL, type OtpChannel } from './otp-channel';

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
   * Issues fresh challenges for an identifier hash and emails the codes.
   * Does the same bookkeeping whether or not the identifier exists; callers
   * run it off the request path so response time reveals nothing either.
   */
  async issue(identifierHash: string, locale: Locale): Promise<void> {
    const destinations = await this.resolveDestinations(identifierHash);

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
    await this.globalDb.otpChallenge.updateMany({
      where: {
        purpose: 'login',
        identifierHash,
        id: { lt: threshold },
        consumedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: new Date() },
    });

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
  ): Promise<void> {
    const id = newId();
    const code =
      this.fixedCode ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.globalDb.otpChallenge.create({
      data: {
        id,
        purpose: 'invite_accept',
        identifierHash: key,
        accountIds: [],
        codeHash: this.hasher.hashOtp(id, code),
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      },
    });
    await this.globalDb.otpChallenge.updateMany({
      where: {
        purpose: 'invite_accept',
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
      purpose: 'invite_accept',
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

  /** True when the code matches a live registration challenge, which it consumes. */
  async verifyRegistration(key: string, code: string): Promise<boolean> {
    return (await this.consume('registration', key, code)) !== null;
  }

  /** True when the code matches a live invite challenge, which it consumes. */
  async verifyInvite(key: string, code: string): Promise<boolean> {
    return (await this.consume('invite_accept', key, code)) !== null;
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

  /** Active accounts for the identifier, grouped by the email they use. */
  private async resolveDestinations(
    identifierHash: string,
  ): Promise<Map<string, string[]>> {
    const rows = await this.globalDb.loginIdentifier.findMany({
      where: { identifierHash, status: 'active', tenant: { status: 'active' } },
      orderBy: { accountId: 'asc' },
    });

    const byEmail = new Map<string, string[]>();
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
      if (!account || account.status !== 'active') continue;
      byEmail.set(account.email, [
        ...(byEmail.get(account.email) ?? []),
        row.accountId,
      ]);
    }
    return byEmail;
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

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
