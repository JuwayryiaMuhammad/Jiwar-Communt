import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { BASE_PRISMA, type BasePrisma } from './base-prisma';

type GlobalTables = Pick<
  PrismaClient,
  | 'tenant'
  | 'loginIdentifier'
  | 'otpChallenge'
  | 'session'
  | 'platformAdmin'
  | 'platformSession'
  | 'platformAuditLog'
  | 'securityEvent'
  | 'inviteToken'
  | 'outboxMessage'
>;

/**
 * The only path to the global (non-RLS) tables: tenants, login_identifiers,
 * otp_challenges, sessions, platform_admins, platform_sessions, the audit
 * tables, invite_tokens and outbox_messages. Tenant tables are deliberately not exposed here.
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

  get platformAdmin() {
    return this.base.client.platformAdmin;
  }

  get platformSession() {
    return this.base.client.platformSession;
  }

  get platformAuditLog() {
    return this.base.client.platformAuditLog;
  }

  get securityEvent() {
    return this.base.client.securityEvent;
  }

  get inviteToken() {
    return this.base.client.inviteToken;
  }

  get outboxMessage() {
    return this.base.client.outboxMessage;
  }

  /**
   * An interactive transaction with NO tenant set (tenant tables are
   * invisible and unwritable in it), for global work that must commit
   * atomically with its platform audit entry (ADR 0014).
   */
  transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.base.client.$transaction(fn);
  }

  /**
   * One security event insert, bounded BY THE DATABASE (ADR 0014):
   * `statement_timeout` is set for this transaction only, so a locked or
   * stalled table cancels the query server-side and the connection goes back
   * to the pool. A client-side race would return early but leave the query
   * running and its connection held; enough of those exhaust the pool.
   * `maxWait` bounds the wait for a free connection the same way.
   */
  insertSecurityEvent(
    data: Prisma.SecurityEventUncheckedCreateInput,
    timeoutMs: number,
  ): Promise<void> {
    return this.base.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
        await tx.securityEvent.create({ data, select: { id: true } });
      },
      { maxWait: timeoutMs, timeout: timeoutMs * 4 },
    );
  }

  /**
   * Claims up to `limit` outbox messages for delivery (ADR 0019), in one
   * statement: pending ones that are due, and processing ones whose lease
   * expired (a sender that died). FOR UPDATE SKIP LOCKED lets several app
   * instances claim at once without ever taking the same row; the claim
   * sets a lease and commits before anything is sent.
   */
  async claimOutbox(
    limit: number,
    leaseMs: number,
    now: Date,
  ): Promise<ClaimedOutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.base.client.$queryRaw<
      {
        id: string;
        tenant_id: string | null;
        template_key: string;
        locale: 'ar' | 'en';
        recipient: string;
        params: Record<string, unknown>;
        attempts: number;
        locked_until: Date;
      }[]
    >`
      UPDATE outbox_messages
         SET status = 'processing', locked_until = ${leaseUntil}
       WHERE id IN (
         SELECT id FROM outbox_messages
          WHERE (status = 'pending' AND next_attempt_at <= ${now})
             OR (status = 'processing' AND locked_until < ${now})
          ORDER BY next_attempt_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, template_key, locale, recipient, params,
                attempts, locked_until`;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      templateKey: r.template_key,
      locale: r.locale,
      recipient: r.recipient,
      params: r.params,
      attempts: r.attempts,
      lockedUntil: r.locked_until,
    }));
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
      platformAdmin: tx.platformAdmin,
      platformSession: tx.platformSession,
      platformAuditLog: tx.platformAuditLog,
      securityEvent: tx.securityEvent,
      inviteToken: tx.inviteToken,
      outboxMessage: tx.outboxMessage,
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

export interface ClaimedOutboxMessage {
  id: string;
  tenantId: string | null;
  templateKey: string;
  locale: 'ar' | 'en';
  recipient: string;
  params: Record<string, unknown>;
  attempts: number;
  /** The lease this claim holds; later updates only apply while it does. */
  lockedUntil: Date;
}
