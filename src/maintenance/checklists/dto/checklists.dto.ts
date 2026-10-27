import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketPriority } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { CATEGORY_KEY } from '../../categories/dto/categories.dto';
import {
  ANSWER_NOTE,
  CHECK_RESULTS,
  CHECKLIST_PURPOSES,
  ITEM_KINDS,
  ITEM_LABEL,
  ITEM_UNIT,
  MAX_ITEMS,
  METRIC_KEY,
  PHOTOS_PER_ANSWER,
  READING,
  type CheckResult,
  type ChecklistPurpose,
  type ItemKind,
} from '../checklist-rules';

const NAME = { min: 1, max: 80 };
const ITEMS = { min: 1, max: MAX_ITEMS };
const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });

export class ChecklistItemDto {
  @ApiProperty({ enum: ITEM_KINDS })
  @IsIn(ITEM_KINDS, allowed(ITEM_KINDS))
  kind: ItemKind;

  @ApiProperty({
    type: String,
    minLength: ITEM_LABEL.min,
    maxLength: ITEM_LABEL.max,
  })
  @IsString()
  @Length(ITEM_LABEL.min, ITEM_LABEL.max, withParams(ITEM_LABEL))
  labelAr: string;

  @ApiProperty({
    type: String,
    minLength: ITEM_LABEL.min,
    maxLength: ITEM_LABEL.max,
  })
  @IsString()
  @Length(ITEM_LABEL.min, ITEM_LABEL.max, withParams(ITEM_LABEL))
  labelEn: string;

  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({
    type: String,
    pattern: METRIC_KEY.source,
    description:
      'A reading’s metric (e.g. `pressure_bar`, `run_hours`): its readings are the asset’s.',
  })
  @IsOptional()
  @IsString()
  @Matches(METRIC_KEY)
  metricKey?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: ITEM_UNIT.min,
    maxLength: ITEM_UNIT.max,
  })
  @IsOptional()
  @IsString()
  @Length(ITEM_UNIT.min, ITEM_UNIT.max, withParams(ITEM_UNIT))
  unit?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: READING.source,
    description: 'A reading below it fails.',
  })
  @IsOptional()
  @IsString()
  @Matches(READING)
  minValue?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: READING.source,
    description: 'A reading above it fails.',
  })
  @IsOptional()
  @IsString()
  @Matches(READING)
  maxValue?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'A check or a reading that fails opens a follow-up ticket (an inspection’s).',
  })
  @IsOptional()
  @IsBoolean()
  failCreatesTicket?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'The follow-up’s category: an active one.',
  })
  @IsOptional()
  @IsUUID()
  followUpCategoryId?: string;

  @ApiPropertyOptional({ enum: TicketPriority, enumName: 'TicketPriority' })
  @IsOptional()
  @IsEnum(TicketPriority, allowed(Object.values(TicketPriority)))
  followUpPriority?: TicketPriority;
}

class ChecklistItemsDto {
  @ApiProperty({
    type: [ChecklistItemDto],
    minItems: ITEMS.min,
    maxItems: ITEMS.max,
  })
  @IsArray()
  @ArrayMinSize(ITEMS.min, withParams(ITEMS))
  @ArrayMaxSize(ITEMS.max, withParams(ITEMS))
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  items: ChecklistItemDto[];
}

export class CreateChecklistDto extends ChecklistItemsDto {
  @ApiProperty({
    type: String,
    pattern: CATEGORY_KEY.source,
    description: 'Stable code; never changes.',
  })
  @IsString()
  @Matches(CATEGORY_KEY)
  key: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn: string;

  @ApiProperty({
    enum: CHECKLIST_PURPOSES,
    description: '`pm`: a plan’s; `inspection`: a round’s; `any`: both.',
  })
  @IsIn(CHECKLIST_PURPOSES, allowed(CHECKLIST_PURPOSES))
  purpose: ChecklistPurpose;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'The tag must be scanned before it is submitted.',
  })
  @IsOptional()
  @IsBoolean()
  requireScan?: boolean;
}

export class ReplaceChecklistItemsDto extends ChecklistItemsDto {}

export class UpdateChecklistDto {
  @ApiPropertyOptional({
    type: String,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  requireScan?: boolean;

  @ApiPropertyOptional({ type: Boolean, description: 'False retires it.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ChecklistAnswerDto {
  @ApiPropertyOptional({
    enum: CHECK_RESULTS,
    description: 'A check’s result.',
  })
  @IsOptional()
  @IsIn(CHECK_RESULTS, allowed(CHECK_RESULTS))
  result?: CheckResult;

  @ApiPropertyOptional({
    type: String,
    pattern: READING.source,
    description: 'A reading’s value.',
  })
  @IsOptional()
  @IsString()
  @Matches(READING)
  value?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: ANSWER_NOTE.min,
    maxLength: ANSWER_NOTE.max,
  })
  @IsOptional()
  @IsString()
  @Length(ANSWER_NOTE.min, ANSWER_NOTE.max, withParams(ANSWER_NOTE))
  note?: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: PHOTOS_PER_ANSWER,
    description:
      'The caller’s finalized `checklist_photo` files, added to the answer’s (three at most).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PHOTOS_PER_ANSWER, withParams({ max: PHOTOS_PER_ANSWER }))
  @IsUUID(undefined, { each: true })
  photoFileIds?: string[];
}
