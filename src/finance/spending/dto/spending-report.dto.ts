import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { SPENDING_REPORT_ITEMS } from '../spending-reports.service';

const SUMMARY = { min: 1, max: 2000 } as const;
const TEXT = { min: 1, max: 500 } as const;

/** An improvement the fees paid for, in the staff's words (ADR 0069). */
export class SpendingReportItemDto {
  @ApiProperty({ type: String, minLength: TEXT.min, maxLength: TEXT.max })
  @IsString()
  @Length(TEXT.min, TEXT.max, withParams(TEXT))
  textEn: string;

  @ApiProperty({ type: String, minLength: TEXT.min, maxLength: TEXT.max })
  @IsString()
  @Length(TEXT.min, TEXT.max, withParams(TEXT))
  textAr: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The board’s published decision it carried out.',
  })
  @IsOptional()
  @IsUUID()
  decisionPublicationId?: string;
}

/** A spending report, published in one act (ADR 0069). */
export class PublishSpendingReportDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'An active budget; the fiscal year under way’s when left out.',
  })
  @IsOptional()
  @IsUUID()
  budgetId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'The latest report of a budget this one supersedes: of its budget, which `budgetId` may only repeat. Residents then read only the new one.',
  })
  @IsOptional()
  @IsUUID()
  supersedesId?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: SUMMARY.min,
    maxLength: SUMMARY.max,
    description: 'With `summaryAr`, or neither.',
  })
  @IsOptional()
  @IsString()
  @Length(SUMMARY.min, SUMMARY.max, withParams(SUMMARY))
  summaryEn?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: SUMMARY.min,
    maxLength: SUMMARY.max,
  })
  @IsOptional()
  @IsString()
  @Length(SUMMARY.min, SUMMARY.max, withParams(SUMMARY))
  summaryAr?: string;

  @ApiProperty({
    type: [SpendingReportItemDto],
    required: false,
    maxItems: SPENDING_REPORT_ITEMS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    SPENDING_REPORT_ITEMS,
    withParams({ max: SPENDING_REPORT_ITEMS }),
  )
  @ValidateNested({ each: true })
  @Type(() => SpendingReportItemDto)
  items?: SpendingReportItemDto[];
}
