import { ApiProperty } from '@nestjs/swagger';
import { ParcelCarrier, ParcelStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';

const PIECES = { min: 1, max: 20 };
const LABEL_NAME = { min: 1, max: 80 };

/** A parcel logged at the gate (ADR 0035). */
export class ReceiveParcelDto {
  @ApiProperty({ type: String, description: 'The unit the parcel is for.' })
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode: string;

  @ApiProperty({ enum: ParcelCarrier, enumName: 'ParcelCarrier' })
  @IsEnum(ParcelCarrier, withParams({ allowed: Object.values(ParcelCarrier) }))
  carrier: ParcelCarrier;

  @ApiProperty({ type: Number, minimum: PIECES.min, maximum: PIECES.max })
  @IsInt(withParams(PIECES))
  @Min(PIECES.min, withParams(PIECES))
  @Max(PIECES.max, withParams(PIECES))
  pieces: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      "A finalized `parcel_photo` of the caller's; it moves to the parcel.",
  })
  @IsUUID()
  photoFileId: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: LABEL_NAME.max,
    description:
      'The recipient as printed on the label. Only the unit’s residents read it back; the guard and the managers never do.',
  })
  @IsOptional()
  @IsString()
  @Length(LABEL_NAME.min, LABEL_NAME.max, withParams(LABEL_NAME))
  labelName?: string;
}

/** The guard's list: what needs doing unless a status is asked for. */
export class GateParcelsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: ParcelStatus,
    enumName: 'ParcelStatus',
    required: false,
    description: 'Default: held and rejected.',
  })
  @IsOptional()
  @IsEnum(ParcelStatus, withParams({ allowed: Object.values(ParcelStatus) }))
  status?: ParcelStatus;

  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;
}

/** The resident's list: their parcels, newest first. */
export class ResidentParcelsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: ParcelStatus,
    enumName: 'ParcelStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(ParcelStatus, withParams({ allowed: Object.values(ParcelStatus) }))
  status?: ParcelStatus;
}

/** "Not mine": a reason from a closed list, never text. */
export class RejectParcelDto {
  @ApiProperty({
    type: String,
    description:
      'From the closed list `parcelReject`: not_ours, not_expected, other.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

const DELEGATE_NAME_LENGTH = { min: 1, max: 80 };

/** The one person who may collect a parcel in the resident's place. */
export class AuthorizeDelegateDto {
  @ApiProperty({
    type: String,
    minLength: DELEGATE_NAME_LENGTH.min,
    maxLength: DELEGATE_NAME_LENGTH.max,
    description:
      'The delegate’s name, shown to the guard only after a valid delegate code. No phone.',
  })
  @IsString()
  @Length(
    DELEGATE_NAME_LENGTH.min,
    DELEGATE_NAME_LENGTH.max,
    withParams(DELEGATE_NAME_LENGTH),
  )
  name: string;
}

const CODE_LENGTH = { min: 1, max: 32 };
const QR_LENGTH = { min: 1, max: 256 };

/** Exactly one of a typed code or a scanned parcel QR (ADR 0035). */
export class ParcelCodeDto {
  @ApiProperty({
    type: String,
    required: false,
    description:
      'The 6 digits of a parcel’s code or a delegate’s. Or send `qr`.',
  })
  @IsOptional()
  @IsString()
  @Length(CODE_LENGTH.min, CODE_LENGTH.max, withParams(CODE_LENGTH))
  code?: string;

  @ApiProperty({
    type: String,
    required: false,
    example: 'JWP1.q3Jz…',
    description:
      'A scanned parcel QR (`JWP1.<token>`). Anything else answers like an unknown code.',
  })
  @IsOptional()
  @IsString()
  @Length(QR_LENGTH.min, QR_LENGTH.max, withParams(QR_LENGTH))
  qr?: string;
}

/**
 * Exactly one of `code`, `qr` or `residentQr` (the service says which is
 * missing or extra), and an optional photo of the hand-over.
 */
export class HandOverParcelDto extends ParcelCodeDto {
  @ApiProperty({
    type: String,
    required: false,
    example: 'JWR2.…',
    description:
      'The rotating entry QR of an eligible occupant of the parcel’s unit (ADR 0031). It records who received the parcel on the parcel alone; no gate entry is written.',
  })
  @IsOptional()
  @IsString()
  @Length(QR_LENGTH.min, QR_LENGTH.max, withParams(QR_LENGTH))
  residentQr?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      "A finalized `parcel_photo` of the caller's; it moves to the parcel.",
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}
