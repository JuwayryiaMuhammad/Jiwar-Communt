import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { SIGNATURE_ROLES } from '../incident-signature-content';

export class SignIncidentDto {
  @ApiProperty({
    enum: SIGNATURE_ROLES,
    enumName: 'IncidentSignatureRole',
    description:
      '`author`: who reported it (INCIDENT_SIGNER_NOT_ELIGIBLE otherwise). `reviewer`: a keeper who did not.',
  })
  @IsIn(SIGNATURE_ROLES, withParams({ allowed: [...SIGNATURE_ROLES] }))
  role: (typeof SIGNATURE_ROLES)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A finalized `incident_signature` upload of the caller’s: a PNG of the drawn signature, 256 KB at most.',
  })
  @IsUUID()
  fileId: string;
}
