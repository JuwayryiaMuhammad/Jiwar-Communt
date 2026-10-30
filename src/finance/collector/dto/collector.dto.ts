import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MONEY } from '../../money';
import { COLLECTOR_VISIT_STATUSES } from '../collector-visits.service';

/** A collector's visit asked for (ADR 0069): a window, the amount expected. */
export class AskCollectorVisitDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'With an offset; from tomorrow, within 14 days.',
  })
  @ToInstant()
  @IsDate()
  windowStartsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'With an offset; one to four hours after the start.',
  })
  @ToInstant()
  @IsDate()
  windowEndsAt: Date;

  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    description: 'What the resident means to hand over, EGP.',
  })
  @IsOptional()
  @IsString()
  expectedAmount?: string;
}

export class AssignCollectorDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  collectorId: string;
}

export class CollectedDto {
  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description:
      'The cash taken, EGP: at most what the unit owes plus the compound’s margin (400 AMOUNT_TOO_HIGH with `max`).',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;
}

export class FailedVisitDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `collectorVisitFail`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Another window offered: with `offeredEndsAt`, or neither.',
  })
  @IsOptional()
  @ToInstant()
  @IsDate()
  offeredStartsAt?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @ToInstant()
  @IsDate()
  offeredEndsAt?: Date;
}

export class CancelCollectorVisitDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `collectorVisitCancel`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class CollectorVisitQueueDto {
  @ApiPropertyOptional({
    enum: COLLECTOR_VISIT_STATUSES,
    enumName: 'CollectorVisitStatus',
    description: 'The open ones when left out.',
  })
  @IsOptional()
  @IsIn(
    COLLECTOR_VISIT_STATUSES,
    withParams({ allowed: [...COLLECTOR_VISIT_STATUSES] }),
  )
  status?: (typeof COLLECTOR_VISIT_STATUSES)[number];
}

export class CollectorSettingsDto {
  @ApiProperty({
    type: String,
    description:
      'What a collector may take above what a unit owes, EGP: 0 to 1000.',
  })
  @IsString()
  @Matches(/^\d{1,4}(\.\d{1,2})?$/)
  collectorMargin: string;
}
