import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { ExclusiveWith } from '../../../core/common/validation/exclusive-with';

/** A window: checked against the database's clock (ADR 0034). */
export class VisitWindowDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'At least 15 minutes from now, within 30 days.',
  })
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'After `startsAt`, at most four hours later.',
  })
  @Type(() => Date)
  @IsDate()
  endsAt: Date;
}

export class VisitRescheduleDto extends VisitWindowDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `visitChange`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

/**
 * Who lets the technician in: exactly one of an adult who lives in the
 * unit (`accountId`) or an active domestic worker of it (`engagementId`).
 */
export class VisitReceiverDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'An adult account of the unit’s household.',
  })
  @ValidateIf(
    (o: VisitReceiverDto) =>
      o.engagementId === undefined || o.accountId !== undefined,
  )
  @IsUUID()
  accountId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'An active worker engagement of the unit.',
  })
  @IsOptional()
  @IsUUID()
  @ExclusiveWith('accountId')
  engagementId?: string;
}
