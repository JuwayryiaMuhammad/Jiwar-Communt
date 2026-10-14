import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsString } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';

export class CreateClosureDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'After the start (ENDS_BEFORE_START), at most 366 days after it (CLOSURE_TOO_LONG), and not already past (CLOSURE_ENDED).',
  })
  @Type(() => Date)
  @IsDate()
  endsAt: Date;

  @ApiProperty({
    type: String,
    description: 'From the closed list `facilityClosure`.',
  })
  @IsString()
  reasonCode: string;
}

export class LiftClosureDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `facilityClosureLift`.',
  })
  @IsString()
  reasonCode: string;
}

export class ClosuresQueryDto extends PageQueryDto {}
