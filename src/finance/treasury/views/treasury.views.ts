import { ApiProperty } from '@nestjs/swagger';
import { REASON_CODES } from '../../../core/common/reasons';
import { StaffRefView } from '../../payments/views/payment.views';

/** A staff account as the treasury's views name it: the payments' one. */
export { StaffRefView };

export const CASH_ACCOUNT_KINDS = ['bank', 'cash'] as const;
export const MOVEMENT_KINDS = [
  'opening',
  'handin',
  'recovery',
  'transfer',
  'cheque',
  'statement_payment',
  'adjustment',
  'reversal',
  // A vendor's payout (ADR 0089): its net, out.
  'payout',
  // A tax paid to the tax authority (ADR 0093): its amount, out.
  'tax_payment',
] as const;

/**
 * A bank account or a cash box (ADR 0085): its balance is the sum of its
 * movements, read when asked. A bank account shows its last four digits
 * only, and how many statement lines wait for a match.
 */
export class CashAccountView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: CASH_ACCOUNT_KINDS, enumName: 'CashAccountKind' })
  kind: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ type: String, nullable: true })
  bankName: string | null;
  @ApiProperty({ type: String, nullable: true })
  numberLast4: string | null;
  @ApiProperty({ type: String, format: 'date' })
  openedOn: string;
  @ApiProperty({ type: String, description: 'The sum of its movements.' })
  balance: string;
  @ApiProperty({ type: Number })
  unmatchedLines: number;
  @ApiProperty({
    type: Number,
    description: 'Cheques deposited to it, not yet cleared or bounced.',
  })
  pendingCheques: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** Money into (positive) or out of (negative) an account, and where from. */
export class CashMovementView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ enum: MOVEMENT_KINDS, enumName: 'CashMovementKind' })
  kind: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, format: 'date' })
  onDay: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  handinId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  transferId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  chequeId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  matchId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reversesId: string | null;
  @ApiProperty({
    enum: REASON_CODES.cashAdjust,
    enumName: 'CashAdjustReason',
    nullable: true,
  })
  reasonCode: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The vendor’s payout it paid (ADR 0089).',
  })
  payoutId: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The tax it paid (ADR 0093).',
  })
  taxPaymentId: string | null;
  @ApiProperty({ type: StaffRefView })
  recordedBy: StaffRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** A transfer between two of the compound's accounts: its two legs. */
export class CashTransferView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: [CashMovementView],
    description: 'Out of the first, into the second.',
  })
  legs: CashMovementView[];
}

/** One custodian's open custody, in the list of everyone's. */
export class CustodySummaryView {
  @ApiProperty({ type: StaffRefView })
  custodian: StaffRefView;
  @ApiProperty({ type: Number })
  openCount: number;
  @ApiProperty({
    type: String,
    description: 'What they hold: their open cash payments.',
  })
  expected: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  oldestAt: Date | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Hours since the oldest unhanded payment.',
  })
  ageHours: number | null;
  @ApiProperty({ type: Number })
  unresolvedVariances: number;
}

/** An office cash payment in a custody. */
export class CustodyPaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  paymentId: string;
  @ApiProperty({ type: String })
  receiptNumber: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, format: 'date' })
  paidOn: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export const HANDIN_STATUSES = ['balanced', 'variance', 'resolved'] as const;

/** Cash handed in: expected, counted, the variance and how it was settled. */
export class CustodyHandinView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  number: string;
  @ApiProperty({ type: StaffRefView })
  custodian: StaffRefView;
  @ApiProperty({ type: StaffRefView })
  receivedBy: StaffRefView;
  @ApiProperty({ type: String, format: 'uuid' })
  cashAccountId: string;
  @ApiProperty({ type: String })
  expected: string;
  @ApiProperty({ type: String })
  counted: string;
  @ApiProperty({ type: String, description: 'Counted less expected.' })
  variance: string;
  @ApiProperty({
    enum: REASON_CODES.custodyVariance,
    enumName: 'CustodyVarianceReason',
    nullable: true,
  })
  varianceReason: string | null;
  @ApiProperty({ type: Number })
  paymentCount: number;
  @ApiProperty({ type: String, format: 'date' })
  receivedOn: string;
  @ApiProperty({ enum: HANDIN_STATUSES, enumName: 'CustodyHandinStatus' })
  status: string;
  @ApiProperty({
    enum: REASON_CODES.custodyOutcome,
    enumName: 'CustodyOutcome',
    nullable: true,
  })
  outcome: string | null;
  @ApiProperty({ type: String, nullable: true })
  recovered: string | null;
  @ApiProperty({ type: StaffRefView, nullable: true })
  resolvedBy: StaffRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  investigationId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export const INVESTIGATION_STATUSES = ['open', 'decided'] as const;

/** An investigation of a hand-in's variance. */
export class CustodyInvestigationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  handinId: string;
  @ApiProperty({ type: String })
  handinNumber: string;
  @ApiProperty({ type: StaffRefView })
  owner: StaffRefView;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ type: Boolean })
  overdue: boolean;
  @ApiProperty({
    enum: INVESTIGATION_STATUSES,
    enumName: 'CustodyInvestigationStatus',
  })
  status: string;
  @ApiProperty({
    enum: REASON_CODES.custodyOutcome,
    enumName: 'CustodyOutcome',
    nullable: true,
  })
  outcome: string | null;
  @ApiProperty({ type: String, nullable: true })
  recovered: string | null;
  @ApiProperty({ type: StaffRefView })
  openedBy: StaffRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  openedAt: Date;
  @ApiProperty({ type: StaffRefView, nullable: true })
  decidedBy: StaffRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
}

