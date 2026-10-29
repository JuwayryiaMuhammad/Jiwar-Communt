import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';
import { CONTRACT_KINDS } from '../contracts.service';

const DATE = withParams({ format: 'YYYY-MM-DD' });

/** A contract the management holds a copy of (ADR 0062). */
export class NewContractDto {
  @ApiProperty({ enum: CONTRACT_KINDS })
  @IsIn([...CONTRACT_KINDS], withParams({ allowed: [...CONTRACT_KINDS] }))
  kind: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: 10,
    description:
      'The occupancies it binds: a lease’s active tenants, an ownership contract’s active owners (CONTRACT_PARTY_INVALID).',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1 }))
  @ArrayMaxSize(10, withParams({ max: 10 }))
  @IsUUID('all', { each: true })
  partyOccupancyIds: string[];

  @ApiProperty({ type: String, format: 'date' })
  @IsLocalDate(DATE)
  signedOn: string;

  @ApiProperty({ type: String, format: 'date' })
  @IsLocalDate(DATE)
  startsOn: string;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'A lease’s last day; required for a lease.',
  })
  @IsOptional()
  @IsLocalDate(DATE)
  endsOn?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: 0,
    maximum: 365,
    description:
      'A lease’s notice: days before its end to renew or announce leaving.',
  })
  @IsOptional()
  @IsInt(withParams({ min: 0, max: 365 }))
  @Min(0, withParams({ min: 0, max: 365 }))
  @Max(365, withParams({ min: 0, max: 365 }))
  noticeDays?: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A finalized `contract` file of the caller’s.',
  })
  @IsUUID()
  fileId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The live lease this one renews.',
  })
  @IsOptional()
  @IsUUID()
  renewsId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The open renewal request it answers (closed as renewed).',
  })
  @IsOptional()
  @IsUUID()
  renewalRequestId?: string;
}
