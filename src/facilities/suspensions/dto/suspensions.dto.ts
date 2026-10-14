import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';

const BOOLEAN = ['true', 'false'] as const;

export class SuspensionsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description: '`true`: only those in force.',
  })
  @IsOptional()
  @IsIn(BOOLEAN, withParams({ allowed: [...BOOLEAN] }))
  inForce?: 'true' | 'false';
}

export class LiftSuspensionDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `bookingSuspensionLift`.',
  })
  @IsString()
  reasonCode: string;
}
