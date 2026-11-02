import { ApiProperty } from '@nestjs/swagger';
import { ofDateColumn } from '../../schedules/local-dates';
import { PURCHASE_STATUSES, purchaseReference } from '../purchase-rules';
import type { PurchaseRead } from '../purchases.service';

/** A purchase request (ADR 0077), for its requester and its approvers. */
export class PurchaseRequestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'PR-0001.' })
  reference: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, nullable: true })
  description: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  vendorId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  budgetLineId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  stockItemId: string | null;
  @ApiProperty({ type: String, nullable: true })
  quantity: string | null;
  @ApiProperty({ type: String, description: 'EGP.' })
  estimatedAmount: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  neededBy: string | null;
  @ApiProperty({ enum: PURCHASE_STATUSES, enumName: 'PurchaseRequestStatus' })
  status: string;
  @ApiProperty({ type: Boolean, description: 'The caller asked for it.' })
  mine: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.purchaseReject.',
  })
  rejectReason: string | null;
  @ApiProperty({ type: String, nullable: true })
  decisionNote: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The board’s approved major contract it is covered by.',
  })
  approvalRequestId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.purchaseCancel.',
  })
  cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  fulfilledAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  fulfilledReference: string | null;

  static from(p: PurchaseRead): PurchaseRequestView {
    const r = p.request;
    return {
      id: r.id,
      reference: purchaseReference(r.number),
      title: r.title,
      description: r.description,
      vendorId: r.vendorId,
      budgetLineId: r.budgetLineId,
      stockItemId: r.stockItemId,
      quantity: r.quantity === null ? null : r.quantity.toString(),
      estimatedAmount: r.estimatedAmount.toFixed(2),
      neededBy: r.neededBy ? ofDateColumn(r.neededBy) : null,
      status: r.status,
      mine: p.mine,
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
      rejectReason: r.rejectReason,
      decisionNote: r.decisionNote,
      approvalRequestId: r.approvalRequestId,
      cancelledAt: r.cancelledAt,
      cancelReason: r.cancelReason,
      fulfilledAt: r.fulfilledAt,
      fulfilledReference: r.fulfilledReference,
    };
  }
}
