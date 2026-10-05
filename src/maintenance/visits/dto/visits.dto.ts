import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString } from 'class-validator';

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
