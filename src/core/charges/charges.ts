import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { LocalDate } from '../common/slots/day-slots';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// Charges (ADR 0070)
// ============================================================================
//
// What a facility booking, a club membership request, a vehicle fine and
// a damage claim's remainder (ADR 0074) cost is owed through finance: an invoice of the unit's, paid online or at
// the office and credited as any invoice is. Nothing imports finance (ADR
// 0015, 0046), so finance implements this port at startup and the domains
// call it, in their own transactions, as BoardMatters is used. A source with
// something to do once its charge is paid (the club starts a membership, a
// fine is paid) registers a handler, which finance runs inside the
// transaction that paid it.
//
// The lock rule: a payment takes the finance locks, then the paid handler
// takes the source's rows. So every path that touches a charge takes
// `lockUnit` before it locks its own rows that a handler also locks (a
// facility's paths: right after the facility row, before slots, bookings
// and memberships), and never the other way round.

/**
 * What raised a charge: one charge per source row, ever. A damage claim
 * (ADR 0074) charges what its works deposit does not cover.
 */
export const CHARGE_SOURCES = [
  'booking',
  'club_request',
  'vehicle_fine',
  'damage_claim',
] as const;
export type ChargeSource = (typeof CHARGE_SOURCES)[number];

/** The invoice kinds only the port issues. */
export const CHARGE_KINDS = ['facility', 'club', 'fine', 'damage'] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** Why a charge is cancelled: REASON_CODES.chargeCancel. */
export type ChargeCancelReason =
  | 'booking_cancelled'
  | 'booking_rejected'
  | 'closure'
  | 'appeal_accepted'
  | 'fine_cancelled'
  | 'request_cancelled';

export interface NewCharge {
  unitId: string;
  source: ChargeSource;
  sourceId: string;
  kind: ChargeKind;
  /** More than zero, two decimals. */
  amount: Prisma.Decimal;
  /** The invoice line, in both languages: staff-style text, never a name. */
  textEn: string;
  textAr: string;
  dueOn: LocalDate;
}

export interface ChargeState {
  id: string;
  invoiceId: string;
  amount: Prisma.Decimal;
  /** `paid` once its invoice was settled by payments; `cancelled` once credited off. */
  status: 'open' | 'paid' | 'cancelled';
}

export interface PaidCharge {
  chargeId: string;
  source: ChargeSource;
  sourceId: string;
  invoiceId: string;
  unitId: string;
  amount: Prisma.Decimal;
  /** The database's clock in the paying transaction. */
  paidAt: Date;
}

/**
 * Runs once per charge, inside the transaction whose allocation paid it,
 * after the finance locks: it locks the source's row itself. It never
 * throws for the source's state (a payment is never refused for it).
 */
export type PaidHandler = (
  tx: TenantTxClient,
  charge: PaidCharge,
) => Promise<void>;

/**
 * Runs when a paid charge's invoice is owed again — an office payment
 * reversed — in that transaction, after the finance locks. A source whose
 * paid state can go back (a fine) registers one; the club's membership
 * keeps the period it was given.
 */
export type UnpaidHandler = (
  tx: TenantTxClient,
  charge: Omit<PaidCharge, 'paidAt'>,
) => Promise<void>;

/** A payment taken at the office for one charge (a fine's, ADR 0070). */
export interface OfficeCharge {
  source: ChargeSource;
  sourceId: string;
  amount: Prisma.Decimal;
  paidOn: LocalDate;
}

