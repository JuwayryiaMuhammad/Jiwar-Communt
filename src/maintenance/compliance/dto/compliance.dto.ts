import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate } from '../../schedules/local-dates';
import {
  COMPLETION_FILES_MAX,
  COMPLIANCE_KINDS,
  COMPLIANCE_LIMITS,
  COMPLIANCE_NUMBER,
  LEAD_DAYS,
  RECURRENCE_MONTHS,
  type ComplianceKind,
} from '../compliance-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const len = (max: number) => withParams({ min: 1, max });
const LEAD = { min: LEAD_DAYS.min, max: LEAD_DAYS.max };
const MONTHS = { min: RECURRENCE_MONTHS.min, max: RECURRENCE_MONTHS.max };
const STATUSES = ['active', 'retired'] as const;

export class CreateComplianceItemDto {
  @ApiProperty({ enum: COMPLIANCE_KINDS, enumName: 'ComplianceKind' })
  @IsIn(COMPLIANCE_KINDS, allowed(COMPLIANCE_KINDS))
  kind: ComplianceKind;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: COMPLIANCE_LIMITS.title,
    description: 'The compound’s words: “Civil defence certificate, tower A”.',
  })
  @IsString()
  @Length(1, COMPLIANCE_LIMITS.title, len(COMPLIANCE_LIMITS.title))
  title: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: COMPLIANCE_LIMITS.authority,
    description: 'Who issues it: the civil defence, the insurer, the city.',
  })
  @IsOptional()
  @IsString()
  @Length(1, COMPLIANCE_LIMITS.authority, len(COMPLIANCE_LIMITS.authority))
  authority?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: COMPLIANCE_NUMBER.source,
    description: 'Its licence, policy or file number.',
  })
  @IsOptional()
  @IsString()
  @Matches(COMPLIANCE_NUMBER)
  reference?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'An asset of the compound’s own, not retired (a lift); never with `commonAreaId`.',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'An active common area (a building, the pool); never with `assetId`.',
  })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The vendor of the register who answers for it (ADR 0077); not a suspended one. With `ownerId`, or alone.',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The staff member who answers for it: an active staff member or the manager. Told. With `vendorId`, or alone.',
  })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: RECURRENCE_MONTHS.min,
    maximum: RECURRENCE_MONTHS.max,
    description: 'Every how many months it is due again; none: once.',
  })
  @IsOptional()
  @IsInt()
  @Min(MONTHS.min, withParams(MONTHS))
  @Max(MONTHS.max, withParams(MONTHS))
  recurrenceMonths?: number;

  @ApiPropertyOptional({
    type: [Number],
    maxItems: LEAD_DAYS.count,
    description:
      'Its own lead times, 1 to 365 days each, at most three; empty or none: the compound’s.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LEAD_DAYS.count, withParams({ max: LEAD_DAYS.count }))
  @IsInt({ each: true })
  @Min(LEAD.min, { each: true, ...withParams(LEAD) })
  @Max(LEAD.max, { each: true, ...withParams(LEAD) })
  leadDays?: number[];

  @ApiPropertyOptional({ type: String, maxLength: COMPLIANCE_LIMITS.notes })
  @IsOptional()
  @IsString()
  @Length(1, COMPLIANCE_LIMITS.notes, len(COMPLIANCE_LIMITS.notes))
  notes?: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Its first due day: from today, ten years ahead at most.',
  })
  @IsString()
  @IsLocalDate()
  firstDueOn: string;
}

/** Every field optional; null clears an optional one. */
export class UpdateComplianceItemDto {
  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: COMPLIANCE_LIMITS.title,
  })
  @IsOptional()
  @IsString()
  @Length(1, COMPLIANCE_LIMITS.title, len(COMPLIANCE_LIMITS.title))
  title?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: COMPLIANCE_LIMITS.authority,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, COMPLIANCE_LIMITS.authority, len(COMPLIANCE_LIMITS.authority))
  authority?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: COMPLIANCE_NUMBER.source,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(COMPLIANCE_NUMBER)
  reference?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  assetId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  commonAreaId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null takes the vendor away, when a staff member answers.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  vendorId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Null takes the staff member away, when a vendor answers. A new one is told.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  ownerId?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: RECURRENCE_MONTHS.min,
    maximum: RECURRENCE_MONTHS.max,
    description: 'Null: once.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(MONTHS.min, withParams(MONTHS))
  @Max(MONTHS.max, withParams(MONTHS))
  recurrenceMonths?: number | null;

  @ApiPropertyOptional({
    type: [Number],
    maxItems: LEAD_DAYS.count,
    description: 'Empty: the compound’s lead times.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LEAD_DAYS.count, withParams({ max: LEAD_DAYS.count }))
  @IsInt({ each: true })
  @Min(LEAD.min, { each: true, ...withParams(LEAD) })
  @Max(LEAD.max, { each: true, ...withParams(LEAD) })
  leadDays?: number[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: COMPLIANCE_LIMITS.notes,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, COMPLIANCE_LIMITS.notes, len(COMPLIANCE_LIMITS.notes))
  notes?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'Moves the open due day (the authority gave another): from today. Its notices start again.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  nextDueOn?: string;
}

export class CompleteOccurrenceDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'The day it was done: not after today, a year back at most.',
  })
  @IsString()
  @IsLocalDate()
  doneOn: string;

  @ApiPropertyOptional({
    type: String,
    pattern: COMPLIANCE_NUMBER.source,
    description: 'The certificate’s, licence’s or policy’s number it gave.',
  })
  @IsOptional()
  @IsString()
  @Matches(COMPLIANCE_NUMBER)
  certificateNumber?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'When what it gave expires, after `doneOn`: the next due day, unless `nextDueOn` is given.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  expiresOn?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: COMPLIANCE_LIMITS.note,
    description: 'About the work, never a person.',
  })
  @IsOptional()
  @IsString()
  @Length(1, COMPLIANCE_LIMITS.note, len(COMPLIANCE_LIMITS.note))
  note?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'The next due day, after `doneOn`; by default the expiry, else so many months on, else none.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  nextDueOn?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: COMPLETION_FILES_MAX,
    description: 'Finalized `compliance_evidence` uploads, filed with it.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COMPLETION_FILES_MAX, withParams({ max: COMPLETION_FILES_MAX }))
  @IsUUID('all', { each: true })
  fileIds?: string[];
}

export class AddEvidenceDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A finalized `compliance_evidence` upload.',
  })
  @IsUUID()
  fileId: string;
}

export class ComplianceSettingsDto {
  @ApiProperty({
    type: [Number],
    minItems: 1,
    maxItems: LEAD_DAYS.count,
    description: 'One to three lead times, 1 to 365 days each.',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1 }))
  @ArrayMaxSize(LEAD_DAYS.count, withParams({ max: LEAD_DAYS.count }))
  @IsInt({ each: true })
  @Min(LEAD.min, { each: true, ...withParams(LEAD) })
  @Max(LEAD.max, { each: true, ...withParams(LEAD) })
  leadDays: number[];
}

export class ComplianceItemsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: COMPLIANCE_KINDS, enumName: 'ComplianceKind' })
  @IsOptional()
  @IsIn(COMPLIANCE_KINDS, allowed(COMPLIANCE_KINDS))
  kind?: ComplianceKind;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES, allowed(STATUSES))
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetId?: string;
}

export class ComplianceCalendarQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: '2027-05-01',
    description: 'The compound’s first day: today by default.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2027-07-29',
    description:
      'The last day: 90 days by default, 366 at most (PERIOD_TOO_LONG).',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}
