import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Locale } from '../common/i18n/locale';
import type { Env } from '../config/env.schema';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { TenantTx } from '../database/tenant-tx.service';
import { REDIS } from '../redis/redis.module';
import type { OtpVerifiedView, TokensView } from './dto/auth.dto';
import { IdentifierHasher, parseIdentifier } from './identifier';
import { OtpService, type UnlockedAccount } from './otp.service';
import { RateLimitService } from '../redis/rate-limit.service';
import {
  SessionService,
  type IssuedTokens,
  type SessionAccount,
} from './session.service';

/** The one response to an OTP request, whether or not anything matched. */
export const OTP_REQUESTED_MESSAGE =
  'If this email or phone is registered, a login code has been sent to the email on file.';

type TicketAccount = Omit<UnlockedAccount, 'tenantName'>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly hasher: IdentifierHasher,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly rateLimit: RateLimitService,
    private readonly tenantTx: TenantTx,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Step 1. Rate limits apply to unknown identifiers as well, and the
   * challenge work runs after the response, so neither status nor timing
   * tells whether the identifier exists.
   */
  async requestOtp(
    rawIdentifier: string,
    ip: string,
    locale: Locale,
  ): Promise<void> {
    const identifierHash = this.hashOrReject(rawIdentifier);
    const window = this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', {
      infer: true,
    });
    await this.rateLimit.consume(
      `otp-request:ip:${ip}`,
      this.config.get('OTP_RATE_LIMIT_PER_IP', { infer: true }),
      window,
    );
    await this.rateLimit.consume(
      `otp-request:id:${identifierHash}`,
      this.config.get('OTP_RATE_LIMIT_PER_IDENTIFIER', { infer: true }),
      window,
    );

    void this.otp.issue(identifierHash, locale).catch((error: unknown) => {
      this.logger.error(
        `OTP issue failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    });
  }

  /** Step 2. A matching code yields a login ticket and the accounts it unlocks. */
  async verifyOtp(
    rawIdentifier: string,
    code: string,
    ip: string,
  ): Promise<OtpVerifiedView> {
    const parsed = parseIdentifier(rawIdentifier);
    await this.rateLimit.consume(
      `otp-verify:ip:${ip}`,
      this.config.get('OTP_RATE_LIMIT_PER_IP', { infer: true }),
      this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', { infer: true }),
    );
    const accounts = parsed
      ? await this.otp.verify(this.hasher.hashIdentifier(parsed), code)
      : null;
    if (!accounts?.length) {
      throw appError.unauthorized(
        ErrorCode.OTP_INVALID,
        'Invalid or expired code',
      );
    }

    const loginTicket = randomBytes(32).toString('base64url');
    const ticket: TicketAccount[] = accounts.map(
      ({ accountId, tenantId, accountType }) => ({
        accountId,
        tenantId,
        accountType,
      }),
    );
    await this.redis.set(
      ticketKey(loginTicket),
      JSON.stringify(ticket),
      'EX',
      this.config.get('LOGIN_TICKET_TTL_SECONDS', { infer: true }),
    );
    return {
      loginTicket,
      accounts: accounts.map(({ accountId, tenantName, accountType }) => ({
        accountId,
        tenantName,
        accountType,
      })),
    };
  }

  /** Step 3. Consumes the ticket and starts a session for one account. */
  async selectAccount(
    loginTicket: string,
    accountId: string,
  ): Promise<TokensView> {
    const raw = await this.redis.getdel(ticketKey(loginTicket));
    const chosen = raw
      ? (JSON.parse(raw) as TicketAccount[]).find(
          (a) => a.accountId === accountId,
        )
      : undefined;
    if (!chosen || !(await this.isActive(chosen))) {
      throw appError.unauthorized(
        ErrorCode.LOGIN_TICKET_INVALID,
        'Invalid or expired login ticket',
      );
    }
    return view(await this.sessions.start(chosen), chosen);
  }

  /** Rotates the refresh token. The account must still be active. */
  async refresh(refreshToken: string): Promise<TokensView> {
    const session = await this.sessions.findLive(refreshToken);
    if (session) {
      const account = await this.readAccount(
        session.tenantId,
        session.accountId,
      );
      if (account && usable(account)) {
        const current: SessionAccount = {
          accountId: account.id,
          tenantId: session.tenantId,
          accountType: account.type,
        };
        const tokens = await this.sessions.rotate(session, current);
        if (tokens) return view(tokens, current);
      } else {
        await this.sessions.revoke(session.id);
      }
    }
    throw appError.unauthorized(
      ErrorCode.REFRESH_TOKEN_INVALID,
      'Invalid refresh token',
    );
  }

  /** Always succeeds from the caller's point of view. */
  async logout(refreshToken: string): Promise<void> {
    const session = await this.sessions.findLive(refreshToken);
    if (session) await this.sessions.revoke(session.id);
  }

  private hashOrReject(rawIdentifier: string): string {
    const parsed = parseIdentifier(rawIdentifier);
    if (!parsed) {
      // A malformed identifier says nothing about who is registered.
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'identifier must be a valid email or phone number',
        {
          fields: [
            { field: 'identifier', code: FieldErrorCode.INVALID_FORMAT },
          ],
        },
      );
    }
    return this.hasher.hashIdentifier(parsed);
  }

  private async isActive(account: TicketAccount): Promise<boolean> {
    const row = await this.readAccount(account.tenantId, account.accountId);
    return !!row && usable(row);
  }

  /** The source of truth is the tenant row, read in exactly that tenant. */
  private readAccount(tenantId: string, accountId: string) {
    return this.tenantTx.runInTenantUnsafe(tenantId, (tx) =>
      tx.account.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          type: true,
          status: true,
          tenant: { select: { status: true } },
        },
      }),
    );
  }
}

/** An active account in an active (not suspended) compound (ADR 0011). */
function usable(account: {
  status: string;
  tenant: { status: string };
}): boolean {
  return account.status === 'active' && account.tenant.status === 'active';
}

function ticketKey(ticket: string): string {
  // Stored by hash: a Redis dump does not hand out usable tickets.
  return `login-ticket:${createHash('sha256').update(ticket).digest('hex')}`;
}

function view(tokens: IssuedTokens, account: SessionAccount): TokensView {
  return {
    ...tokens,
    accountId: account.accountId,
    accountType: account.accountType,
  };
}
