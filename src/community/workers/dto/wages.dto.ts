import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
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
