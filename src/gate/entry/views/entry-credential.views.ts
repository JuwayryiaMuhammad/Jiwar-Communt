import { ApiProperty } from '@nestjs/swagger';
import type {
  CredentialRecord,
  IssuedCredential,
} from '../entry-credentials.service';

/** Shown once, no-store: the secret is derived and never stored (ADR 0031). */
export class IssuedEntryCredentialView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description:
      'base64url of 32 bytes. Keep it in the phone\'s secure storage; the server cannot show it again. The QR is `JWR2.<id>.<step>.<mac>`: step = floor(unix seconds / 30), mac = base64url of the first 16 bytes of HMAC-SHA256 keyed with the secret\'s decoded bytes over "<id>.<step>".',
  })
  secret: string;
  @ApiProperty({ type: Number, example: 30 })
  stepSeconds: number;

  static from(c: IssuedCredential): IssuedEntryCredentialView {
    return { id: c.id, secret: c.secret, stepSeconds: c.stepSeconds };
  }
}

export class EntryCredentialView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  deviceName: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(c: CredentialRecord): EntryCredentialView {
    return { id: c.id, deviceName: c.deviceName, createdAt: c.createdAt };
  }
}
