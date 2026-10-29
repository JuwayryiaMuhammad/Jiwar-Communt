import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { IsLocalDate } from '../../core/common/validation/local-date';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  DEPOSIT_KINDS,
  DEPOSIT_METHODS,
  DepositsService,
  REFUND_CHANNELS,
  type DepositRead,
} from './deposits.service';

class DepositEventView {
  @ApiProperty({
    enum: [
      'refund_requested',
      'refund_withdrawn',
      'refunded',
      'deducted',
      'forfeited',
    ],
  })
  kind: string;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  amount: string | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
}

/** A deposit the management holds (ADR 0062). */
export class DepositWorksCompletionView {
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
  @ApiProperty({ type: String, example: 'WC-000012' })
  reference: string;
}

export class DepositView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: '`DP-` and the number.' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  occupancyId: string;
  @ApiProperty({ enum: DEPOSIT_KINDS })
  kind: string;
  @ApiProperty({ type: String, description: 'EGP received.' })
  amount: string;
  @ApiProperty({ type: String, description: 'EGP still held.' })
  held: string;
  @ApiProperty({ type: String, format: 'date' })
  receivedOn: string;
  @ApiProperty({ enum: DEPOSIT_METHODS })
  method: string;
  @ApiProperty({ type: Boolean })
  refundRequested: boolean;
  @ApiProperty({ type: [DepositEventView] })
  events: DepositEventView[];

  @ApiProperty({
    type: DepositWorksCompletionView,
    nullable: true,
    description:
      'A finishing-works deposit: the works found complete since it was received (the certificate’s number), or null until then; null for the other kinds.',
  })
  worksCompletion: DepositWorksCompletionView | null;

  static from(d: DepositRead): DepositView {
    return {
      ...d,
      events: d.events.map((e) => ({ ...e })),
      worksCompletion: d.worksCompletion ? { ...d.worksCompletion } : null,
    };
  }
}

const MONEY_TEXT = withParams({ format: 'amount' });
const AMOUNT = /^\d{1,7}(\.\d{1,2})?$/;

export class NewDepositDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The depositor’s active occupancy.',
  })
  @IsUUID()
  occupancyId: string;

  @ApiProperty({ enum: DEPOSIT_KINDS })
  @IsIn([...DEPOSIT_KINDS], withParams({ allowed: [...DEPOSIT_KINDS] }))
  kind: string;

  @ApiProperty({ type: String, example: '5000.00', description: 'EGP.' })
  @Matches(AMOUNT, MONEY_TEXT)
  amount: string;

  @ApiProperty({ type: String, format: 'date' })
  @IsLocalDate(withParams({ format: 'YYYY-MM-DD' }))
  receivedOn: string;

  @ApiProperty({ enum: DEPOSIT_METHODS })
  @IsIn([...DEPOSIT_METHODS], withParams({ allowed: [...DEPOSIT_METHODS] }))
  method: string;

  @ApiProperty({ type: String, required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  reference?: string;
}

class RefundPartDto {
  @ApiProperty({ type: String, description: 'EGP.' })
  @Matches(AMOUNT, MONEY_TEXT)
  amount: string;

  @ApiProperty({ enum: REFUND_CHANNELS })
  @IsIn([...REFUND_CHANNELS], withParams({ allowed: [...REFUND_CHANNELS] }))
  channel: string;
}

class CodedPartDto {
  @ApiProperty({
    type: String,
    description: 'A code (REASON_CODES.depositDeduction).',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({ type: String, description: 'EGP.' })
  @Matches(AMOUNT, MONEY_TEXT)
  amount: string;
}

/** What is paid back, kept and why (ADR 0062); never more than is held. */
export class SettleDepositDto {
  @ApiProperty({ type: RefundPartDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => RefundPartDto)
  refund?: RefundPartDto;

  @ApiProperty({
    type: [CodedPartDto],
    required: false,
    maxItems: 5,
    description:
      '`unpaid_dues` becomes an office payment of the unit (method `deposit_offset`).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, withParams({ max: 5 }))
  @ValidateNested({ each: true })
  @Type(() => CodedPartDto)
  deductions?: CodedPartDto[];

  @ApiProperty({ type: CodedPartDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => CodedPartDto)
  forfeit?: CodedPartDto;
}

/** A depositor's deposits: their occupancies' (ADR 0062). */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get('me/deposits')
  @ApiOperation({ summary: 'Deposits the management holds for me' })
  @ApiOkResponse({ type: [DepositView] })
  async mine(): Promise<DepositView[]> {
    return (await this.deposits.mine()).map((d) => DepositView.from(d));
  }

  @Post('deposits/:id/refund-request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask for my deposit back' })
  @ApiOkResponse({ type: DepositView })
  async askRefund(@Param('id', parseId()) id: string): Promise<DepositView> {
    return DepositView.from(await this.deposits.askRefund(id));
  }

  @Post('deposits/:id/refund-request/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my refund request' })
  @ApiOkResponse({ type: DepositView })
  async withdraw(@Param('id', parseId()) id: string): Promise<DepositView> {
    return DepositView.from(await this.deposits.withdrawRefund(id));
  }
}

/** Deposits, the management's side (ADR 0062). */
@ApiArea('finance')
@Controller('staff')
export class StaffDepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @RequirePermissions('deposits.manage')
  @Get('units/:unitId/deposits')
  @ApiOperation({ summary: 'A unit’s deposits' })
  @ApiOkResponse({ type: [DepositView] })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<DepositView[]> {
    return (await this.deposits.staffList(unitId)).map((d) =>
      DepositView.from(d),
    );
  }

  @RequirePermissions('deposits.manage')
  @Post('deposits')
  @ApiOperation({ summary: 'Record a deposit received' })
  @ApiCreatedResponse({ type: DepositView })
  async record(@Body() dto: NewDepositDto): Promise<DepositView> {
    return DepositView.from(await this.deposits.record(dto));
  }

  /** A fresh step-up (STEP_UP_REQUIRED); never more than is held (DEPOSIT_EXCEEDS_HELD). */
  @RequirePermissions('finance.refund')
  @Post('deposits/:id/settle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Settle a deposit: refund, deduct, forfeit' })
  @ApiOkResponse({ type: DepositView })
  async settle(
    @Param('id', parseId()) id: string,
    @Body() dto: SettleDepositDto,
  ): Promise<DepositView> {
    return DepositView.from(await this.deposits.settle(id, dto));
  }
}
