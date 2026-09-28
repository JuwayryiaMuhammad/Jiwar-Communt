import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { BASE_PRISMA, type BasePrisma } from './base-prisma';

type GlobalTables = Pick<
  PrismaClient,
  'tenant' | 'loginIdentifier' | 'otpChallenge' | 'session'
>;

/**
 * The only path to the global (non-RLS) tables: tenants, login_identifiers,
 * otp_challenges, sessions. Tenant tables are deliberately not exposed here.
 */
@Injectable()
export class GlobalDbService implements GlobalTables {
  constructor(@Inject(BASE_PRISMA) private readonly base: BasePrisma) {}

  get tenant() {
    return this.base.client.tenant;
  }

  get loginIdentifier() {
    return this.base.client.loginIdentifier;
  }

  get otpChallenge() {
    return this.base.client.otpChallenge;
  }

  get session() {
    return this.base.client.session;
  }

  /**
   * The same tables through an open withTenantTx transaction, for writes that
   * must commit atomically with tenant rows (e.g. an account and its login
   * identifiers).
   */
  in(tx: Prisma.TransactionClient): GlobalTables {
    return {
      tenant: tx.tenant,
      loginIdentifier: tx.loginIdentifier,
      otpChallenge: tx.otpChallenge,
      session: tx.session,
    };
  }

  /** Readiness probe. Touches no table. */
  async ping(): Promise<void> {
    await this.base.client.$queryRaw`SELECT 1`;
  }

  /**
   * The tenant setting as seen OUTSIDE any transaction, on whichever pooled
   * connection this lands on. It must always be empty: a value here means a
   * tenant leaked past its transaction (ADR 0005). Used by the readiness probe
   * as a canary and by the isolation tests.
   */
  async leakedTenantSetting(): Promise<string | null> {
    const rows = await this.base.client.$queryRaw<
      { value: string | null }[]
    >`SELECT NULLIF(current_setting('app.tenant_id', true), '') AS value`;
    return rows[0]?.value ?? null;
  }
}
