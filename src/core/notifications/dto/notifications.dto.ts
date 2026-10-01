import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../common/http/list';
import { withParams } from '../../common/validation/validation-errors';

const BOOL = ['true', 'false'] as const;

export class InboxQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, enum: BOOL })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  unread?: (typeof BOOL)[number];
}
