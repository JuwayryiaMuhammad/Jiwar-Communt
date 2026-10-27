import { ApiProperty } from '@nestjs/swagger';
import { HouseholdRelation } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { IdentityDocumentDto } from '../../../core/common/http/identity-document.dto';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  KINSHIP_DOCUMENT_KINDS,
  KINSHIP_DOCUMENT_LIMIT,
  type KinshipDocumentKind,
} from '../kinship-documents';

const RELATION = withParams({ allowed: Object.values(HouseholdRelation) });

/** A proof of kinship: a finalized file of the caller's, and what it is. */
export class KinshipDocumentDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  fileId: string;

  @ApiProperty({ enum: KINSHIP_DOCUMENT_KINDS })
  @IsIn(
    [...KINSHIP_DOCUMENT_KINDS],
    withParams({ allowed: [...KINSHIP_DOCUMENT_KINDS] }),
  )
  kind: KinshipDocumentKind;
}

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

  @ApiProperty({
    type: [KinshipDocumentDto],
    required: false,
    maxItems: KINSHIP_DOCUMENT_LIMIT,
    description:
      'Proof of the relation (ADR 0062): finalized `kinship_proof` files of the caller. The compound may refuse them (`off`) or need one (`required`, KINSHIP_PROOF_REQUIRED).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    KINSHIP_DOCUMENT_LIMIT,
    withParams({ min: 0, max: KINSHIP_DOCUMENT_LIMIT }),
  )
  @ValidateNested({ each: true })
  @Type(() => KinshipDocumentDto)
  kinshipDocuments?: KinshipDocumentDto[];
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
