import { ApiProperty } from '@nestjs/swagger';
import type { TicketCostEntry } from '@prisma/client';
import { COST_KINDS, type CostKind, type CostTotals } from '../cost-rules';
import type { TicketCosts } from '../ticket-costs.service';

/** One of a ticket's costs (ADR 0065): staff only. */
export class TicketCostEntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: COST_KINDS, enumName: 'TicketCostKind' })
  kind: CostKind;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What dispatch recorded; a part’s entry has none.',
  })
  description: string | null;
  @ApiProperty({
    type: String,
    description: 'Three decimals; a part taken back is negative.',
  })
  quantity: string;
  @ApiProperty({ type: String, description: 'EGP.' })
  unitAmount: string;
  @ApiProperty({ type: String, description: 'EGP: quantity × unit amount.' })
  amount: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'A part’s stock item.',
  })
  itemId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  enteredById: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  enteredAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.ticketCostVoid.',
  })
  voidReason: string | null;

  static from(e: TicketCostEntry): TicketCostEntryView {
    return {
      id: e.id,
      kind: e.kind as CostKind,
      description: e.description,
      quantity: e.quantity.toFixed(3),
      unitAmount: e.unitAmount.toFixed(2),
      amount: e.amount.toFixed(2),
      itemId: (e as { itemId?: string | null }).itemId ?? null,
      enteredById: e.enteredById,
      enteredAt: e.enteredAt,
      voidedAt: e.voidedAt,
      voidReason: e.voidReason,
    };
  }
}

class CostTotalsView implements CostTotals {
  @ApiProperty({ type: String, description: 'EGP, voided entries left out.' })
  total: string;
  @ApiProperty({ type: String })
  labour: string;
  @ApiProperty({ type: String })
  contractor: string;
  @ApiProperty({ type: String, description: 'Net of parts taken back.' })
  parts: string;
  @ApiProperty({ type: String })
  other: string;
}

/** A ticket's costs, oldest first, and what they add up to. */
export class TicketCostsView {
  @ApiProperty({ type: [TicketCostEntryView] })
  data: TicketCostEntryView[];
  @ApiProperty({ type: CostTotalsView })
  totals: CostTotalsView;

  static from(c: TicketCosts): TicketCostsView {
    return {
      data: c.entries.map((e) => TicketCostEntryView.from(e)),
      totals: c.totals,
    };
  }
}
