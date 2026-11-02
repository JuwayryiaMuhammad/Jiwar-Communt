import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ReasonDto } from '../../../core/common/http/reason.dto';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { TRANSFER_STATUSES, type TransferStatus } from '../transfer-rules';

/**
 * A transfer request (ADR 0083): the buyer, whether they will live there,
 * and the household's end (`householdEnd`, ADR 0021) with the words the
 * leaving occupants are told.
 */
export class RequestOwnershipTransferDto extends ReasonDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active resident account: the new owner.',
  })
  @IsUUID()
  toAccountId: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Default true: the new owner lives there.',
  })
  @IsOptional()
  @IsBoolean()
  resides?: boolean;
}

export class ApproveOwnershipTransferDto {
  @ApiPropertyOptional({
    type: String,
    enum: REASON_CODES.transferDuesException,
    description:
      'Only when the unit owes the compound: why the transfer goes ahead anyway, with a fresh step-up (POST /me/step-up). Ignored when nothing is owed.',
  })
  @IsOptional()
  @IsString()
  duesExceptionCode?: string;
}

export class CancelOwnershipTransferDto {
  @ApiProperty({
    type: String,
    description: `\`ownershipTransferCancel\`: ${REASON_CODES.ownershipTransferCancel.join(', ')}.`,
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class OwnershipTransfersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: TRANSFER_STATUSES })
  @IsOptional()
  @IsIn(TRANSFER_STATUSES, withParams({ allowed: [...TRANSFER_STATUSES] }))
  status?: TransferStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}