/** A hand-in with the payments it took and its investigation. */
export class CustodyHandinDetailView extends CustodyHandinView {
  @ApiProperty({ type: [CustodyPaymentView] })
  payments: CustodyPaymentView[];
  @ApiProperty({ type: CustodyInvestigationView, nullable: true })
  investigation: CustodyInvestigationView | null;
}

/** One custodian's custody: what they hold now and their latest hand-ins. */
export class CustodyView {
  @ApiProperty({ type: StaffRefView })
  custodian: StaffRefView;
  @ApiProperty({ type: String })
  expected: string;
  @ApiProperty({ type: Number })
  openCount: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  oldestAt: Date | null;
  @ApiProperty({ type: Number, nullable: true })
  ageHours: number | null;
  @ApiProperty({ type: [CustodyPaymentView], description: 'The oldest 500.' })
  payments: CustodyPaymentView[];
  @ApiProperty({ type: [CustodyHandinView], description: 'The latest 20.' })
  handins: CustodyHandinView[];
}

export const CHEQUE_STATUSES = [
  'received',
  'deposited',
  'cleared',
  'bounced',
  'returned',
] as const;

/** A cheque in the register (ADR 0085). */
export class ChequeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  number: string;
  @ApiProperty({ type: String, nullable: true })
  bankName: string | null;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ type: String, format: 'date' })
  receivedOn: string;
  @ApiProperty({
    type: Boolean,
    description: 'Dated after the day it was received.',
  })
  postDated: boolean;
  @ApiProperty({ enum: CHEQUE_STATUSES, enumName: 'ChequeStatus' })
  status: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The payment it made.',
  })
  paymentId: string | null;
  @ApiProperty({ type: Boolean })
  paymentReversed: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  depositedToAccountId: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  depositedOn: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  clearedOn: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  bouncedOn: string | null;
  @ApiProperty({
    enum: REASON_CODES.chequeBounce,
    enumName: 'ChequeBounceReason',
    nullable: true,
  })
  bounceReason: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  returnedOn: string | null;
  @ApiProperty({
    enum: REASON_CODES.chequeReturn,
    enumName: 'ChequeReturnReason',
    nullable: true,
  })
  returnReason: string | null;
  @ApiProperty({ type: StaffRefView })
  recordedBy: StaffRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export const STATEMENT_IMPORT_STATUSES = [
  'valid',
  'invalid',
  'applied',
  'expired',
] as const;

export class StatementProblemView {
  @ApiProperty({ type: Number })
  line: number;
  @ApiProperty({ type: String })
  field: string;
  @ApiProperty({ type: String })
  code: string;
}

/** A bank statement's file: the dry run, then what applying it did. */
export class StatementImportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({
    enum: STATEMENT_IMPORT_STATUSES,
    enumName: 'StatementImportStatus',
  })
  status: string;
  @ApiProperty({ type: Number })
  rowCount: number;
  @ApiProperty({ type: Number, description: 'Lines not imported before.' })
  newCount: number;
  @ApiProperty({
    type: Number,
    description: 'Lines imported already, from this file or another.',
  })
  duplicateCount: number;
  @ApiProperty({ type: Number })
  errorCount: number;
  @ApiProperty({ type: [StatementProblemView], description: 'The first 100.' })
  errors: StatementProblemView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appliedAt: Date | null;
  @ApiProperty({ type: Number, nullable: true })
  importedCount: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Lines matched on their own.',
  })
  matchedCount: number | null;
}

export const MATCH_KINDS = [
  'payment',
  'cheque',
  'transfer',
  'adjustment',
] as const;

/** A statement line's live match. */
export class StatementMatchView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: MATCH_KINDS, enumName: 'StatementMatchKind' })
  kind: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The payment, cheque or transfer leg.',
  })
  targetId: string | null;
  @ApiProperty({
    enum: REASON_CODES.cashAdjust,
    enumName: 'CashAdjustReason',
    nullable: true,
  })
  reasonCode: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Matched on its own when applied.',
  })
  auto: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  matchedAt: Date;
}

/** A bank statement line and its match, if any. */
export class StatementLineView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  importId: string;
  @ApiProperty({ type: String, format: 'date' })
  bookedOn: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, nullable: true })
  reference: string | null;
  @ApiProperty({ type: String, nullable: true })
  description: string | null;
  @ApiProperty({ type: StatementMatchView, nullable: true })
  match: StatementMatchView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** What a line could be matched to. */
export class MatchCandidateView {
  @ApiProperty({
    enum: ['payment', 'cheque', 'transfer'],
    enumName: 'MatchCandidateKind',
  })
  kind: string;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ type: String, format: 'date' })
  onDay: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A transfer’s or cheque’s reference, or a receipt number.',
  })
  reference: string | null;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
}
