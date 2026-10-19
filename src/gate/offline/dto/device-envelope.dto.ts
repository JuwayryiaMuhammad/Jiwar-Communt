import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  DEVICE_SIGNATURE,
  ENVELOPE_PAYLOAD,
  ENVELOPE_PAYLOAD_MAX,
} from '../device-envelope';

/**
 * What a guard device signs (ADR 0057): the payload's JSON in base64url,
 * and the Ed25519 signature of `jiwar:gate-device:v1\n<payload>` with the
 * device's key. Every payload carries `purpose`, `tenantId`, `deviceId`
 * and `sentAt` (the device's clock, within a day of the server's).
 */
export class DeviceEnvelopeDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  deviceId: string;

  @ApiProperty({
    type: String,
    maxLength: ENVELOPE_PAYLOAD_MAX,
    description: 'The payload’s UTF-8 JSON in base64url, as signed.',
  })
  @IsString()
  @MaxLength(ENVELOPE_PAYLOAD_MAX, withParams({ max: ENVELOPE_PAYLOAD_MAX }))
  @Matches(ENVELOPE_PAYLOAD)
  payload: string;

  @ApiProperty({
    type: String,
    pattern: DEVICE_SIGNATURE.source,
    description: 'The device’s Ed25519 signature, base64url.',
  })
  @IsString()
  @Matches(DEVICE_SIGNATURE)
  signature: string;
}
