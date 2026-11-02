import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ENTRY_NOTE, ENTRY_PHOTOS, ENTRY_WITNESSES } from '../unit-entry-rules';

/** Staff went into a unit in an emergency (ADR 0083). */
export class RecordUnitEntryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: String,
    enum: REASON_CODES.unitEntryReason,
    description: '`unitEntryReason`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When staff went in: within the last 7 days.',
  })
  @ToInstant()
  @IsDate()
  enteredAt: Date;

  @ApiProperty({
    type: [String],
    minItems: ENTRY_WITNESSES.min,
    maxItems: ENTRY_WITNESSES.max,
    description:
      'Staff accounts who went in too, besides the caller: two staff at least.',
  })
  @IsArray()
  @ArrayMaxSize(10, withParams({ max: 10 }))
  @IsUUID('all', { each: true })
  witnessIds: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: ENTRY_PHOTOS.before,
    description: 'Finalized `unit_entry_photo` files of the caller: before.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, withParams({ max: 10 }))
  @IsUUID('all', { each: true })
  photoFileIds?: string[];
}

/** What was found, once. */
export class ReportUnitEntryDto {
  @ApiProperty({
    type: String,
    enum: REASON_CODES.unitEntryOutcome,
    description: '`unitEntryOutcome`.',
  })
  @IsOptional()
  @IsString()
  outcome?: string;

  @ApiProperty({
    type: String,
    minLength: ENTRY_NOTE.min,
    maxLength: ENTRY_NOTE.max,
    description:
      'What staff found and did: their words, read by the unit’s people.',
  })
  @IsString()
  note: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: ENTRY_PHOTOS.after,
    description: 'Finalized `unit_entry_photo` files of the caller: after.',
  })
  @IsArray()
  @ArrayMaxSize(10, withParams({ max: 10 }))
  @IsUUID('all', { each: true })
  photoFileIds: string[];
}

export class UnitEntriesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: ['open', 'reported'] })
  @IsOptional()
  @IsIn(['open', 'reported'], withParams({ allowed: ['open', 'reported'] }))
  status?: 'open' | 'reported';
}
