import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { PaymentSession } from '@prisma/client';
import { SecurityEventsService } from '../../core/audit/security-events.service';
import type { SecurityEventName } from '../../core/audit/actions';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { localToday } from '../db-clock';
import { CredentialVault } from '../gateway/credential-vault';
import { GatewayService, type OpenGateway } from '../gateway/gateway.service';
import { toCents } from '../money';
import { PaymobClient } from '../paymob/paymob-client';
import { paymobHmacMatches } from '../paymob/paymob-hmac';
import { PaymentsService } from '../payments/payments.service';

export const VERIFY_SWEEP = 'finance.verify';
/** Failed calls per IP per minute before the webhook stops reading the database. */
export const WEBHOOK_FAILURES_PER_MINUTE = 30;
/** How long a callback Paymob could not confirm is retried by the sweep. */
export const VERIFY_RETRY_MS = 48 * 3_600_000;

export type WebhookOutcome =
  | 'applied'
  | 'duplicate'
  | 'failed_attempt'
  | 'not_final'
  | 'verification_pending'
  | 'contradicted'
  | 'order_mismatch'
  | 'amount_mismatch'
  | 'unknown_reference';

/** What the webhook answers Paymob: 401 refused, 200 handled, 500 retry. */
export interface WebhookAnswer {
  status: 200 | 401 | 500;
  outcome?: WebhookOutcome;
}

/** The signed scalar fields of a transaction, as the event log keeps them. */
interface Signed {
  transactionId: string;
  orderId: string | null;
  amountCents: number;
  currency: unknown;
  success: boolean;
  pending: boolean;
  method: 'card' | 'wallet';
  reference: string | null;
}

const DIGITS = /^[0-9]{1,20}$/;

/**
 * The Paymob webhook (ADR 0046), the only thing that turns a checkout into
 * a payment. In this order:
 *
 * 1. a per-IP limiter fed by failures only;
 * 2. the compound from the URL; its gateway opened in a short read;
 * 3. the HMAC over Paymob's signed fields (timing-safe) — any failure so
 *    far is the same 401, so compounds cannot be told apart;
 * 4. the session by our reference, then Paymob's signed order id against
 *    the one the session holds (our reference is not signed: this stops a
 *    signed success of one checkout being replayed onto another);
 * 5. pending / failed attempts are logged; the amount and currency must
 *    match exactly;
 * 6. a mandatory check with Paymob (the intention: paid, amount, currency,
 *    reference, order) — outside any transaction; not answered yet → 500,
 *    so Paymob retries, and the sweep retries for 48 h;
 * 7. the settlement under the unit's finance lock: Paymob's transaction is
 *    claimed once per compound (a replay is a no-op), the payment is
 *    written and allocated, the session succeeds (also after it expired or
 *    was superseded: the money was taken).
 *
 * Every callback past the HMAC is logged in payment_gateway_events. This
 * file opens compounds with runInTenantUnsafe (named in eslint.config.mjs):
 * a webhook has no request tenant.
 */
