import { ApiProperty } from '@nestjs/swagger';
import { AccountRefView, accountRef } from '../../../core/common/http/personal';
import type { WagePaymentRead } from '../worker-wages.service';

export class WageView {
  @ApiProperty({ type: String, nullable: true, example: '3200.00' })
  monthlyWage: string | null;
}

/** One month's payment, as recorded (ADR 0037); no gateway, no reference. */
export class WagePaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  engagementId: string;
  @ApiProperty({ type: String, example: '2026-09' })
  period: string;
  @ApiProperty({ type: String, example: '3200.00' })
  amount: string;
  @ApiProperty({ type: String, format: 'date-time' })
  paidAt: Date;
  @ApiProperty({ type: AccountRefView })
  paidBy: AccountRefView;

  static from(p: WagePaymentRead): WagePaymentView {
    return {
      id: p.id,
      engagementId: p.engagementId,
      period: p.period,
      amount: p.amount,
      paidAt: p.paidAt,
      paidBy: accountRef(p.paidBy),
    };
  }
}
