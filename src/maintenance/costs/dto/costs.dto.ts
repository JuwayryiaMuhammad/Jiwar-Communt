import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  COST_DESCRIPTION_MAX,
  MONEY,
  QUANTITY,
  RECORDED_COST_KINDS,
  type RecordedCostKind,
} from '../cost-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });

export class RecordCostDto {
  @ApiProperty({
    enum: RECORDED_COST_KINDS,
    description: 'A part’s cost is the store’s: it is written as it issues.',
  })
  @IsIn(RECORDED_COST_KINDS, allowed(RECORDED_COST_KINDS))
  kind: RecordedCostKind;

  @ApiProperty({
    type: String,
    maxLength: COST_DESCRIPTION_MAX,
    description: 'What it was: hours of whom, which contractor, what.',
  })
  @IsString()
  @Length(
    1,
    COST_DESCRIPTION_MAX,
    withParams({ min: 1, max: COST_DESCRIPTION_MAX }),
  )
  description: string;

  @ApiProperty({
    type: String,
    pattern: QUANTITY.source,
    description: 'Positive, three decimals at most: hours, visits, items.',
  })
  @IsString()
  @Matches(QUANTITY)
  quantity: string;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'EGP for one, e.g. `150` or `150.50`.',
  })
  @IsString()
  @Matches(MONEY)
  unitAmount: string;
}
