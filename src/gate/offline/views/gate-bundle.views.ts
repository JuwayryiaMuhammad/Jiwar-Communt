import { ApiProperty } from '@nestjs/swagger';
import type { BundleKeys, IssuedBundle } from '../gate-bundles.service';

/** A gate bundle, signed (ADR 0057). */
export class GateBundleResponse {
  @ApiProperty({
    type: Number,
    description:
      'The signing key’s version: the device verifies with that key from `GET /gate/offline/keys`.',
  })
  keyVersion: number;
  @ApiProperty({
    type: String,
    description:
      'The bundle’s UTF-8 JSON in base64url, exactly as signed (ADR 0057 lists its fields).',
  })
  body: string;
  @ApiProperty({
    type: String,
    description: 'Ed25519 over `jiwar:gate-bundle:v1\\n<body>`, base64url.',
  })
  signature: string;
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime: Date;

  static from(v: IssuedBundle): GateBundleResponse {
    return { ...v };
  }
}

export class BundleKeyView {
  @ApiProperty({ type: Number })
  version: number;
  @ApiProperty({
    type: String,
    description: 'The raw 32-byte Ed25519 public key, base64url.',
  })
  publicKey: string;
  @ApiProperty({ type: Boolean, description: 'Signs new bundles.' })
  current: boolean;
}

/** The keys gate bundles are signed with (ADR 0057). */
export class BundleKeysResponse {
  @ApiProperty({ type: [BundleKeyView] })
  keys: BundleKeyView[];
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime: Date;

  static from(v: BundleKeys): BundleKeysResponse {
    return { keys: v.keys, serverTime: v.serverTime };
  }
}
