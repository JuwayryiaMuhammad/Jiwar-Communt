import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MONEY } from '../../money';
import { LOCAL_DATE } from '../../invoices/dto/invoices.dto';

/** How many instalments a plan has (ADR 0048). */
export const INSTALMENTS = { min: 2, max: 24 } as const;
export const INSTALMENT_PLAN_STATUSES = [
  'active',
  'settled',
  'cancelled',
] as const;
export type InstalmentPlanStatus = (typeof INSTALMENT_PLAN_STATUSES)[number];

export class InstalmentDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'A local day of the compound: from today to 730 days ahead, after the instalment before.',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  dueOn: string;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'EGP, at least 1.00.',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;
}

/**
 * What an open invoice owes now, as instalments (ADR 0048). They must add
 * up to exactly that: a payment that lands first changes it, and the
 * answer is 409 INSTALMENTS_DONT_ADD_UP with the new figure.
 */
export class ConvertToInstalmentsDto {
  @ApiProperty({
    type: [InstalmentDto],
    minItems: INSTALMENTS.min,
    maxItems: INSTALMENTS.max,
  })
  @IsArray()
  @ArrayMinSize(INSTALMENTS.min, withParams(INSTALMENTS))
  @ArrayMaxSize(INSTALMENTS.max, withParams(INSTALMENTS))
  @ValidateNested({ each: true })
  @Type(() => InstalmentDto)
  instalments: InstalmentDto[];
}

export class CancelInstalmentPlanDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'When the remainder invoice falls due: from today to 366 days ahead.',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  dueOn: string;
}

export class InstalmentPlansQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    required: false,
    type: String,
    enum: INSTALMENT_PLAN_STATUSES,
  })
  @IsOptional()
  @IsIn(
    INSTALMENT_PLAN_STATUSES,
    withParams({ allowed: [...INSTALMENT_PLAN_STATUSES] }),
  )
  status?: InstalmentPlanStatus;
}
