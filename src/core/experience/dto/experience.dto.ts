import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/http/list';
import { REASON_CODES } from '../../common/reasons';
import { IsLocalDate } from '../../common/validation/local-date';
import { withParams } from '../../common/validation/validation-errors';
import {
  COMPENSATION_KINDS,
  COMPENSATION_NOTE,
  COMPENSATION_STATUSES,
  type CompensationKind,
  type CompensationStatus,
} from '../compensations.service';
import {
  CASE_KINDS,
  CASE_NOTE,
  CASE_STATUSES,
  type CaseKind,
  type CaseStatus,
} from '../experience-cases.service';
import { RULE_COUNT, RULE_DAYS } from '../experience-settings.service';
import {
  PROMISE_METRICS,
  RATING_SOURCES,
  SIGNAL_CODES,
  type PromiseMetric,
  type RatingSource,
  type SignalCode,
} from '../experience-sources';
import {
  HOURS_TARGET,
  PROMISE_TITLE,
  SHARE_TARGET,
} from '../service-promises.service';

/** EGP, more than zero, two decimals at most (the tables' bound). */
export const MONEY = /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/;
const BOOL = ['true', 'false'] as const;

// ----------------------------------------------------------------------------
// The signal thresholds
// ----------------------------------------------------------------------------

export class SignalRuleDto {
  @ApiProperty({ enum: SIGNAL_CODES, enumName: 'ExperienceSignalCode' })
  @IsIn(SIGNAL_CODES, withParams({ allowed: [...SIGNAL_CODES] }))
  code: SignalCode;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    minimum: RULE_COUNT.min,
    maximum: RULE_COUNT.max,
    description: 'How many events make a signal; null turns the rule off.',
  })
  @IsOptional()
  @ValidateIf((o: SignalRuleDto) => o.count !== null)
  @IsInt(withParams(RULE_COUNT))
  @Min(RULE_COUNT.min, withParams(RULE_COUNT))
  @Max(RULE_COUNT.max, withParams(RULE_COUNT))
  count?: number | null;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: RULE_DAYS.min,
    maximum: RULE_DAYS.max,
    description: 'Within how many days back from now.',
  })
  @IsOptional()
  @IsInt(withParams(RULE_DAYS))
  @Min(RULE_DAYS.min, withParams(RULE_DAYS))
  @Max(RULE_DAYS.max, withParams(RULE_DAYS))
  days?: number;
}

export class UpdateExperienceSettingsDto {
  @ApiProperty({
    type: [SignalRuleDto],
    minItems: 1,
    maxItems: SIGNAL_CODES.length,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: SIGNAL_CODES.length }))
  @ArrayMaxSize(
    SIGNAL_CODES.length,
    withParams({ min: 1, max: SIGNAL_CODES.length }),
  )
  @ValidateNested({ each: true })
  @Type(() => SignalRuleDto)
  items: SignalRuleDto[];
}

export class SignalsQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    enum: SIGNAL_CODES,
    enumName: 'ExperienceSignalCode',
    required: false,
  })
  @IsOptional()
  @IsIn(SIGNAL_CODES, withParams({ allowed: [...SIGNAL_CODES] }))
  code?: SignalCode;
}

// ----------------------------------------------------------------------------
// Cases
// ----------------------------------------------------------------------------

export class ExperienceCasesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: CASE_STATUSES,
    enumName: 'ExperienceCaseStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(CASE_STATUSES, withParams({ allowed: [...CASE_STATUSES] }))
  status?: CaseStatus;

  @ApiProperty({
    enum: CASE_KINDS,
    enumName: 'ExperienceCaseKind',
    required: false,
  })
  @IsOptional()
  @IsIn(CASE_KINDS, withParams({ allowed: [...CASE_KINDS] }))
  kind?: CaseKind;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

