import { ApiProperty } from '@nestjs/swagger';
import {
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../common/http/list';
import { withParams } from '../../common/validation/validation-errors';

class TimeWindowDto extends PageQueryDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'Inclusive.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'Exclusive.',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class AuditQueryDto extends TimeWindowDto {
  @ApiProperty({
    type: String,
    required: false,
    description: 'An action from the audit catalog, e.g. `unit.created`.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  action?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  targetType?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  targetId?: string;
}

export class PlatformAuditQueryDto extends AuditQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  targetTenantId?: string;
}

export class SecurityEventsQueryDto extends TimeWindowDto {
  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  event?: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'The identifier HMAC (64 hex).',
  })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  identifierHash?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  platformAdminId?: string;
}

/** Query strings → the query services' dates. */
export function window(q: { from?: string; to?: string }) {
  return {
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
  };
}
