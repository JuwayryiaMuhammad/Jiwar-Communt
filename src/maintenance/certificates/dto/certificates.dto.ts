import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate, LOCAL_DATE } from '../../schedules/local-dates';
import {
  CERTIFICATE_STATES,
  STAFF_CERTIFICATE_KINDS,
} from '../certificate-rules';

const day = (description?: string) =>
  ({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    ...(description ? { description } : {}),
  }) as const;

export class CreateStaffCertificateDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'Its holder: an active staff member (CERTIFICATE_HOLDER_NOT_ELIGIBLE otherwise).',
  })
  @IsUUID()
  accountId: string;

  @ApiProperty({
    enum: STAFF_CERTIFICATE_KINDS,
    enumName: 'StaffCertificateKind',
  })
  @IsIn(STAFF_CERTIFICATE_KINDS)
  kind: (typeof STAFF_CERTIFICATE_KINDS)[number];

  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120, withParams({ min: 1, max: 120 }))
  title: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120, withParams({ min: 1, max: 120 }))
  issuer?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 60,
    description: 'Its number, as the issuer gave it.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60, withParams({ min: 1, max: 60 }))
  reference?: string;

  @ApiPropertyOptional(day())
  @IsOptional()
  @IsString()
  @IsLocalDate()
  issuedOn?: string;

  @ApiProperty(
    day(
      'Its last day in force; after `issuedOn`. Its holder and the field team are told 30 days ahead and on the day; it blocks nothing.',
    ),
  )
  @IsString()
  @IsLocalDate()
  expiresOn: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The paper: one of my own finalized `staff_certificate` files (FILE_NOT_AVAILABLE otherwise).',
  })
  @IsOptional()
  @IsUUID()
  fileId?: string;
}

export class UpdateStaffCertificateDto {
  @ApiPropertyOptional({
    enum: STAFF_CERTIFICATE_KINDS,
    enumName: 'StaffCertificateKind',
  })
  @IsOptional()
  @IsIn(STAFF_CERTIFICATE_KINDS)
  kind?: (typeof STAFF_CERTIFICATE_KINDS)[number];

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120, withParams({ min: 1, max: 120 }))
  title?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 120,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 120, withParams({ min: 1, max: 120 }))
  issuer?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 60,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 60, withParams({ min: 1, max: 60 }))
  reference?: string | null;

  @ApiPropertyOptional({ ...day(), nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @IsLocalDate()
  issuedOn?: string | null;

  @ApiPropertyOptional(
    day('A renewal: a new expiry, whose notices start again.'),
  )
  @IsOptional()
  @IsString()
  @IsLocalDate()
  expiresOn?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'A new paper (the old one goes), or null to remove the one filed.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  fileId?: string | null;
}

export class StaffCertificatesQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({
    enum: CERTIFICATE_STATES,
    enumName: 'StaffCertificateState',
    description: 'On the compound’s today.',
  })
  @IsOptional()
  @IsIn(CERTIFICATE_STATES)
  state?: (typeof CERTIFICATE_STATES)[number];

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: '`true`: the removed ones instead of the live.',
  })
  @IsOptional()
  @IsIn(['true', 'false'], withParams({ allowed: ['true', 'false'] }))
  removed?: 'true' | 'false';
}
