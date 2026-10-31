import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const TOKEN = { min: 16, max: 128 };

/** ADR 0070: one of the unit's household, by their member id. */
export class InviteCompanionDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A household member of the booking’s unit with an account (PERSON_NOT_OF_UNIT).',
  })
  @IsUUID()
  memberId: string;
}

/** A share link's token, as the link carries it. */
export class BookingInviteDto {
  @ApiProperty({ type: String, minLength: TOKEN.min, maxLength: TOKEN.max })
  @IsString()
  @Length(TOKEN.min, TOKEN.max, withParams(TOKEN))
  token: string;
}

export class RemoveCompanionDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `companionRemove`.',
  })
  @IsString()
  reasonCode: string;
}
