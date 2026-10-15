import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentSession, Prisma } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { FinanceAccess } from '../access';
import { formatNumber } from '../counters';
import { dbNow } from '../db-clock';
import { CredentialVault } from '../gateway/credential-vault';
import { GatewayService } from '../gateway/gateway.service';
import { balancesOf, CREDITED_SQL, PAID_SQL } from '../invoices/balances';
import { money, show, toCents, ZERO } from '../money';
import {
  PaymobClient,
  PaymobGatewayError,
  type PaymobCredentials,
} from '../paymob/paymob-client';
import type { OpenPaymentSessionDto } from './dto/payment-sessions.dto';
import type { PaymentSessionView } from './views/payment-session.views';

export const PAYMENT_SESSION_RESOURCE = 'payment_session';
export const SESSION_EXPIRY_SWEEP = 'finance.sessions';
/** A checkout being opened longer than Paymob's timeout plus this is abandoned. */
const OPENING_GRACE_MS = 30_000;

const sessionNotFound = () =>
  appError.notFound(
    ErrorCode.PAYMENT_SESSION_NOT_FOUND,
    'Payment session not found',
  );

/** What a checkout pays: invoice, its number, what it owes now. */
interface BasketLine {
  id: string;
  number: number;
  owed: Prisma.Decimal;
}

