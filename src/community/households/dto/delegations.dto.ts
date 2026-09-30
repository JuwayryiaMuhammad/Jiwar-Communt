import { ApiProperty } from '@nestjs/swagger';
import { DelegationScope } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDate, IsIn, IsUUID } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const SCOPES = Object.values(DelegationScope);

export class CreateDelegationDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: "An adult member's account.",
  })
  @IsUUID()
  delegateAccountId: string;

  @ApiProperty({
    enum: DelegationScope,
    enumName: 'DelegationScope',
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1 }))
  @IsIn(SCOPES, { each: true, ...withParams({ allowed: SCOPES }) })
  scopes: DelegationScope[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'In the future, at most a year away.',
  })
  @Type(() => Date)
  @IsDate()
  expiresAt: Date;
}
