import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../common/http/list';
import { IsLocalDate, LOCAL_DATE } from '../common/validation/local-date';
import { withParams } from '../common/validation/validation-errors';
import {
  REPORT_CADENCES,
  REPORT_COMPARISONS,
  REPORT_FORMATS,
  type ReportCadence,
  type ReportComparison,
  type ReportFormat,
} from './report-periods';
import { REPORT_KEYS, type ReportKey } from './report-registry';

/** A report's own grouping: its key's shape; the report says which it offers. */
const GROUPING = /^[a-z][a-z0-9_]{1,39}$/;

export class ReportQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description:
      'The first day, the compound’s; 29 days before `to` when left out.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description:
      'The last day, included; today when left out. At most 366 days.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;

  @ApiPropertyOptional({
    type: String,
    description:
      'One of the report’s groupings (the catalog lists them); its first by default.',
  })
  @IsOptional()
  @IsString()
  @Matches(GROUPING, withParams({ pattern: GROUPING.source }))
  groupBy?: string;

  @ApiPropertyOptional({
    enum: REPORT_COMPARISONS,
    enumName: 'ReportComparison',
    description:
      'The period before (as many days), the same days a year earlier, both, or none (default).',
  })
  @IsOptional()
  @IsIn(REPORT_COMPARISONS, withParams({ allowed: [...REPORT_COMPARISONS] }))
  compare?: ReportComparison;
}

export class ReportExportQueryDto extends ReportQueryDto {
  @ApiProperty({ enum: REPORT_FORMATS, enumName: 'ReportFormat' })
  @IsIn(REPORT_FORMATS, withParams({ allowed: [...REPORT_FORMATS] }))
  format: ReportFormat;
}

export class CreateReportScheduleDto {
  @ApiProperty({ enum: REPORT_KEYS, enumName: 'ReportKey' })
  @IsIn(REPORT_KEYS, withParams({ allowed: [...REPORT_KEYS] }))
  reportKey: ReportKey;

  @ApiProperty({ enum: REPORT_CADENCES, enumName: 'ReportCadence' })
  @IsIn(REPORT_CADENCES, withParams({ allowed: [...REPORT_CADENCES] }))
  cadence: ReportCadence;

  @ApiProperty({ enum: REPORT_FORMATS, enumName: 'ReportFormat' })
  @IsIn(REPORT_FORMATS, withParams({ allowed: [...REPORT_FORMATS] }))
  format: ReportFormat;

  @ApiPropertyOptional({
    enum: REPORT_COMPARISONS,
    enumName: 'ReportComparison',
  })
  @IsOptional()
  @IsIn(REPORT_COMPARISONS, withParams({ allowed: [...REPORT_COMPARISONS] }))
  compare?: ReportComparison;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Matches(GROUPING, withParams({ pattern: GROUPING.source }))
  groupBy?: string;
}

export class UpdateReportScheduleDto {
  @ApiPropertyOptional({ enum: REPORT_FORMATS, enumName: 'ReportFormat' })
  @IsOptional()
  @IsIn(REPORT_FORMATS, withParams({ allowed: [...REPORT_FORMATS] }))
  format?: ReportFormat;

  @ApiPropertyOptional({
    enum: REPORT_COMPARISONS,
    enumName: 'ReportComparison',
  })
  @IsOptional()
  @IsIn(REPORT_COMPARISONS, withParams({ allowed: [...REPORT_COMPARISONS] }))
  compare?: ReportComparison;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Matches(GROUPING, withParams({ pattern: GROUPING.source }))
  groupBy?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'false pauses it.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ReportRunsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  scheduleId?: string;
}