@Injectable()
export class PaymobWebhookService implements OnModuleInit {
  private readonly logger = new Logger(PaymobWebhookService.name);

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly rateLimit: RateLimitService,
    private readonly securityEvents: SecurityEventsService,
    private readonly sweep: SweepRunner,
    private readonly tenantSettings: TenantSettingsService,
    private readonly access: FinanceAccess,
    private readonly gateway: GatewayService,
    private readonly vault: CredentialVault,
    private readonly paymob: PaymobClient,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(VERIFY_SWEEP, (now) => this.retryPending(now), {
      intervalMs: 60_000,
    });
  }

  async handle(
    compoundId: string,
    hmac: unknown,
    body: unknown,
    ip: string,
  ): Promise<WebhookAnswer> {
    const limiter = `paymob-webhook:fail:${ip}`;
    if (await this.rateLimit.exceeded(limiter, WEBHOOK_FAILURES_PER_MINUTE))
      return { status: 401 };
    const refuse = async (reason?: string): Promise<WebhookAnswer> => {
      await this.rateLimit.hit(limiter, 60);
      if (reason)
        await this.securityEvents.record('payment.webhook_rejected', {
          tenantId: isUUID(compoundId) ? compoundId : null,
          metadata: { reason },
        });
      return { status: 401 };
    };
    const obj =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).obj
        : undefined;
    if (
      !isUUID(compoundId) ||
      typeof hmac !== 'string' ||
      !/^[0-9a-fA-F]{128}$/.test(hmac) ||
      obj === null ||
      typeof obj !== 'object' ||
      Array.isArray(obj)
    )
      return refuse();
    const tenant = await this.globalDb.tenant.findUnique({
      where: { id: compoundId },
      select: { status: true },
    });
    if (tenant?.status !== 'active') return refuse();
    const gw = await this.tenantTx.runInTenantUnsafe(compoundId, (tx) =>
      this.gateway.open(tx, compoundId),
    );
    if (!gw) return refuse();
    const transaction = obj as Record<string, unknown>;
    if (!paymobHmacMatches(transaction, hmac, gw.creds.hmacSecret))
      return refuse('hmac');
    const signed = signedFields(transaction);
    if (!signed) return { status: 200, outcome: 'unknown_reference' };
    try {
      return {
        status: 200,
        outcome: await this.process(compoundId, gw, signed),
      };
    } catch (error) {
      if (error instanceof PendingVerification)
        return { status: 500, outcome: 'verification_pending' };
      this.logger.error(
        `webhook failed (${error instanceof Error ? error.name : 'Error'})`,
      );
      return { status: 500 };
    }
  }

  /** Steps 4–7 for one signed transaction; throws PendingVerification on step 6. */
  private async process(
    tenantId: string,
    gw: OpenGateway,
    s: Signed,
  ): Promise<WebhookOutcome> {
    const session = s.reference
      ? await this.tenantTx.runInTenantUnsafe(tenantId, (tx) =>
          tx.paymentSession.findUnique({
            where: { specialReference: s.reference! },
          }),
        )
      : null;
    if (!session || session.tenantId !== tenantId)
      return this.log(tenantId, null, s, 'unknown_reference');
    if (
      session.gatewayOrderId !== null &&
      session.gatewayOrderId !== s.orderId
    ) {
      await this.alarm('payment.order_mismatch', tenantId, session.id);
      return this.log(tenantId, session.id, s, 'order_mismatch');
    }
    if (s.pending) return this.log(tenantId, session.id, s, 'not_final');
    if (!s.success) return this.log(tenantId, session.id, s, 'failed_attempt');
    if (s.amountCents !== toCents(session.amount) || s.currency !== 'EGP') {
      await this.alarm('payment.amount_mismatch', tenantId, session.id);
      return this.log(tenantId, session.id, s, 'amount_mismatch');
    }
    const check = await this.verify(gw, session, s);
    if (check === 'contradicted') {
      await this.alarm(
        'payment.verification_contradicted',
        tenantId,
        session.id,
      );
      return this.log(tenantId, session.id, s, 'contradicted');
    }
    if (check === 'unavailable') {
      await this.log(tenantId, session.id, s, 'verification_pending');
      throw new PendingVerification();
    }
    return this.settle(tenantId, session.id, s);
  }

  private async verify(
    gw: OpenGateway,
    session: PaymentSession,
    s: Signed,
  ): Promise<'verified' | 'contradicted' | 'unavailable'> {
    if (!session.clientSecretEnc || !session.keyVersion || !s.orderId)
      return 'contradicted';
    const secret = this.vault.open(
      session.tenantId,
      `client_secret:${session.id}`,
      session.clientSecretEnc,
      session.keyVersion,
    );
    const check = await this.paymob.verifyIntention(gw.creds, secret, {
      amountCents: s.amountCents,
      specialReference: session.specialReference,
      orderId: s.orderId,
    });
    return check.outcome;
  }

  /**
   * The verified transaction becomes a payment, once. Under the unit's
   * finance lock: two callbacks of one transaction, or one and the sweep,
   * settle one after the other, and the second finds the claim.
   */
  private settle(
    tenantId: string,
    sessionId: string,
    s: Signed,
  ): Promise<WebhookOutcome> {
    return this.tenantTx.runInTenantUnsafe(tenantId, async (tx) => {
      const found = await tx.paymentSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      await this.access.lockUnits(tx, [found.unitId]);
      const session = await this.lockSession(tx, sessionId);
      const claimed = await tx.financePayment.findFirst({
        where: { gatewayTransactionId: s.transactionId },
        select: { id: true },
      });
      if (claimed) return this.logIn(tx, tenantId, sessionId, s, 'duplicate');
      const settings = await this.tenantSettings.inTx(tx, tenantId);
      const named = (
        await tx.paymentSessionInvoice.findMany({
          where: { sessionId },
          select: { invoiceId: true },
        })
      ).map((i) => i.invoiceId);
      const id = newId();
      await this.payments.create(tx, id, {
        unitId: session.unitId,
        channel: 'online',
        method: s.method,
        amount: session.amount,
        paidOn: await localToday(tx, settings.timezone),
        reference: null,
        recordedById: null,
        named,
        online: {
          sessionId,
          transactionId: s.transactionId,
          payerId: session.accountId,
        },
      });
      if (session.status === 'succeeded') {
        // A second, different transaction on a paid checkout: the money was
        // taken twice. Recorded (it becomes the unit's credit) and flagged.
        await this.alarm('payment.duplicate_charge', tenantId, sessionId);
      } else {
        await tx.paymentSession.update({
          where: { id: sessionId },
          data: { status: 'succeeded', paymentId: id, resolvedAt: new Date() },
        });
      }
      return this.logIn(tx, tenantId, sessionId, s, 'applied');
    });
  }

  /**
   * The sweep: callbacks Paymob could not confirm in the last 48 hours, not
   * applied since, checked again; each check outside any transaction.
   */
  async retryPending(now: Date): Promise<number> {
    let applied = 0;
    const since = new Date(now.getTime() - VERIFY_RETRY_MS);
    const tenants = await this.globalDb.tenant.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    for (const { id: tenantId } of tenants) {
      try {
        const pending = await this.tenantTx.runInTenantUnsafe(
          tenantId,
          (tx) =>
            tx.$queryRaw<
              {
                session_id: string;
                gateway_transaction_id: string;
                gateway_order_id: string | null;
                amount_cents: bigint;
              }[]
            >`
            SELECT DISTINCT ON (e.gateway_transaction_id)
                   e.session_id, e.gateway_transaction_id, e.gateway_order_id, e.amount_cents
              FROM payment_gateway_events e
             WHERE e.outcome = 'verification_pending' AND e.created_at >= ${since}
               AND e.session_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM finance_payments p
                                WHERE p.tenant_id = e.tenant_id
                                  AND p.gateway_transaction_id = e.gateway_transaction_id)
               AND NOT EXISTS (SELECT 1 FROM payment_gateway_events c
                                WHERE c.tenant_id = e.tenant_id
                                  AND c.gateway_transaction_id = e.gateway_transaction_id
                                  AND c.outcome IN ('contradicted', 'applied', 'duplicate'))
             ORDER BY e.gateway_transaction_id, e.created_at DESC
             LIMIT 100`,
        );
        if (!pending.length) continue;
        const gw = await this.tenantTx.runInTenantUnsafe(tenantId, (tx) =>
          this.gateway.open(tx, tenantId),
        );
        if (!gw) continue;
        for (const p of pending) {
          const session = await this.tenantTx.runInTenantUnsafe(
            tenantId,
            (tx) =>
              tx.paymentSession.findUniqueOrThrow({
                where: { id: p.session_id },
              }),
          );
          const s: Signed = {
            transactionId: p.gateway_transaction_id,
            orderId: p.gateway_order_id,
            amountCents: Number(p.amount_cents),
            currency: 'EGP',
            success: true,
            pending: false,
            method: 'card',
            reference: session.specialReference,
          };
          const check = await this.verify(gw, session, s);
          if (check === 'contradicted') {
            await this.alarm(
              'payment.verification_contradicted',
              tenantId,
              session.id,
            );
            await this.log(tenantId, session.id, s, 'contradicted');
          } else if (check === 'verified') {
            if ((await this.settle(tenantId, session.id, s)) === 'applied')
              applied += 1;
          }
        }
      } catch (error) {
        this.logger.error(
          `verification retry failed in a compound (${error instanceof Error ? error.name : 'Error'})`,
        );
      }
    }
    return applied;
  }

  // --------------------------------------------------------------------------

  private async lockSession(
    tx: TenantTxClient,
    id: string,
  ): Promise<PaymentSession> {
    await tx.$queryRaw`SELECT id FROM payment_sessions WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.paymentSession.findUniqueOrThrow({ where: { id } });
  }

  private log(
    tenantId: string,
    sessionId: string | null,
    s: Signed,
    outcome: WebhookOutcome,
  ): Promise<WebhookOutcome> {
    return this.tenantTx.runInTenantUnsafe(tenantId, (tx) =>
      this.logIn(tx, tenantId, sessionId, s, outcome),
    );
  }

  private async logIn(
    tx: TenantTxClient,
    tenantId: string,
    sessionId: string | null,
    s: Signed,
    outcome: WebhookOutcome,
  ): Promise<WebhookOutcome> {
    await tx.paymentGatewayEvent.create({
      data: {
        id: newId(),
        tenantId,
        sessionId,
        gatewayTransactionId: s.transactionId,
        gatewayOrderId: s.orderId,
        amountCents: BigInt(s.amountCents),
        success: s.success,
        pending: s.pending,
        outcome,
      },
    });
    return outcome;
  }

  private alarm(
    event: SecurityEventName,
    tenantId: string,
    sessionId: string,
  ): Promise<void> {
    return this.securityEvents.record(event, {
      tenantId,
      metadata: { sessionId },
    });
  }
}

/** Paymob has not confirmed the payment yet: answer 500 so it calls again. */
class PendingVerification extends Error {}

/** The signed scalars this webhook relies on, or null when one is malformed. */
function signedFields(obj: Record<string, unknown>): Signed | null {
  const id = digits(obj.id);
  const order =
    obj.order !== null && typeof obj.order === 'object'
      ? (obj.order as Record<string, unknown>)
      : {};
  const amount = obj.amount_cents;
  if (!id || typeof amount !== 'number' || !Number.isSafeInteger(amount))
    return null;
  const source =
    obj.source_data !== null && typeof obj.source_data === 'object'
      ? (obj.source_data as Record<string, unknown>)
      : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const type = `${text(source.type)} ${text(source.sub_type)}`;
  return {
    transactionId: id,
    orderId: digits(order.id),
    amountCents: amount,
    currency: obj.currency,
    success: obj.success === true,
    pending: obj.pending === true,
    method: /wallet/i.test(type) ? 'wallet' : 'card',
    reference:
      typeof order.merchant_order_id === 'string' &&
      /^jw-[0-9a-f-]{36}$/.test(order.merchant_order_id)
        ? order.merchant_order_id
        : null,
  };
}

function digits(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0)
    return String(v);
  if (typeof v === 'string' && DIGITS.test(v)) return v;
  return null;
}