export class OpenCaseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;

  @ApiProperty({ enum: CASE_KINDS, enumName: 'ExperienceCaseKind' })
  @IsIn(CASE_KINDS, withParams({ allowed: [...CASE_KINDS] }))
  kind: CaseKind;

  @ApiProperty({
    enum: RATING_SOURCES,
    enumName: 'ExperienceSourceType',
    required: false,
    description: 'What it is about, with `sourceId`: both or neither.',
  })
  @IsOptional()
  @IsIn(RATING_SOURCES, withParams({ allowed: [...RATING_SOURCES] }))
  sourceType?: RatingSource;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'What failed: `creditNoteCompensation` (the compensation reasons, ADR 0058).',
  })
  @IsOptional()
  @IsIn(
    REASON_CODES.creditNoteCompensation,
    withParams({ allowed: [...REASON_CODES.creditNoteCompensation] }),
  )
  failureCode?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: CASE_NOTE.min,
    maxLength: CASE_NOTE.max,
    description: 'Staff’s words, plain data: never in the audit trail.',
  })
  @IsOptional()
  @IsString()
  @Length(CASE_NOTE.min, CASE_NOTE.max, withParams(CASE_NOTE))
  note?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'An active staff or manager account, told.',
  })
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

export class AssignCaseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  ownerId: string;
}

export class CloseCaseDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `experienceCaseOutcome`.',
  })
  @IsIn(
    REASON_CODES.experienceCaseOutcome,
    withParams({ allowed: [...REASON_CODES.experienceCaseOutcome] }),
  )
  outcome: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: CASE_NOTE.min,
    maxLength: CASE_NOTE.max,
    description: 'Staff’s words on how it ended, plain data.',
  })
  @IsOptional()
  @IsString()
  @Length(CASE_NOTE.min, CASE_NOTE.max, withParams(CASE_NOTE))
  note?: string;
}

// ----------------------------------------------------------------------------
// Compensations and their rules
// ----------------------------------------------------------------------------

export class CompensationsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: COMPENSATION_STATUSES,
    enumName: 'CompensationStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(
    COMPENSATION_STATUSES,
    withParams({ allowed: [...COMPENSATION_STATUSES] }),
  )
  status?: CompensationStatus;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  caseId?: string;
}

export class ProposeCompensationDto {
  @ApiProperty({ enum: COMPENSATION_KINDS, enumName: 'CompensationKind' })
  @IsIn(COMPENSATION_KINDS, withParams({ allowed: [...COMPENSATION_KINDS] }))
  kind: CompensationKind;

  @ApiProperty({
    type: String,
    description:
      'What failed: `creditNoteCompensation`. A credit carries it to the credit note.',
  })
  @IsIn(
    REASON_CODES.creditNoteCompensation,
    withParams({ allowed: [...REASON_CODES.creditNoteCompensation] }),
  )
  failureCode: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: MONEY.source,
    description: 'EGP: required on a credit, refused on the other kinds.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  amount?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: COMPENSATION_NOTE.min,
    maxLength: COMPENSATION_NOTE.max,
    description: 'Staff’s words, plain data: never in the audit trail.',
  })
  @IsOptional()
  @IsString()
  @Length(
    COMPENSATION_NOTE.min,
    COMPENSATION_NOTE.max,
    withParams(COMPENSATION_NOTE),
  )
  note?: string;
}

export class DecideCompensationDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'], withParams({ allowed: ['approve', 'reject'] }))
  decision: 'approve' | 'reject';

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'Approving a credit: the unit’s invoice the credit note is issued on (not under an open dispute).',
  })
  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'Approving a credit above the binding compensation_above_limit threshold (ADR 0073): what the board approved for it, used once; NEEDS_BOARD_APPROVAL without it, FIELD_NOT_ALLOWED within the threshold.',
  })
  @IsOptional()
  @IsUUID()
  authorizationId?: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'Rejecting: from the closed list `compensationReject`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class CompensationRuleDto {
  @ApiProperty({
    type: String,
    description: 'A code of `creditNoteCompensation`.',
  })
  @IsString()
  failureCode: string;

  @ApiProperty({
    enum: COMPENSATION_KINDS,
    enumName: 'CompensationKind',
    nullable: true,
    description: 'What is recommended; null removes the rule.',
  })
  @ValidateIf((o: CompensationRuleDto) => o.kind !== null)
  @IsIn(COMPENSATION_KINDS, withParams({ allowed: [...COMPENSATION_KINDS] }))
  kind: CompensationKind | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    pattern: MONEY.source,
    description: 'EGP: a credit’s recommended amount.',
  })
  @IsOptional()
  @ValidateIf((o: CompensationRuleDto) => o.amount !== null)
  @IsString()
  @Matches(MONEY)
  amount?: string | null;
}

