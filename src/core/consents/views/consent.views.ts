import { ApiProperty } from '@nestjs/swagger';
import { CONSENT_CODES, type ConsentCode } from '../consent-catalog';
import type { ConsentState } from '../consents.service';

export class ConsentView {
  @ApiProperty({ enum: [...CONSENT_CODES], enumName: 'ConsentCode' })
  code: ConsentCode;
  @ApiProperty({
    type: Number,
    description: 'The current version of the text; a grant answers it.',
  })
  version: number;
  @ApiProperty({
    type: Boolean,
    description: 'Granted at the current version.',
  })
  granted: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  grantedAt: Date | null;

  static from(s: ConsentState): ConsentView {
    return {
      code: s.code,
      version: s.version,
      granted: s.granted,
      grantedAt: s.grantedAt,
    };
  }
}