/** What finance implements. */
export interface ChargesImpl {
  /** Takes the unit's finance lock (and the compound's, shared). */
  lockUnit(tx: TenantTxClient, unitId: string): Promise<void>;
  /** Issues the invoice and records the charge; once per source row. */
  raise(tx: TenantTxClient, charge: NewCharge): Promise<ChargeState>;
  /**
   * Credits whatever the invoice still asks and has been paid off it: unpaid,
   * it owes nothing more; paid, the money goes to the unit's credit (cash
   * back through the manager's refund). Null when the source has no
   * charge; a cancelled one is returned as it is.
   */
  cancel(
    tx: TenantTxClient,
    source: ChargeSource,
    sourceId: string,
    reason: ChargeCancelReason,
  ): Promise<ChargeState | null>;
  /**
   * Records the office's payment of the charge's invoice, as finance's
   * office payment does (its receipt, the unit told); returns its id.
   */
  payAtOffice(tx: TenantTxClient, payment: OfficeCharge): Promise<string>;
  /** Reverses such a payment, once, with finance's `paymentReverse` code. */
  reverseAtOffice(
    tx: TenantTxClient,
    paymentId: string,
    reasonCode: string,
  ): Promise<void>;
  /** The sources' charges, by source id. */
  of(
    tx: TenantTxClient,
    source: ChargeSource,
    sourceIds: readonly string[],
  ): Promise<Map<string, ChargeState>>;
}

@Injectable()
export class Charges {
  private impl: ChargesImpl | null = null;
  private readonly handlers = new Map<ChargeSource, PaidHandler>();
  private readonly unpaid = new Map<ChargeSource, UnpaidHandler>();

  /** Finance, at startup: once. */
  implement(impl: ChargesImpl): void {
    if (this.impl) throw new Error('Charges implemented twice');
    this.impl = impl;
  }

  /** A domain, at startup: one handler per source. */
  registerPaidHandler(source: ChargeSource, handler: PaidHandler): void {
    if (this.handlers.has(source))
      throw new Error(`Charges: paid handler for ${source} registered twice`);
    this.handlers.set(source, handler);
  }

  /** Finance, in the paying transaction. */
  paidHandler(source: ChargeSource): PaidHandler | null {
    return this.handlers.get(source) ?? null;
  }

  /** A domain, at startup: one per source, when its paid state can go back. */
  registerUnpaidHandler(source: ChargeSource, handler: UnpaidHandler): void {
    if (this.unpaid.has(source))
      throw new Error(`Charges: unpaid handler for ${source} registered twice`);
    this.unpaid.set(source, handler);
  }

  /** Finance, in the transaction that re-owed it. */
  unpaidHandler(source: ChargeSource): UnpaidHandler | null {
    return this.unpaid.get(source) ?? null;
  }

  payAtOffice(tx: TenantTxClient, payment: OfficeCharge): Promise<string> {
    return this.need().payAtOffice(tx, payment);
  }

  reverseAtOffice(
    tx: TenantTxClient,
    paymentId: string,
    reasonCode: string,
  ): Promise<void> {
    return this.need().reverseAtOffice(tx, paymentId, reasonCode);
  }

  lockUnit(tx: TenantTxClient, unitId: string): Promise<void> {
    return this.need().lockUnit(tx, unitId);
  }

  raise(tx: TenantTxClient, charge: NewCharge): Promise<ChargeState> {
    return this.need().raise(tx, charge);
  }

  cancel(
    tx: TenantTxClient,
    source: ChargeSource,
    sourceId: string,
    reason: ChargeCancelReason,
  ): Promise<ChargeState | null> {
    return this.need().cancel(tx, source, sourceId, reason);
  }

  async one(
    tx: TenantTxClient,
    source: ChargeSource,
    sourceId: string,
  ): Promise<ChargeState | null> {
    return (await this.need().of(tx, source, [sourceId])).get(sourceId) ?? null;
  }

  of(
    tx: TenantTxClient,
    source: ChargeSource,
    sourceIds: readonly string[],
  ): Promise<Map<string, ChargeState>> {
    if (!sourceIds.length)
      return Promise.resolve(new Map<string, ChargeState>());
    return this.need().of(tx, source, sourceIds);
  }

  private need(): ChargesImpl {
    if (!this.impl)
      throw new Error('Charges: finance has not implemented the port');
    return this.impl;
  }
}
