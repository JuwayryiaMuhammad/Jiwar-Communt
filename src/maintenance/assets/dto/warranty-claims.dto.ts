import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
import { MONEY } from '../asset-rules';
import {
  CLAIM_DESCRIPTION,
  CLAIM_REFERENCE,
  WARRANTY_CLAIM_STATUSES,
  type WarrantyClaimStatus,
} from '../warranty-claims.service';

/** A claim under an asset's warranty (ADR 0076). */
export class CreateWarrantyClaimDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  assetId: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'The ticket whose fault it is: one of the asset’s.',
  })
  @IsOptional()
  @IsUUID()
  ticketId?: string;

  @ApiProperty({
    type: String,
    minLength: CLAIM_DESCRIPTION.min,
    maxLength: CLAIM_DESCRIPTION.max,
    description: 'What failed: staff’s words, plain data.',
  })
  @IsString()
  @Length(
    CLAIM_DESCRIPTION.min,
    CLAIM_DESCRIPTION.max,
    withParams(CLAIM_DESCRIPTION),
  )
  description: string;
}

export class WarrantyClaimReferenceDto {
  @ApiProperty({
    type: String,
    minLength: CLAIM_REFERENCE.min,
    maxLength: CLAIM_REFERENCE.max,
    description: 'The warrantor’s own reference for the claim.',
  })
  @IsString()
  @Length(CLAIM_REFERENCE.min, CLAIM_REFERENCE.max, withParams(CLAIM_REFERENCE))
  reference: string;
}

export class AcceptWarrantyClaimDto {
  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    description: 'What the warrantor paid or covered, EGP.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  recoveredAmount?: string;
}

export class DecideWarrantyClaimDto {
  @ApiProperty({
    type: String,
    description: `\`warrantyClaimReject\` (${REASON_CODES.warrantyClaimReject.join(', ')}) to reject; \`warrantyClaimWithdraw\` (${REASON_CODES.warrantyClaimWithdraw.join(', ')}) to withdraw.`,
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class WarrantyClaimsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ enum: WARRANTY_CLAIM_STATUSES })
  @IsOptional()
  @IsIn(
    WARRANTY_CLAIM_STATUSES,
    withParams({ allowed: [...WARRANTY_CLAIM_STATUSES] }),
  )
  status?: WarrantyClaimStatus;
}
