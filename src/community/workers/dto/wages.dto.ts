import { ApiProperty } from '@nestjs/swagger';
import { WageObligationKind } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** ADR 0037. Amounts are checked by the service (like a finance cap). */
export class SetWageDto {
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    nullable: true,
    example: '3200.00',
    description:
      'Per month, in the compound’s currency, at most two decimals; null clears it.',
  })
  @IsOptional()
  monthlyWage?: string | number | null;
}

export class PayWageDto {
  @ApiProperty({ type: String, example: '2026-09', description: '`YYYY-MM`' })
  @IsString()
  @Matches(MONTH, withParams({ format: 'YYYY-MM' }))
  period: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    example: '3200.00',
    description:
      'In the compound’s currency, at most two decimals. Need not equal the monthly wage.',
  })
  @IsOptional()
  amount?: string | number;
}

const KINDS = Object.values(WageObligationKind);

/**
 * ADR 0037. An engagement may hold one open obligation of each kind, so the
 * kind is named (`settle_before_close` when it is not); the reason code is
 * checked by the service against the kind's closed list. The enum's
 * description is the view's: the schema is shared.
 */
export class SettleWageObligationDto {
  @ApiProperty({
    enum: KINDS,
    enumName: 'WageObligationKind',
    required: false,
  })
  @IsOptional()
  @IsEnum(WageObligationKind, withParams({ allowed: KINDS }))
  kind?: WageObligationKind;

  @ApiProperty({
    type: String,
    description:
      'A code from the closed list for the kind; see `allowed` on INVALID_REASON_CODE.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
