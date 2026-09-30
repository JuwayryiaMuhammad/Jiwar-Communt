import { ApiProperty } from '@nestjs/swagger';
import { HouseholdRelation } from '@prisma/client';
import { IsEmail, IsEnum, IsString, Length } from 'class-validator';
import { IdentityDocumentDto } from '../../../core/common/http/identity-document.dto';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';

const RELATION = withParams({ allowed: Object.values(HouseholdRelation) });

/** An adult, invited; the acceptance code goes to this email and nowhere else. */
export class NewInviteDto extends IdentityDocumentDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  @ApiProperty({ type: String })
  @IsPhone()
  phone: string;

  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;

  @ApiProperty({ enum: HouseholdRelation, enumName: 'HouseholdRelation' })
  @IsEnum(HouseholdRelation, RELATION)
  relation: HouseholdRelation;
}

/** A minor: added directly, with no account. */
export class NewMinorDto extends IdentityDocumentDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  @ApiProperty({ enum: HouseholdRelation, enumName: 'HouseholdRelation' })
  @IsEnum(HouseholdRelation, RELATION)
  relation: HouseholdRelation;
}

/** Where the member who came of age receives their own invitation. */
export class MajorityInviteDto {
  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;

  @ApiProperty({ type: String })
  @IsPhone()
  phone: string;
}
