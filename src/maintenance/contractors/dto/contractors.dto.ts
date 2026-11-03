import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { IdentityDocumentDto } from '../../../core/common/http/identity-document.dto';
import { PageQueryDto } from '../../../core/common/http/list';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';

const BOOL = ['true', 'false'] as const;

/** A vendor's contractor the manager invites (ADR 0088), as staff are. */
export class NewContractorDto extends IdentityDocumentDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  @ApiProperty({
    type: String,
    description:
      'Local Egyptian format, or international with `+`; stored as E.164.',
  })
  @IsPhone()
  phone: string;

  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;
}

/** Offer a queued ticket to a vendor (ADR 0088). */
export class OfferToVendorDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  vendorId: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: 500,
    description:
      'What the vendor needs to know of the work before taking it; never a person.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 500, withParams({ min: 1, max: 500 }))
  note?: string;
}

export class OffersQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    enum: BOOL,
    description: '`true`: only the offers still waiting for an answer.',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  open?: (typeof BOOL)[number];
}
