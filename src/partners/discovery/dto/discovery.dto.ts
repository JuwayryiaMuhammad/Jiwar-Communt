import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PARTNER_CATEGORIES, type PartnerCategory } from '../../categories';

const BOOLEAN = ['true', 'false'] as const;
type Bool = (typeof BOOLEAN)[number];

function Flag(description: string) {
  return (target: object, key: string) => {
    ApiProperty({ enum: BOOLEAN, required: false, description })(target, key);
    IsOptional()(target, key);
    IsIn(BOOLEAN, withParams({ allowed: [...BOOLEAN] }))(target, key);
  };
}

/** The partners list's filters; they combine. A bounded list, never paged. */
export class PartnersQueryDto {
  @ApiProperty({
    enum: PARTNER_CATEGORIES,
    enumName: 'PartnerCategory',
    required: false,
  })
  @IsOptional()
  @IsIn(PARTNER_CATEGORIES, withParams({ allowed: [...PARTNER_CATEGORIES] }))
  category?: PartnerCategory;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  subcategoryId?: string;

  @Flag('`true`: open now, in the compound’s time zone.')
  openNow?: Bool;

  @Flag(
    '`true`: open at some moment still ahead tonight, after the compound’s late hour (22:00 by default).',
  )
  openLate?: Bool;

  @Flag('`true`: listed within the compound’s "new" days (30 by default).')
  new?: Bool;

  @Flag('`true`: the caller’s favourites only.')
  favourites?: Bool;
}
