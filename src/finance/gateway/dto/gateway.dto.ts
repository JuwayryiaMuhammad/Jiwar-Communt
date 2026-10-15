import { ApiProperty } from '@nestjs/swagger';
import { FinanceGatewayMode } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

/** Paymob Egypt keys: `egy_sk_test_…`, `egy_pk_live_…`. */
const SECRET_KEY = /^egy_sk_(test|live)_[A-Za-z0-9_-]{8,240}$/;
const PUBLIC_KEY = /^egy_pk_(test|live)_[A-Za-z0-9_-]{8,240}$/;
const HMAC_SECRET = /^[A-Za-z0-9_-]{16,256}$/;
const INTEGRATION = { min: 1, max: 2_147_483_647 } as const;

/**
 * All of a compound's Paymob credentials, replaced together (ADR 0046).
 * Never logged and never audited by value.
 */
export class SetGatewayDto {
  @ApiProperty({ enum: FinanceGatewayMode, enumName: 'FinanceGatewayMode' })
  @IsEnum(FinanceGatewayMode)
  mode: FinanceGatewayMode;

  @ApiProperty({
    type: String,
    pattern: SECRET_KEY.source,
    description:
      'The secret key; `egy_sk_live_…` in live mode, `egy_sk_test_…` in sandbox.',
  })
  @IsString()
  @Matches(SECRET_KEY)
  secretKey: string;

  @ApiProperty({ type: String, pattern: PUBLIC_KEY.source })
  @IsString()
  @Matches(PUBLIC_KEY)
  publicKey: string;

  @ApiProperty({ type: String, pattern: HMAC_SECRET.source })
  @IsString()
  @Matches(HMAC_SECRET)
  hmacSecret: string;

  @ApiProperty({
    type: Number,
    minimum: INTEGRATION.min,
    maximum: INTEGRATION.max,
  })
  @IsInt(withParams(INTEGRATION))
  @Min(INTEGRATION.min, withParams(INTEGRATION))
  @Max(INTEGRATION.max, withParams(INTEGRATION))
  cardIntegrationId: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    minimum: INTEGRATION.min,
    maximum: INTEGRATION.max,
    description: 'The mobile wallet integration; omitted or null: card only.',
  })
  @IsOptional()
  @IsInt(withParams(INTEGRATION))
  @Min(INTEGRATION.min, withParams(INTEGRATION))
  @Max(INTEGRATION.max, withParams(INTEGRATION))
  walletIntegrationId?: number | null;
}

export class SetOnlinePaymentDto {
  @ApiProperty({ type: Boolean })
  @IsBoolean()
  onlineEnabled: boolean;
}

export class SetPlatformDisabledDto {
  @ApiProperty({
    type: Boolean,
    description:
      'True switches online payment off for the compound, whatever its manager says.',
  })
  @IsBoolean()
  platformDisabled: boolean;
}
