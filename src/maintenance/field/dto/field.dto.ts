import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketPriority } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import { REASON_CODES } from '../../../core/common/reasons';
import {
  ITEM_UNIT,
  METRIC_KEY,
  READING,
} from '../../checklists/checklist-rules';
import { DESCRIPTION_LENGTH } from '../../tickets/ticket-limits';

const NOTE = { min: 1, max: 1000 };
const READINGS = { min: 1, max: 20 };
const STATUSES = ['pending', 'accepted', 'declined'] as const;

export class TagScanDto {
  @ApiProperty({
    type: String,
    maxLength: 200,
    description:
      'What the QR holds: `JWA1.…` (an asset) or `JWL1.…` (an area).',
  })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  code: string;
}

export class ReadingDto {
  @ApiProperty({ type: String, pattern: METRIC_KEY.source })
  @IsString()
  @Matches(METRIC_KEY)
  metricKey: string;

  @ApiProperty({ type: String, pattern: READING.source })
  @IsString()
  @Matches(READING)
  value: string;

  @ApiPropertyOptional({
    type: String,
    minLength: ITEM_UNIT.min,
    maxLength: ITEM_UNIT.max,
  })
  @IsOptional()
  @IsString()
  @Length(ITEM_UNIT.min, ITEM_UNIT.max, withParams(ITEM_UNIT))
  unit?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When it was read, with its offset: within the last 30 days, never ahead.',
  })
  @ToInstant()
  @IsDate()
  occurredAt: Date;
}

export class RecordReadingsDto {
  @ApiProperty({
    type: [ReadingDto],
    minItems: READINGS.min,
    maxItems: READINGS.max,
  })
  @IsArray()
  @ArrayMinSize(READINGS.min, withParams(READINGS))
  @ArrayMaxSize(READINGS.max, withParams(READINGS))
  @ValidateNested({ each: true })
  @Type(() => ReadingDto)
  readings: ReadingDto[];
}

export class ReportFaultDto {
  @ApiProperty({
    type: String,
    minLength: DESCRIPTION_LENGTH.min,
    maxLength: DESCRIPTION_LENGTH.max,
  })
  @IsString()
  @Length(
    DESCRIPTION_LENGTH.min,
    DESCRIPTION_LENGTH.max,
    withParams(DESCRIPTION_LENGTH),
  )
  description: string;

  @ApiPropertyOptional({
    enum: TicketPriority,
    enumName: 'TicketPriority',
    default: 'normal',
  })
  @IsOptional()
  @IsEnum(
    TicketPriority,
    withParams({ allowed: Object.values(TicketPriority) }),
  )
  priority?: TicketPriority;

  @ApiPropertyOptional({
    type: [String],
    description:
      'The caller’s finalized `ticket_photo` files, as many as the compound allows.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  photoFileIds?: string[];
}

export class RecommendReplacementDto {
  @ApiProperty({ enum: REASON_CODES.replacementReason })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: NOTE.min,
    maxLength: NOTE.max,
  })
  @IsOptional()
  @IsString()
  @Length(NOTE.min, NOTE.max, withParams(NOTE))
  note?: string;
}

export class ReplacementsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetId?: string;
}
