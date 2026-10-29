import { ApiProperty } from '@nestjs/swagger';
import { ofDateColumn } from '../../schedules/local-dates';
import { CONTRACT_KINDS, CONTRACT_STATUSES } from '../contract-rules';
import type { ContractRead } from '../contracts.service';

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
  @ApiProperty({ type: String })
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

  static from(r: ContractRead): MaintenanceContractView {
    const c = r.contract;
    return {
      id: c.id,
      code: c.code,
      kind: c.kind,
      status: r.status,
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