/** sha256 of the sorted `invoiceId:amount` pairs: the same basket, the same key. */
export function dedupeKey(
  lines: readonly { id: string; owed: Prisma.Decimal }[],
): string {
  const text = lines
    .map((l) => `${l.id}:${show(l.owed)}`)
    .sort()
    .join(',');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Online checkouts (ADR 0046): one live per unit, a hosted Paymob page for
 * some (or all) of what the unit owes. Opening decides everything under the
 * unit's finance lock, then asks Paymob outside any transaction, then
 * records Paymob's answer: the client secret sealed by the vault. The same
 * basket by the same payer reuses the open checkout; anything else
 * supersedes it. Only the webhook makes a payment.
 */
@Injectable()
export class PaymentSessionsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentSessionsService.name);
  private readonly ttlMs: number;
  private readonly openingMs: number;
  private readonly webhookBase: string | undefined;
  private readonly publicAppUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
    private readonly community: CommunityFinancePort,
    private readonly access: FinanceAccess,
    private readonly gateway: GatewayService,
    private readonly vault: CredentialVault,
    private readonly paymob: PaymobClient,
  ) {
    this.ttlMs =
      config.get('PAYMENT_SESSION_TTL_MINUTES', { infer: true }) * 60_000;
    this.openingMs =
      config.get('PAYMOB_REQUEST_TIMEOUT_MS', { infer: true }) +
      OPENING_GRACE_MS;
    this.webhookBase = config.get('PAYMENT_WEBHOOK_BASE_URL', { infer: true });
    this.publicAppUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  onModuleInit(): void {
    this.idempotency.renderer(PAYMENT_SESSION_RESOURCE, (id) =>
      this.status(id),
    );
    this.sweep.register(SESSION_EXPIRY_SWEEP, (now) => this.expire(now), {
      intervalMs: 60_000,
    });
  }

  /**
   * Opens (or reuses) the unit's checkout for `invoiceIds` — every invoice
   * it owes when none is named.
   */
  async open(
    unitId: string,
    dto: OpenPaymentSessionDto,
  ): Promise<PaymentSessionView> {
    const decided = await this.tenantTx.withTenantTx((tx) =>
      this.decide(tx, unitId, dto.invoiceIds ?? []),
    );
    if (decided.kind === 'reuse') return this.status(decided.id);
    const { session, lines, creds } = decided;
    let intention;
    try {
      intention = await this.paymob.createIntention(creds, {
        amountCents: toCents(session.amount),
        specialReference: session.specialReference,
        items: lines.map((l) => ({
          name: formatNumber('invoice', l.number),
          amountCents: toCents(l.owed),
        })),
        notificationUrl: `${this.webhookBase}/api/v1/public/payments/paymob/${session.tenantId}`,
        redirectionUrl: `${this.publicAppUrl}/paid`,
        expirationSeconds: Math.floor(this.ttlMs / 1000),
      });
    } catch (error) {
      if (!(error instanceof PaymobGatewayError)) throw error;
      await this.tenantTx.withTenantTx((tx) =>
        tx.paymentSession.updateMany({
          where: { id: session.id, status: 'opening' },
          data: { status: 'failed', resolvedAt: new Date() },
        }),
      );
      throw appError.badGateway(
        ErrorCode.PAYMENT_GATEWAY_ERROR,
        'Paymob could not open the checkout',
        { params: { reason: error.kind } },
      );
    }
    const sealed = this.vault.seal(
      session.tenantId,
      `client_secret:${session.id}`,
      intention.clientSecret,
    );
    await this.tenantTx.withTenantTx(async (tx) => {
      const { count } = await tx.paymentSession.updateMany({
        where: { id: session.id, status: 'opening' },
        data: {
          status: 'open',
          intentionId: intention.intentionId,
          gatewayOrderId: intention.orderId,
          clientSecretEnc: sealed.ciphertext,
          keyVersion: sealed.keyVersion,
        },
      });
      // Superseded while Paymob answered: its page may still be paid, and
      // the webhook then applies it as a late payment.
      if (!count)
        this.logger.warn('a checkout was superseded while Paymob opened it');
    });
    return this.status(session.id);
  }

  /** Where a checkout stands, for its payer or whoever sees the unit's money. */
  status(id: string): Promise<PaymentSessionView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const session = await tx.paymentSession.findUnique({ where: { id } });
      if (!session) throw sessionNotFound();
      const mine = session.accountId === this.ctx.accountId;
      if (!mine) {
        const caps = await this.community.placeIn(
          tx,
          this.ctx.accountId,
          session.unitId,
        );
        if (!caps?.financeView) throw sessionNotFound();
      }
      return this.view(tx, session, mine);
    });
  }

  /** Open checkouts past their time: expired. Abandoned openings: failed. */
  expire(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const expired = await tx.paymentSession.updateMany({
        where: { status: 'open', expiresAt: { lte: now } },
        data: { status: 'expired', resolvedAt: now },
      });
      const abandoned = await tx.paymentSession.updateMany({
        where: {
          status: 'opening',
          createdAt: { lte: new Date(now.getTime() - this.openingMs) },
        },
        data: { status: 'failed', resolvedAt: now },
      });
      return expired.count + abandoned.count;
    });
  }

  // --------------------------------------------------------------------------

  private async decide(
    tx: TenantTxClient,
    unitId: string,
    named: readonly string[],
  ): Promise<
    | { kind: 'reuse'; id: string }
    | {
        kind: 'create';
        session: PaymentSession;
        lines: BasketLine[];
        creds: PaymobCredentials;
      }
  > {
    const accountId = this.ctx.accountId;
    await this.access.lockSelf(tx);
    const caps = await this.community.placeIn(tx, accountId, unitId);
    if (!caps?.unitView)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    if (!caps.financePay) {
      if (await this.community.financePaused(tx, unitId))
        throw appError.forbidden(
          ErrorCode.HOUSEHOLD_UNDER_REVIEW,
          'Financial actions are paused while the unit is under review',
        );
      throw appError.forbidden(ErrorCode.FORBIDDEN, 'Not allowed');
    }
    const gw = await this.gateway.open(tx, this.ctx.txTenantId);
    if (!gw?.online || !this.vault.available || !this.webhookBase)
      throw appError.conflict(
        ErrorCode.ONLINE_PAYMENT_UNAVAILABLE,
        'Online payment is not available',
      );
    await this.access.lockUnits(tx, [unitId]);
    const lines = await this.basket(tx, unitId, named);
    const amount = lines.reduce((sum, l) => sum.add(l.owed), ZERO);
    const cap = caps.financeCapPerOperation;
    if (cap !== null && amount.gt(cap))
      throw appError.forbidden(
        ErrorCode.FINANCE_CAP_EXCEEDED,
        'The amount is above your cap per operation',
        { params: { cap: money(cap).toString() } },
      );
    const key = dedupeKey(lines);
    const now = await dbNow(tx);
    const live = await tx.paymentSession.findFirst({
      where: { unitId, status: { in: ['opening', 'open'] } },
    });
    if (live) {
      if (
        live.status === 'open' &&
        live.dedupeKey === key &&
        live.accountId === accountId &&
        live.expiresAt > now
      ) {
        await this.idempotency.claim(tx, {
          type: PAYMENT_SESSION_RESOURCE,
          id: live.id,
        });
        return { kind: 'reuse', id: live.id };
      }
      if (
        live.status === 'opening' &&
        live.createdAt.getTime() > now.getTime() - this.openingMs
      )
        throw appError.conflict(
          ErrorCode.PAYMENT_SESSION_IN_FLIGHT,
          'A checkout is being opened for this unit',
        );
    }
    // The key is claimed before anything is written (ADR 0028).
    const id = newId();
    await this.idempotency.claim(tx, { type: PAYMENT_SESSION_RESOURCE, id });
    if (live) {
      await tx.paymentSession.update({
        where: { id: live.id },
        data: {
          status:
            live.status === 'opening'
              ? 'failed'
              : live.expiresAt <= now
                ? 'expired'
                : 'superseded',
          resolvedAt: now,
        },
      });
    }
    const session = await tx.paymentSession.create({
      data: {
        id,
        tenantId: this.ctx.txTenantId,
        unitId,
        accountId,
        amount,
        currency: 'EGP',
        status: 'opening',
        dedupeKey: key,
        specialReference: `jw-${id}`,
        expiresAt: new Date(now.getTime() + this.ttlMs),
      },
    });
    await tx.paymentSessionInvoice.createMany({
      data: lines.map((l) => ({
        id: newId(),
        tenantId: session.tenantId,
        sessionId: id,
        invoiceId: l.id,
        amount: l.owed,
      })),
    });
    await this.audit.record(tx, {
      action: 'payment_session.opened',
      targetId: id,
      metadata: {
        unitId,
        amount: show(amount),
        invoiceIds: lines.map((l) => l.id),
      },
    });
    return { kind: 'create', session, lines, creds: gw.creds };
  }

  /** The invoices to pay and what each owes: those named, or all owed. */
  private async basket(
    tx: TenantTxClient,
    unitId: string,
    named: readonly string[],
  ): Promise<BasketLine[]> {
    if (named.length) {
      const rows = await tx.invoice.findMany({
        where: { id: { in: [...named] }, unitId },
        select: { id: true, number: true, dueOn: true },
        orderBy: [{ dueOn: 'asc' }, { number: 'asc' }],
      });
      const balances = await balancesOf(
        tx,
        rows.map((r) => r.id),
      );
      const bad = named.filter((id) => !balances.get(id)?.outstanding.gt(ZERO));
      if (bad.length)
        throw appError.conflict(
          ErrorCode.INVOICE_NOT_PAYABLE,
          'Not the unit’s, or nothing owed',
          { params: { invoiceIds: bad } },
        );
      return rows.map((r) => ({
        id: r.id,
        number: r.number,
        owed: balances.get(r.id)!.outstanding,
      }));
    }
    const rows = await tx.$queryRaw<
      { id: string; number: number; owed: Prisma.Decimal }[]
    >`
      SELECT i.id, i.number, i.total - ${CREDITED_SQL} - ${PAID_SQL} AS owed
        FROM invoices i
       WHERE i.unit_id = ${unitId}::uuid
         AND i.total - ${CREDITED_SQL} - ${PAID_SQL} > 0
       ORDER BY i.due_on, i.number
       LIMIT 50`;
    if (!rows.length)
      throw appError.conflict(ErrorCode.NOTHING_TO_PAY, 'Nothing is owed');
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      owed: money(r.owed),
    }));
  }

  private async view(
    tx: TenantTxClient,
    s: PaymentSession,
    mine: boolean,
  ): Promise<PaymentSessionView> {
    const lines = await tx.paymentSessionInvoice.findMany({
      where: { sessionId: s.id },
      include: { invoice: { select: { number: true, dueOn: true } } },
    });
    lines.sort((a, b) => a.invoice.number - b.invoice.number);
    const last = await tx.paymentGatewayEvent.findFirst({
      where: { sessionId: s.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { outcome: true },
    });
    const payment = s.paymentId
      ? await tx.financePayment.findUnique({
          where: { id: s.paymentId },
          select: { id: true, receiptNumber: true },
        })
      : null;
    let checkoutUrl: string | null = null;
    if (mine && s.status === 'open' && s.clientSecretEnc && s.keyVersion) {
      const gw = await this.gateway.open(tx, s.tenantId);
      if (gw)
        checkoutUrl = this.paymob.checkoutUrl(
          gw.creds.publicKey,
          this.vault.open(
            s.tenantId,
            `client_secret:${s.id}`,
            s.clientSecretEnc,
            s.keyVersion,
          ),
        );
    }
    return {
      id: s.id,
      unitId: s.unitId,
      status: s.status,
      amount: show(s.amount),
      currency: s.currency,
      expiresAt: s.expiresAt,
      invoices: lines.map((l) => ({
        invoiceId: l.invoiceId,
        number: formatNumber('invoice', l.invoice.number),
        amount: show(l.amount),
      })),
      lastAttempt: last?.outcome === 'failed_attempt' ? 'failed' : null,
      payment: payment
        ? {
            id: payment.id,
            receiptNumber: formatNumber('receipt', payment.receiptNumber!),
          }
        : null,
      checkoutUrl,
    };
  }
}
