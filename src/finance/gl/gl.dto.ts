import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { HTTP_DEFAULT_LIMIT, PageQueryDto } from '../../core/common/http/list';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../core/common/validation/local-date';
import { PeriodDto } from '../reports/dto/ledger.dto';
import {
  GL_AMOUNT,
  GL_CODE,
  GL_LIMITS as L,
  GL_MANUAL_STATUSES,
  GL_MONTH,
  GL_SOURCES,
  type GlManualStatus,
  type GlSource,
} from './gl-rules';

const NAME = { min: 1, max: L.name } as const;
const LINES = L.lines;
const LIMIT = { min: 1, max: 100 } as const;

export class GlAsOfQueryDto {
  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The balances at the end of this local day; today by default.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  asOf?: string;
}

/** An account's lines of a period, a page at a time. */
export class GlLedgerQueryDto extends PeriodDto {
  @ApiPropertyOptional({
    type: String,
    description: 'Opaque cursor from the previous page (`nextCursor`).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 512, withParams({ min: 1, max: 512 }))
  cursor?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: LIMIT.min,
    maximum: LIMIT.max,
    default: HTTP_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(withParams(LIMIT))
  @Min(LIMIT.min, withParams(LIMIT))
  @Max(LIMIT.max, withParams(LIMIT))
  limit: number = HTTP_DEFAULT_LIMIT;
}

export class GlEntriesQueryDto extends GlLedgerQueryDto {
  @ApiPropertyOptional({ enum: GL_SOURCES })
  @IsOptional()
  @IsIn(GL_SOURCES, withParams({ allowed: [...GL_SOURCES] }))
  source?: GlSource;
}

export class GlCreateAccountDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The account it sits under: any but a control account (its register keeps it). It takes its type.',
  })
  @IsUUID()
  parentId: string;

  @ApiProperty({
    type: String,
    pattern: GL_CODE.source,
    example: '5130.01',
    description:
      'Its parent’s code, a dot, and one to three digits; once in the chart.',
  })
  @IsString()
  @Matches(GL_CODE)
  code: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr: string;
}

export class GlRenameAccountDto {
  @ApiPropertyOptional({
    type: String,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr?: string;
}

export class GlManualLineDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A postable account no register keeps.',
  })
  @IsUUID()
  accountId: string;

  @ApiPropertyOptional({
    type: String,
    pattern: GL_AMOUNT.source,
    description: 'A debit, or a credit: exactly one of the two.',
  })
  @IsOptional()
  @IsString()
  debit?: string;

  @ApiPropertyOptional({ type: String, pattern: GL_AMOUNT.source })
  @IsOptional()
  @IsString()
  credit?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: L.lineMemo })
  @IsOptional()
  @IsString()
  @Length(1, L.lineMemo, withParams({ min: 1, max: L.lineMemo }))
  memo?: string;
}

export class GlManualEntryDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'A day of an open month, no later than this month’s end (GL_PERIOD_CLOSED, INVALID_VALUE).',
  })
  @IsString()
  @IsLocalDate()
  postedOn: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: L.memo })
  @IsString()
  @Length(1, L.memo, withParams({ min: 1, max: L.memo }))
  memo: string;

  @ApiProperty({
    type: [GlManualLineDto],
    minItems: LINES.min,
    maxItems: LINES.max,
    description: 'Its debits equal its credits (GL_ENTRY_UNBALANCED).',
  })
  @IsArray()
  @ArrayMinSize(LINES.min, withParams(LINES))
  @ArrayMaxSize(LINES.max, withParams(LINES))
  @ValidateNested({ each: true })
  @Type(() => GlManualLineDto)
  lines: GlManualLineDto[];
}

export class GlReverseEntryDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'A day of an open month, no later than this month’s end.',
  })
  @IsString()
  @IsLocalDate()
  postedOn: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: L.memo })
  @IsString()
  @Length(1, L.memo, withParams({ min: 1, max: L.memo }))
  memo: string;
}

export class GlManualEntriesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: GL_MANUAL_STATUSES })
  @IsOptional()
  @IsIn(GL_MANUAL_STATUSES, withParams({ allowed: [...GL_MANUAL_STATUSES] }))
  status?: GlManualStatus;
}

export class GlRejectEntryDto {
  @ApiProperty({ type: String, description: 'A `glEntryReject` code.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class GlCloseMonthDto {
  @ApiProperty({
    type: String,
    pattern: GL_MONTH.source,
    example: '2026-10',
    description:
      'A month that has ended: it and every open month before it, from the ledger’s first, are closed.',
  })
  @IsString()
  @Matches(GL_MONTH)
  month: string;
}

export class GlReopenMonthDto {
  @ApiProperty({ type: String, pattern: GL_MONTH.source, example: '2026-10' })
  @IsString()
  @Matches(GL_MONTH)
  month: string;

  @ApiProperty({ type: String, description: 'A `glPeriodReopen` code.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
