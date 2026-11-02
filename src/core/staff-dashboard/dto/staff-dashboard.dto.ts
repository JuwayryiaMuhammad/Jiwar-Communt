import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PageQueryDto } from '../../common/http/list';
import { withParams } from '../../common/validation/validation-errors';
import { BRIEF_KINDS, type BriefKind } from '../staff-briefs.service';
import { TIME_OF_DAY } from '../staff-dashboard.service';

/** When the brief and the review are written; absent keeps, null turns off. */
export class UpdateDashboardSettingsDto {
  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    example: '07:00',
    description:
      '`HH:MM` in the compound’s time zone; null: no daily brief. Before `reviewAt` (ENDS_BEFORE_START).',
  })
  @IsOptional()
  @IsString()
  @Matches(TIME_OF_DAY)
  briefAt?: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    example: '17:00',
    description: '`HH:MM`; null: no end-of-day review. After `briefAt`.',
  })
  @IsOptional()
  @IsString()
  @Matches(TIME_OF_DAY)
  reviewAt?: string | null;
}

export class BriefsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, enum: BRIEF_KINDS, enumName: 'BriefKind' })
  @IsOptional()
  @IsIn(BRIEF_KINDS, withParams({ allowed: [...BRIEF_KINDS] }))
  kind?: BriefKind;
}