export class UpdateCompensationRulesDto {
  @ApiProperty({
    type: [CompensationRuleDto],
    minItems: 1,
    maxItems: REASON_CODES.creditNoteCompensation.length,
  })
  @IsArray()
  @ArrayMinSize(
    1,
    withParams({ min: 1, max: REASON_CODES.creditNoteCompensation.length }),
  )
  @ArrayMaxSize(
    REASON_CODES.creditNoteCompensation.length,
    withParams({ min: 1, max: REASON_CODES.creditNoteCompensation.length }),
  )
  @ValidateNested({ each: true })
  @Type(() => CompensationRuleDto)
  items: CompensationRuleDto[];
}

// ----------------------------------------------------------------------------
// Service promises and the reports
// ----------------------------------------------------------------------------

export class PromisesQueryDto {
  @ApiProperty({ enum: BOOL, required: false })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  active?: (typeof BOOL)[number];
}

class PromiseTermsDto {
  @ApiProperty({
    enum: PROMISE_METRICS,
    enumName: 'ServicePromiseMetric',
    nullable: true,
    required: false,
    description: 'How it is measured; null: listed, not measured.',
  })
  @IsOptional()
  @ValidateIf((o: PromiseTermsDto) => o.metric !== null)
  @IsIn(PROMISE_METRICS, withParams({ allowed: [...PROMISE_METRICS] }))
  metric?: PromiseMetric | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description: `Hours (${HOURS_TARGET.min}–${HOURS_TARGET.max}) for an hours metric, an average rating (1–5) for a rating one.`,
  })
  @IsOptional()
  @ValidateIf((o: PromiseTermsDto) => o.target !== null)
  @IsNumber({ maxDecimalPlaces: 2 }, withParams(HOURS_TARGET))
  target?: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    minimum: SHARE_TARGET.min,
    maximum: SHARE_TARGET.max,
    description:
      'The share of items within the hours, %: an hours metric only.',
  })
  @IsOptional()
  @ValidateIf((o: PromiseTermsDto) => o.targetShare !== null)
  @IsInt(withParams(SHARE_TARGET))
  @Min(SHARE_TARGET.min, withParams(SHARE_TARGET))
  @Max(SHARE_TARGET.max, withParams(SHARE_TARGET))
  targetShare?: number | null;
}

export class CreatePromiseDto extends PromiseTermsDto {
  @ApiProperty({
    type: String,
    minLength: PROMISE_TITLE.min,
    maxLength: PROMISE_TITLE.max,
  })
  @IsString()
  @Length(PROMISE_TITLE.min, PROMISE_TITLE.max, withParams(PROMISE_TITLE))
  titleEn: string;

  @ApiProperty({
    type: String,
    minLength: PROMISE_TITLE.min,
    maxLength: PROMISE_TITLE.max,
  })
  @IsString()
  @Length(PROMISE_TITLE.min, PROMISE_TITLE.max, withParams(PROMISE_TITLE))
  titleAr: string;
}

export class UpdatePromiseDto extends PromiseTermsDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: PROMISE_TITLE.min,
    maxLength: PROMISE_TITLE.max,
  })
  @IsOptional()
  @IsString()
  @Length(PROMISE_TITLE.min, PROMISE_TITLE.max, withParams(PROMISE_TITLE))
  titleEn?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: PROMISE_TITLE.min,
    maxLength: PROMISE_TITLE.max,
  })
  @IsOptional()
  @IsString()
  @Length(PROMISE_TITLE.min, PROMISE_TITLE.max, withParams(PROMISE_TITLE))
  titleAr?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'false retires it.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ExperiencePeriodQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'The compound’s first day; 30 days before `to` by default.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'The last day, today by default; at most 366 days.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}
