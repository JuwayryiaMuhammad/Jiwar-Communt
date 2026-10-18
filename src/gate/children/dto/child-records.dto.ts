import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';

export class ChildPickupsQueryDto extends PageQueryDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: "One child's exits only.",
  })
  @IsOptional()
  @IsUUID()
  memberId?: string;
}

export class ChildAlertsQueryDto extends PageQueryDto {}
