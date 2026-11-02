import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { REASON_CODES } from '../../../core/common/reasons';
import { ReasonDto } from '../../../core/common/http/reason.dto';
import { withParams } from '../../../core/common/validation/validation-errors';

export class ClearReviewFlagDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `reviewClear`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class TransferOwnershipDto extends ReasonDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active resident account: the new owner.',
  })
  @IsUUID()
  toAccountId: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Default true: the new owner lives there.',
  })
  @IsOptional()
  @IsBoolean()
  resides?: boolean;

  @ApiProperty({
    type: String,
    required: false,
    enum: REASON_CODES.transferDuesException,
    description:
      'Only when the unit owes the compound (ADR 0083): why the transfer goes ahead anyway, with a fresh step-up (POST /me/step-up). Ignored when nothing is owed.',
  })
  @IsOptional()
  @IsString()
  duesExceptionCode?: string;
}

/** Either some members, or `all: true` — exactly one. */
export class MembersReviewedDto {
  @ApiProperty({
    type: [String],
    required: false,
    description: 'Member ids; or send `all: true` instead.',
  })
  @ValidateIf(
    (o: MembersReviewedDto) => o.all === undefined || o.memberIds !== undefined,
  )
  @IsArray()
  @ArrayMaxSize(100, withParams({ max: 100 }))
  @IsUUID('all', { each: true })
  memberIds?: string[];

  @ApiProperty({ type: Boolean, enum: [true], required: false })
  @IsOptional()
  @IsIn([true])
  @ValidateBy({
    name: 'exclusiveWithMemberIds',
    validator: {
      validate: (_: unknown, args) =>
        (args?.object as MembersReviewedDto).memberIds === undefined,
      defaultMessage: () => 'send either memberIds or all, not both',
    },
  })
  all?: true;
}
