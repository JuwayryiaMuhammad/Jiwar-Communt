import { ApiProperty } from '@nestjs/swagger';
import { FinanceGatewayMode } from '@prisma/client';

export class GatewayLast4View {
  @ApiProperty({ type: String })
  secretKey: string;
  @ApiProperty({ type: String })
  publicKey: string;
  @ApiProperty({ type: String })
  hmacSecret: string;
  @ApiProperty({ type: String })
  cardIntegrationId: string;
  @ApiProperty({ type: String, nullable: true })
  walletIntegrationId: string | null;
}

/**
 * A compound's online payment account as anyone may see it (ADR 0046):
 * the last four characters of each credential, never more.
 */
export class GatewayView {
  @ApiProperty({ type: Boolean, description: 'Credentials have been set.' })
  configured: boolean;
  @ApiProperty({
    enum: FinanceGatewayMode,
    enumName: 'FinanceGatewayMode',
    nullable: true,
  })
  mode: FinanceGatewayMode | null;
  @ApiProperty({ type: GatewayLast4View, nullable: true })
  last4: GatewayLast4View | null;
  @ApiProperty({ type: Boolean, description: "The manager's switch." })
  onlineEnabled: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      "The platform's switch: true turns online payment off whatever the manager says.",
  })
  platformDisabled: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      'Residents can pay online now: configured, enabled, not disabled by the platform, and the server holds the key.',
  })
  available: boolean;
  @ApiProperty({
    type: String,
    enum: ['manager', 'platform'],
    nullable: true,
    description: 'Who set the credentials last.',
  })
  updatedBy: 'manager' | 'platform' | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt: Date | null;
}
