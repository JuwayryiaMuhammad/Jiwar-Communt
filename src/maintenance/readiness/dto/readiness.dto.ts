import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate } from '../../schedules/local-dates';
import {
  ESTIMATE,
  READINESS_ITEM_KINDS,
  READINESS_KINDS,
  TITLE_MAX,
  type ReadinessItemKind,
  type ReadinessKind,
} from '../readiness-rules';

const BOOL = ['true', 'false'] as const;
const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const TITLE = { min: 1, max: TITLE_MAX };
const AMOUNT_TEXT = withParams({ format: 'amount' });
const DECISIONS = REASON_CODES.contractReviewDecision;

export class CreateProgramDto {
  @ApiProperty({ enum: READINESS_KINDS, enumName: 'ReadinessKind' })
  @IsIn(READINESS_KINDS, allowed(READINESS_KINDS))
  kind: ReadinessKind;

  @ApiProperty({ type: String, minLength: 1, maxLength: TITLE_MAX })
  @IsString()
  @Length(TITLE.min, TITLE.max, withParams(TITLE))
  title: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description:
      'The compound’s first day of the season or event: Ramadan and Eid move, so it is stated.',
  })
  @IsString()
  @IsLocalDate()
  startsOn: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Its last day, inclusive; a year and a day at most.',
  })
  @IsString()
  @IsLocalDate()
  endsOn: string;
}

export class UpdateProgramDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: TITLE_MAX })
  @IsOptional()
  @IsString()
  @Length(TITLE.min, TITLE.max, withParams(TITLE))
  title?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  startsOn?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description: 'On or after every item’s day.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  endsOn?: string;
}

export class CopyProgramDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description:
      'The copy’s first day, from today. Its end and every item’s day move by as many days.',
  })
  @IsString()
  @IsLocalDate()
  startsOn: string;
}

export class ProgramsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: READINESS_KINDS, enumName: 'ReadinessKind' })
  @IsOptional()
  @IsIn(READINESS_KINDS, allowed(READINESS_KINDS))
  kind?: ReadinessKind;

  @ApiPropertyOptional({
    enum: BOOL,
    description: '`true`: not closed; `false`: closed.',
  })
  @IsOptional()
  @IsIn(BOOL, allowed(BOOL))
  open?: 'true' | 'false';
}

export class CreateItemDto {
  @ApiProperty({ enum: READINESS_ITEM_KINDS, enumName: 'ReadinessItemKind' })
  @IsIn(READINESS_ITEM_KINDS, allowed(READINESS_ITEM_KINDS))
  kind: ReadinessItemKind;

  @ApiProperty({ type: String, minLength: 1, maxLength: TITLE_MAX })
  @IsString()
  @Length(TITLE.min, TITLE.max, withParams(TITLE))
  title: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active staff member or the manager. Told.',
  })
  @IsUUID()
  ownerId: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'From today, by the program’s last day.',
  })
  @IsString()
  @IsLocalDate()
  dueOn: string;

  @ApiPropertyOptional({
    type: String,
    pattern: ESTIMATE.source,
    example: '12500.00',
    description:
      'EGP, more than 0: an estimate’s (required), or a task’s; never another kind’s.',
  })
  @IsOptional()
  @IsString()
  @Matches(ESTIMATE, AMOUNT_TEXT)
  estimateAmount?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'A contract review’s maintenance contract: in force, ending by the program’s last day.',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'An inspection campaign’s checklist, for inspections.',
  })
  @IsOptional()
  @IsUUID()
  checklistId?: string;
}

export class UpdateItemDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: TITLE_MAX })
  @IsOptional()
  @IsString()
  @Length(TITLE.min, TITLE.max, withParams(TITLE))
  title?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  dueOn?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: ESTIMATE.source,
    description: 'EGP; null takes a task’s away.',
  })
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsString()
  @Matches(ESTIMATE, AMOUNT_TEXT)
  estimateAmount?: string | null;
}

export class ItemDoneDto {
  @ApiPropertyOptional({
    enum: DECISIONS,
    enumName: 'ContractReviewDecision',
    description: 'A contract review’s, required; no other kind’s.',
  })
  @IsOptional()
  @IsIn(DECISIONS, allowed(DECISIONS))
  decision?: (typeof DECISIONS)[number];
}
