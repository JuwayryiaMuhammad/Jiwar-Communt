import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';

const STATUSES = ['open', 'acknowledged'] as const;

export class ControlRoomQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: STATUSES,
    required: false,
    description: '`open`: still to acknowledge. Every event when left out.',
  })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];
}
