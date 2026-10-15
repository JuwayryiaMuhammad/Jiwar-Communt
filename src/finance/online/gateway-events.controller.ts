import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { keysetCursor } from '../../core/common/cursor';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { withParams } from '../../core/common/validation/validation-errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { show } from '../money';

export const GATEWAY_OUTCOMES = [
  'applied',
  'duplicate',
  'failed_attempt',
  'not_final',
  'verification_pending',
  'contradicted',
  'order_mismatch',
  'amount_mismatch',
  'unknown_reference',
] as const;

export class GatewayEventsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, type: String, enum: GATEWAY_OUTCOMES })
  @IsOptional()
  @IsIn(GATEWAY_OUTCOMES, withParams({ allowed: [...GATEWAY_OUTCOMES] }))
  outcome?: (typeof GATEWAY_OUTCOMES)[number];
}

export class GatewayEventView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sessionId: string | null;
  @ApiProperty({ type: String, description: "Paymob's transaction id." })
  gatewayTransactionId: string;
  @ApiProperty({ type: String, description: 'EGP, as Paymob signed it.' })
  amount: string;
  @ApiProperty({ type: Boolean })
  success: boolean;
  @ApiProperty({ type: Boolean })
  pending: boolean;
  @ApiProperty({ type: String, enum: GATEWAY_OUTCOMES })
  outcome: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

const cursor = keysetCursor('createdAt');

/**
 * Paymob's callbacks as the webhook logged them (ADR 0046), newest first:
 * for the manager to follow up a mismatch, a contradiction or a payment
 * Paymob has not confirmed yet. Signed scalars only.
 */
@ApiArea('finance')
@RequirePermissions('finance.gateway')
@Controller('staff/finance/gateway-events')
export class GatewayEventsController {
  constructor(private readonly tenantTx: TenantTx) {}

  @Get()
  @ApiOperation({ summary: "List Paymob's callbacks and what came of them" })
  @ApiOkResponse({ type: ListOf(GatewayEventView) })
  async list(
    @Query() q: GatewayEventsQueryDto,
  ): Promise<ListResponse<GatewayEventView>> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.paymentGatewayEvent.findMany({
        where: {
          AND: [
            q.outcome ? { outcome: q.outcome } : {},
            ...cursor.after(q.cursor),
          ],
        },
        orderBy: cursor.orderBy,
        take: q.limit + 1,
      }),
    );
    return toList(cursor.toPage(rows, q.limit), (e) => ({
      id: e.id,
      sessionId: e.sessionId,
      gatewayTransactionId: e.gatewayTransactionId,
      amount: show(Number(e.amountCents) / 100),
      success: e.success,
      pending: e.pending,
      outcome: e.outcome,
      createdAt: e.createdAt,
    }));
  }
}
