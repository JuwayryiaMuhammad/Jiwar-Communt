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
  | 'registrationLink'
  | 'registrationStatusLink'
  | 'visitorPassLink'
  | 'partnerDeskLink'
  | 'childPickupLink'
  | 'receiptLink'
  | 'clearanceLink'
  | 'proxyInviteToken'
  | 'worksCertificateLink'
  | 'actionToken'
  | 'pushDevice'
  | 'pushDelivery'
>;

/**
 * The only path to the global (non-RLS) tables: tenants, login_identifiers,
 * otp_challenges, sessions, platform_admins, platform_sessions, the audit
 * tables, invite_tokens, registration_links, registration_status_links,
 * visitor_pass_links,
 * partner_desk_links, child_pickup_links,
 * receipt_links, clearance_links, proxy_invite_tokens,
 * works_certificate_links,
 * action_tokens, outbox_messages, push_devices and push_deliveries. Tenant
 * tables are deliberately not exposed here.
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

  get registrationLink() {
    return this.base.client.registrationLink;
  }

  get registrationStatusLink() {
    return this.base.client.registrationStatusLink;
  }

  get visitorPassLink() {
    return this.base.client.visitorPassLink;
  }

  get partnerDeskLink() {
    return this.base.client.partnerDeskLink;
  }

  get childPickupLink() {
    return this.base.client.childPickupLink;
  }

  /** The public receipt page's pointers (ADR 0046). */
  get receiptLink() {
    return this.base.client.receiptLink;
  }

  get clearanceLink() {
    return this.base.client.clearanceLink;
  }

  /** A unit proxy invite's pointer (ADR 0063). */
  get proxyInviteToken() {
    return this.base.client.proxyInviteToken;
  }

  /** The public works certificate check's pointers (ADR 0063). */
  get worksCertificateLink() {
    return this.base.client.worksCertificateLink;
  }

  get actionToken() {
    return this.base.client.actionToken;
  }

  get pushDevice() {
    return this.base.client.pushDevice;
  }

  get pushDelivery() {
    return this.base.client.pushDelivery;
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
   * statement. `due`: pending messages whose time has come. `expired`:
   * processing messages whose lease ran out — their sender died mid-send —
   * those with the fewest attempts first. FOR UPDATE SKIP LOCKED lets
   * several app instances claim at once without ever taking the same row;
   * the claim sets a lease and commits before anything is sent.
   *
   * The attempt is counted HERE, in the statement that takes the lease, so
   * a send that crashes the process still counts. A message that already
   * used `maxAttempts` is not claimed for sending: the same statement makes
   * it dead (returned with status `dead`), so a message that crashes the
   * app on every try stops being retried.
   */
  async claimOutbox(
    kind: 'due' | 'expired',
    limit: number,
    leaseMs: number,
    maxAttempts: number,
    now: Date,
  ): Promise<ClaimedOutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const pick =
      kind === 'due'
        ? Prisma.sql`status = 'pending' AND next_attempt_at <= ${now}
            ORDER BY next_attempt_at, id`
        : Prisma.sql`status = 'processing' AND locked_until < ${now}
            ORDER BY attempts, next_attempt_at, id`;
    // Every right-hand side reads the row as it was before the claim.
    const rows = await this.base.client.$queryRaw<
      {
        id: string;
        tenant_id: string | null;
        template_key: string;
        locale: 'ar' | 'en';
        recipient: string;
        params: Record<string, unknown>;
        status: 'processing' | 'dead';
        attempts: number;
        locked_until: Date | null;
        formal_notice_recipient_id: string | null;
      }[]
    >`
      WITH claimed AS (
        UPDATE outbox_messages
           SET status = (CASE WHEN attempts >= ${maxAttempts} THEN 'dead'
                              ELSE 'processing' END)::outbox_status,
               attempts = CASE WHEN attempts >= ${maxAttempts} THEN attempts
                               ELSE attempts + 1 END,
               locked_until = CASE WHEN attempts >= ${maxAttempts} THEN NULL
                                   ELSE ${leaseUntil}::timestamptz END,
               last_error_code = CASE WHEN status = 'processing'
                                      THEN 'LEASE_EXPIRED'
                                      ELSE last_error_code END
         WHERE id IN (
           SELECT id FROM outbox_messages
            WHERE ${pick}
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, template_key, locale, recipient, params,
                  status, attempts, locked_until, next_attempt_at,
                  formal_notice_recipient_id)
      -- RETURNING has no order of its own: deliver in queue order.
      SELECT * FROM claimed ORDER BY next_attempt_at, id`;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      templateKey: r.template_key,
      locale: r.locale,
      recipient: r.recipient,
      params: r.params,
      status: r.status,
      attempts: r.attempts,
      lockedUntil: r.locked_until,
      formalNoticeRecipientId: r.formal_notice_recipient_id,
    }));
  }

  /**
   * Claims up to `limit` due push deliveries (ADR 0041), in one statement,
   * like `claimOutbox`: SKIP LOCKED, a lease, and the attempt counted in the
   * claim. Unlike mail, an expired lease is never claimed again: see
   * `retireExpiredPush`.
   */
  async claimPush(
    limit: number,
    leaseMs: number,
    now: Date,
  ): Promise<ClaimedPushDelivery[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.base.client.$queryRaw<
      {
        id: string;
        tenant_id: string;
        notification_id: string;
        device_id: string;
        attempts: number;
        locked_until: Date;
      }[]
    >`
      WITH claimed AS (
        UPDATE push_deliveries
           SET status = 'processing',
               attempts = attempts + 1,
               locked_until = ${leaseUntil}::timestamptz
         WHERE id IN (
           SELECT id FROM push_deliveries
            WHERE status = 'pending' AND next_attempt_at <= ${now}
            ORDER BY next_attempt_at, id
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, notification_id, device_id, attempts,
                  locked_until, next_attempt_at)
      SELECT * FROM claimed ORDER BY next_attempt_at, id`;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      notificationId: r.notification_id,
      deviceId: r.device_id,
      attempts: r.attempts,
      lockedUntil: r.locked_until,
    }));
  }

  /**
   * A push whose lease ran out was being sent when its sender died: nobody
   * knows whether it reached the phone. It is retired, never sent again
   * (at most once, ADR 0041); the inbox still has the notification.
   */
  async retireExpiredPush(now: Date): Promise<string[]> {
    const rows = await this.base.client.$queryRaw<{ id: string }[]>`
      UPDATE push_deliveries
         SET status = 'dead', locked_until = NULL,
             last_error_code = 'LEASE_EXPIRED'
       WHERE status = 'processing' AND locked_until < ${now}
      RETURNING id`;
    return rows.map((r) => r.id);
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
      registrationLink: tx.registrationLink,
      registrationStatusLink: tx.registrationStatusLink,
      visitorPassLink: tx.visitorPassLink,
      partnerDeskLink: tx.partnerDeskLink,
      childPickupLink: tx.childPickupLink,
      receiptLink: tx.receiptLink,
      clearanceLink: tx.clearanceLink,
      proxyInviteToken: tx.proxyInviteToken,
      worksCertificateLink: tx.worksCertificateLink,
      actionToken: tx.actionToken,
      pushDevice: tx.pushDevice,
      pushDelivery: tx.pushDelivery,
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
  /** `dead`: the claim found no attempt left and retired it; not sent. */
  status: 'processing' | 'dead';
  /** Including the attempt this claim started. */
  attempts: number;
  /**
   * The lease this claim holds; later updates only apply while it does.
   * Null on a dead claim.
   */
  lockedUntil: Date | null;
  /** A formal notice's email (ADR 0058): its sending is that proof. */
  formalNoticeRecipientId: string | null;
}

export interface ClaimedPushDelivery {
  id: string;
  tenantId: string;
  notificationId: string;
  deviceId: string;
  /** Including the attempt this claim started. */
  attempts: number;
  /** The lease this claim holds; later updates only apply while it does. */
  lockedUntil: Date;
}
