import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { DEVICE_PUBLIC_KEY, DEVICE_SIGNATURE } from '../device-envelope';
import { DEVICE_LABEL_MAX } from '../gate-devices.service';

/**
 * A guard enrols the device it holds (ADR 0057). `proof` is the Ed25519
 * signature, with the key it registers, of
 * `jiwar:gate-device-enroll:v1\n<tenantId>\n<id>\n<publicKey>`.
 */
export class EnrolDeviceDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The device’s own UUIDv7, kept with its key: the same id and key again answer the same.',
  })
  @IsUUID()
  id: string;

  @ApiProperty({
    type: String,
    pattern: DEVICE_PUBLIC_KEY.source,
    description:
      'The raw 32 bytes of the Ed25519 public key, base64url without padding.',
  })
  @IsString()
  @Matches(DEVICE_PUBLIC_KEY)
  publicKey: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: DEVICE_LABEL_MAX,
    description:
      'What the management sees it as ("Gate 1 phone"); never in the audit.',
  })
  @IsOptional()
  @IsString()
  @Length(1, DEVICE_LABEL_MAX, withParams({ min: 1, max: DEVICE_LABEL_MAX }))
  label?: string;

  @ApiProperty({
    type: String,
    pattern: DEVICE_SIGNATURE.source,
    description: 'The enrolment message signed with the key (base64url).',
  })
  @IsString()
  @Matches(DEVICE_SIGNATURE)
  proof: string;
}

export class RevokeDeviceDto {
  @ApiProperty({
    enum: [...REASON_CODES.gateDeviceRevoke],
    description: 'Why, from the closed list `gateDeviceRevoke`.',
  })
  @IsString()
  reasonCode: string;
}

const FILTERS = ['active', 'revoked', 'all'] as const;

export class GateDevicesQueryDto extends PageQueryDto {
  @ApiProperty({ enum: FILTERS, required: false, default: 'all' })
  @IsOptional()
  @IsIn(FILTERS, withParams({ allowed: [...FILTERS] }))
  status?: (typeof FILTERS)[number];
}
