import { ApiProperty } from '@nestjs/swagger';
import type { MaintenanceContractPayment } from '@prisma/client';
import { ofDateColumn } from '../../schedules/local-dates';
import { CONTRACT_KINDS, CONTRACT_STATUSES } from '../contract-rules';
import type { ContractRead, DuePayment } from '../contracts.service';

/** A maintenance contract, for who keeps the register (ADR 0065). */
export class MaintenanceContractView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ enum: CONTRACT_KINDS, enumName: 'MaintenanceContractKind' })
  kind: string;
  @ApiProperty({
    enum: CONTRACT_STATUSES,
    enumName: 'MaintenanceContractStatus',
    description: 'From its dates on the compound’s today.',
  })
  status: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Its vendor (ADR 0077).',
  })
  vendorId: string;
  @ApiProperty({
    type: String,
    description: 'The vendor’s name when the contract was written.',
  })
  vendorName: string;
  @ApiProperty({ type: String, nullable: true })
  vendorPhone: string | null;
  @ApiProperty({ type: String, nullable: true })
  scope: string | null;
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({ type: String, format: 'date' })
  endsOn: string;
  @ApiProperty({ type: String, nullable: true, description: 'EGP a year.' })
  annualValue: string | null;
  @ApiProperty({ type: Number })
  noticeDays: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  terminatedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.contractTerminate.',
  })
  terminationReason: string | null;
  @ApiProperty({ type: [String], format: 'uuid' })
  assetIds: string[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP a day the vendor owes for being late.',
  })
  latePenaltyPerDay: string | null;
  @ApiProperty({ type: String, nullable: true })
  penaltyCap: string | null;
  @ApiProperty({ type: Number, nullable: true })
  responseHours: number | null;
  @ApiProperty({ type: String, nullable: true })
  penaltyTerms: string | null;
  @ApiProperty({ type: Boolean })
  autoRenews: boolean;
  @ApiProperty({ type: Number, nullable: true })
  renewalTermMonths: number | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The contract it renews.',
  })
  renewsId: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The contract that renews it.',
  })
  renewalId: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The board’s approved major contract it is signed under.',
  })
  approvalRequestId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  budgetLineId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '5.00',
    description: 'Held back of each payout, a percentage (ADR 0089).',
  })
  retentionPct: string | null;

  static from(r: ContractRead): MaintenanceContractView {
    const c = r.contract;
    return {
      id: c.id,
      code: c.code,
      kind: c.kind,
      status: r.status,
      vendorId: c.vendorId,
      vendorName: c.vendorName,
      vendorPhone: c.vendorPhone,
      scope: c.scope,
      startsOn: ofDateColumn(c.startsOn),
      endsOn: ofDateColumn(c.endsOn),
      annualValue: c.annualValue === null ? null : c.annualValue.toFixed(2),
      noticeDays: c.noticeDays,
      terminatedAt: c.terminatedAt,
      terminationReason: c.terminationReason,
      assetIds: r.assetIds,
      latePenaltyPerDay: c.latePenaltyPerDay?.toFixed(2) ?? null,
      penaltyCap: c.penaltyCap?.toFixed(2) ?? null,
      responseHours: c.responseHours,
      penaltyTerms: c.penaltyTerms,
      autoRenews: c.autoRenews,
      renewalTermMonths: c.renewalTermMonths,
      renewsId: c.renewsId,
      renewalId: r.renewalId,
      approvalRequestId: c.approvalRequestId,
      budgetLineId: c.budgetLineId,
      retentionPct: c.retentionPct?.toFixed(2) ?? null,
    };
  }
}

/** A contract that covers an asset, as anyone reading the register sees it: no money. */
export class CoveringContractView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ enum: CONTRACT_KINDS, enumName: 'MaintenanceContractKind' })
  kind: string;
  @ApiProperty({ type: String })
  vendorName: string;
  @ApiProperty({ type: String, nullable: true })
  vendorPhone: string | null;
  @ApiProperty({ type: String, format: 'date' })
  endsOn: string;

  static from(r: ContractRead): CoveringContractView {
    const c = r.contract;
    return {
      id: c.id,
      code: c.code,
      kind: c.kind,
      vendorName: c.vendorName,
      vendorPhone: c.vendorPhone,
      endsOn: ofDateColumn(c.endsOn),
    };
  }
}

/** A payment of a contract's schedule (ADR 0077). */
export class ContractPaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  contractId: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ type: String, description: 'EGP.' })
  amount: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  paidOn: string | null;
  @ApiProperty({ type: String, nullable: true })
  paidReference: string | null;

  static from(p: MaintenanceContractPayment): ContractPaymentView {
    return {
      id: p.id,
      contractId: p.contractId,
      dueOn: ofDateColumn(p.dueOn),
      amount: p.amount.toFixed(2),
      note: p.note,
      paidOn: p.paidOn ? ofDateColumn(p.paidOn) : null,
      paidReference: p.paidReference,
    };
  }
}

/** An unpaid payment due in a window, with its contract and vendor. */
export class DueContractPaymentView extends ContractPaymentView {
  @ApiProperty({ type: String })
  contractCode: string;
  @ApiProperty({ type: String, format: 'uuid' })
  vendorId: string;
  @ApiProperty({ type: String })
  vendorName: string;

  static ofDue(d: DuePayment): DueContractPaymentView {
    return {
      ...ContractPaymentView.from(d.payment),
      contractCode: d.contractCode,
      vendorId: d.vendorId,
      vendorName: d.vendorName,
    };
  }
}
