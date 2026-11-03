import { ApiProperty } from '@nestjs/swagger';
import type {
  MaintenanceContract,
  MaintenanceContractPayment,
  TicketVendorDispatch,
  Vendor,
} from '@prisma/client';
import { ofDateColumn } from '../../schedules/local-dates';
import { ticketNumber } from '../../tickets/ticket-rules';
import { VENDOR_CATEGORIES, vendorReference } from '../../vendors/vendor-rules';
import type { OfferRead } from '../vendor-dispatch.service';

const DISPATCH_STATUSES = [
  'offered',
  'accepted',
  'declined',
  'withdrawn',
  'returned',
] as const;

/** An offer of a ticket to a vendor, as dispatch reads it (ADR 0088). */
export class VendorDispatchView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  vendorId: string;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ enum: DISPATCH_STATUSES, enumName: 'VendorDispatchStatus' })
  status: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  offeredById: string;
  @ApiProperty({ type: String, format: 'date-time' })
  offeredAt: Date;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The contractor who took it or turned it down.',
  })
  decidedById: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From the closed list `vendorDispatchDecline`.',
  })
  declineReason: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From the closed list `vendorDispatchWithdraw`.',
  })
  withdrawReason: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Taken back, or given back once taken.',
  })
  endedAt: Date | null;

  static from(d: TicketVendorDispatch): VendorDispatchView {
    return {
      id: d.id,
      ticketId: d.ticketId,
      vendorId: d.vendorId,
      cycle: d.cycle,
      status: d.status,
      note: d.note,
      offeredById: d.offeredById,
      offeredAt: d.offeredAt,
      decidedById: d.decidedById,
      decidedAt: d.decidedAt,
      declineReason: d.declineReason,
      withdrawReason: d.withdrawReason,
      endedAt: d.endedAt,
    };
  }
}

/**
 * An offer as the vendor's contractors see it (ADR 0088): the work — its
 * number, category, priority and place — and dispatch's note; never the
 * unit, a resident or the ticket's own words, which its technician reads
 * once a contractor takes it.
 */
export class ContractorOfferView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: DISPATCH_STATUSES, enumName: 'VendorDispatchStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: String, description: 'MT-000123.' })
  ticketNumber: string;
  @ApiProperty({ type: String })
  categoryKey: string;
  @ApiProperty({ enum: ['normal', 'urgent', 'emergency'] })
  priority: string;
  @ApiProperty({
    enum: ['unit', 'common_area'],
    description:
      'Where the work is: in a unit (shown once taken) or a common area.',
  })
  place: 'unit' | 'common_area';
  @ApiProperty({ type: String, nullable: true })
  commonArea: string | null;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  offeredAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'I took it: it is in my technician list.',
  })
  takenByMe: boolean;

  static from(r: OfferRead, me: string): ContractorOfferView {
    return {
      id: r.dispatch.id,
      status: r.dispatch.status,
      ticketId: r.ticket.id,
      ticketNumber: ticketNumber(r.ticket.number),
      categoryKey: r.categoryKey,
      priority: r.ticket.priority,
      place: r.ticket.unitId ? 'unit' : 'common_area',
      commonArea: r.ticket.unitId ? null : r.ticket.commonArea,
      note: r.dispatch.note,
      offeredAt: r.dispatch.offeredAt,
      takenByMe:
        r.dispatch.status === 'accepted' && r.dispatch.decidedById === me,
    };
  }
}

export class OfferTakenView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Now under `/technician/tickets/{id}`.',
  })
  ticketId: string;
}

/** The contractor's own company, as its app shows it. */
export class ContractorVendorView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'V-0001.' })
  reference: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({
    enum: VENDOR_CATEGORIES,
    enumName: 'VendorCategory',
    isArray: true,
  })
  categories: string[];
  @ApiProperty({
    enum: ['active', 'suspended'],
    description: 'Suspended: no new work, no bid.',
  })
  status: string;

  static from(v: Vendor): ContractorVendorView {
    return {
      id: v.id,
      reference: vendorReference(v.number),
      name: v.name,
      categories: v.categories,
      status: v.status,
    };
  }
}

export class ContractorPaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ type: String, description: 'EGP.' })
  amount: string;
  @ApiProperty({ type: Boolean })
  paid: boolean;
}

/** One of my company's contracts, to bill against (ADR 0088). */
export class ContractorContractView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  kind: string;
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({ type: String, format: 'date' })
  endsOn: string;
  @ApiProperty({ type: [ContractorPaymentView] })
  payments: ContractorPaymentView[];

  static from(
    c: MaintenanceContract & { payments: MaintenanceContractPayment[] },
  ): ContractorContractView {
    return {
      id: c.id,
      code: c.code,
      kind: c.kind,
      startsOn: ofDateColumn(c.startsOn),
      endsOn: ofDateColumn(c.endsOn),
      payments: c.payments.map((p) => ({
        id: p.id,
        dueOn: ofDateColumn(p.dueOn),
        amount: p.amount.toFixed(2),
        paid: p.paidOn !== null,
      })),
    };
  }
}
