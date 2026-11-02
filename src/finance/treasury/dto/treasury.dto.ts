import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import { MONEY } from '../../money';
import { REFERENCE } from '../../payments/dto/payments.dto';
import { CASH_COUNT, SIGNED_MONEY } from '../treasury-rules';
import {
  CASH_ACCOUNT_KINDS,
  CHEQUE_STATUSES,
  HANDIN_STATUSES,
  INVESTIGATION_STATUSES,
  MATCH_KINDS,
} from '../views/treasury.views';

const NAME = { min: 1, max: 100 } as const;
const LAST4 = /^[0-9]{4}$/;

/** A bank account or a cash box (ADR 0085). */
export class CreateCashAccountDto {
  @ApiProperty({ enum: CASH_ACCOUNT_KINDS })
  @IsIn(CASH_ACCOUNT_KINDS, withParams({ allowed: [...CASH_ACCOUNT_KINDS] }))
  kind: (typeof CASH_ACCOUNT_KINDS)[number];

  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  @IsString()
  @Length(1, 100, withParams(NAME))
  name: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: 100,
    description: 'A bank account’s only.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams(NAME))
  bankName?: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: LAST4.source,
    description: 'A bank account’s last four digits; never the whole number.',
  })
  @IsOptional()
  @IsString()
  @Matches(LAST4)
  numberLast4?: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: MONEY.source,
    description: 'Money in it on the day it opened.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  openingBalance?: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Today or earlier.',
  })
  @IsString()
  @IsLocalDate()
  openedOn: string;
}

export class UpdateCashAccountDto {
  @ApiProperty({ type: String, required: false, minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams(NAME))
  name?: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: 1,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams(NAME))
  bankName?: string;

  @ApiProperty({ type: String, required: false, pattern: LAST4.source })
  @IsOptional()
  @IsString()
  @Matches(LAST4)
  numberLast4?: string;
}

export class CashAccountsQueryDto {
  @ApiProperty({
    required: false,
    enum: ['true', 'false'],
    description: 'Retired accounts too.',
  })
  @IsOptional()
  @IsIn(['true', 'false'], withParams({ allowed: ['true', 'false'] }))
  includeRetired?: 'true' | 'false';
}

export class CashMovementsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiProperty({ required: false, type: String, pattern: LOCAL_DATE.source })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiProperty({ required: false, type: String, pattern: LOCAL_DATE.source })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}

export class CashTransferDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  fromAccountId: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  toAccountId: string;

  @ApiProperty({ type: String, pattern: MONEY.source })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Today or up to 31 days ago.',
  })
  @IsString()
  @IsLocalDate()
  onDay: string;
}

export class CashAdjustmentDto {
  @ApiProperty({
    type: String,
    pattern: SIGNED_MONEY.source,
    description: 'Positive in, negative out.',
  })
  @IsString()
  @Matches(SIGNED_MONEY)
  amount: string;

  @ApiProperty({ type: String, description: 'REASON_CODES.cashAdjust.' })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Today or up to 31 days ago.',
  })
  @IsString()
  @IsLocalDate()
  onDay: string;
}

/** Cash handed in: what the receiver counted against what they were shown. */
export class CustodyHandinDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The cash box it goes into.',
  })
  @IsUUID()
  cashAccountId: string;

  @ApiProperty({
    type: String,
    pattern: CASH_COUNT.source,
    description: 'The custody the receiver was shown; refused if it changed.',
  })
  @IsString()
  @Matches(CASH_COUNT)
  expected: string;

  @ApiProperty({ type: String, pattern: CASH_COUNT.source })
  @IsString()
  @Matches(CASH_COUNT)
  counted: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'REASON_CODES.custodyVariance: when the count differs, and only then.',
  })
  @IsOptional()
  @IsString()
  varianceReason?: string;
}

/** How a variance was settled. */
export class CustodyOutcomeDto {
  @ApiProperty({ type: String, description: 'REASON_CODES.custodyOutcome.' })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: MONEY.source,
    description:
      'With `recovered` only: cash recovered of a shortage, into the hand-in’s cash box.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  recoveredAmount?: string;
}

export class OpenInvestigationDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A staff member who holds finance.custody or finance.payments, not the custodian.',
  })
  @IsUUID()
  ownerId: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'From today, within 60 days.',
  })
  @IsString()
  @IsLocalDate()
  dueOn: string;
}

export class HandinsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, enum: HANDIN_STATUSES })
  @IsOptional()
  @IsIn(HANDIN_STATUSES, withParams({ allowed: [...HANDIN_STATUSES] }))
  status?: (typeof HANDIN_STATUSES)[number];

  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  custodianId?: string;
}

export class InvestigationsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, enum: INVESTIGATION_STATUSES })
  @IsOptional()
  @IsIn(
    INVESTIGATION_STATUSES,
    withParams({ allowed: [...INVESTIGATION_STATUSES] }),
  )
  status?: (typeof INVESTIGATION_STATUSES)[number];
}

/** A cheque received at the office. */
export class ReceiveChequeDto {
  @ApiProperty({ type: String, pattern: REFERENCE.source })
  @IsString()
  @Matches(REFERENCE)
  number: string;

  @ApiProperty({ type: String, required: false, minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams(NAME))
  bankName?: string;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description:
      'At most what is owed (of the invoices named, or all the unit’s).',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The cheque’s date: up to 180 days ago, or post-dated up to 366 days ahead.',
  })
  @IsString()
  @IsLocalDate()
  dueOn: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Today or up to 31 days ago.',
  })
  @IsString()
  @IsLocalDate()
  receivedOn: string;

  @ApiProperty({
    type: [String],
    required: false,
    maxItems: 50,
    description:
      'A cheque dated today or earlier only: invoices it pays first.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50, withParams({ max: 50 }))
  @ArrayUnique()
  @IsUUID('all', { each: true })
  invoiceIds?: string[];
}

export class DepositChequeDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A live bank account.',
  })
  @IsUUID()
  accountId: string;
}

export class ChequeReasonDto {
  @ApiProperty({
    type: String,
    description: 'REASON_CODES.chequeBounce, or .chequeReturn.',
  })
  @IsString()
  reasonCode: string;
}

export class ChequesQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, enum: CHEQUE_STATUSES })
  @IsOptional()
  @IsIn(CHEQUE_STATUSES, withParams({ allowed: [...CHEQUE_STATUSES] }))
  status?: (typeof CHEQUE_STATUSES)[number];

  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class StatementImportDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A `data_import` CSV the caller uploaded.',
  })
  @IsUUID()
  fileId: string;
}

export class StatementImportsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class StatementLinesQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiProperty({ required: false, enum: ['matched', 'unmatched'] })
  @IsOptional()
  @IsIn(
    ['matched', 'unmatched'],
    withParams({ allowed: ['matched', 'unmatched'] }),
  )
  status?: 'matched' | 'unmatched';
}

export class MatchLineDto {
  @ApiProperty({ enum: MATCH_KINDS })
  @IsIn(MATCH_KINDS, withParams({ allowed: [...MATCH_KINDS] }))
  kind: (typeof MATCH_KINDS)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The payment, cheque or transfer leg; not for an adjustment.',
  })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'An adjustment’s REASON_CODES.cashAdjust, and only an adjustment’s.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
