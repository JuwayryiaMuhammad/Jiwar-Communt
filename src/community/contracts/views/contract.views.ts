import { ApiProperty } from '@nestjs/swagger';
import type { PresignedRead } from '../../../core/files/object-storage';
import {
  CONTRACT_KINDS,
  type ContractRead,
  type EndOptions,
  type RenewalRead,
} from '../contracts.service';

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** A lease or an ownership contract (ADR 0062). */
export class ContractView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: '`CT-` and the number.' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ enum: CONTRACT_KINDS })
  kind: string;
  @ApiProperty({ type: String, format: 'date' })
  signedOn: string;
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  endsOn: string | null;
  @ApiProperty({ type: Number, nullable: true })
  noticeDays: number | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'The last day to renew or announce leaving.',
  })
  noticeBy: string | null;
  @ApiProperty({
    enum: ['live', 'renewed', 'voided'],
    description: 'Whether it has ended is its `endsOn`.',
  })
  status: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  renewsId: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Whether its scan is still kept.',
  })
  hasFile: boolean;
  @ApiProperty({ type: [String], format: 'uuid' })
  partyOccupancyIds: string[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(c: ContractRead): ContractView {
    return {
      id: c.id,
      reference: `CT-${String(c.number).padStart(6, '0')}`,
      unitId: c.unitId,
      kind: c.kind,
      signedOn: day(c.signedOn)!,
      startsOn: day(c.startsOn)!,
      endsOn: day(c.endsOn),
      noticeDays: c.noticeDays,
      noticeBy: day(c.noticeBy),
      status: c.status,
      renewsId: c.renewsId,
      hasFile: c.hasFile,
      partyOccupancyIds: [...c.partyOccupancyIds],
      createdAt: c.createdAt,
    };
  }
}

/** A contract with its scan's presigned GET (no-store). */
export class ContractReadView extends ContractView {
  @ApiProperty({ type: String, nullable: true })
  fileUrl: string | null;

  static fromRead(
    c: ContractRead,
    read: PresignedRead | null,
  ): ContractReadView {
    return { ...ContractView.from(c), fileUrl: read?.url ?? null };
  }
}

export class RenewalView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  contractId: string;
  @ApiProperty({ enum: ['open', 'renewed', 'declined', 'withdrawn'] })
  status: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  renewedContractId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['owner_declined', 'dues_outstanding', 'terms_not_agreed', 'other'],
  })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;

  static from(r: RenewalRead): RenewalView {
    return { ...r };
  }
}

export class StaffRenewalView extends RenewalView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;

  static fromStaff(r: RenewalRead & { unitId: string }): StaffRenewalView {
    return { ...RenewalView.from(r), unitId: r.unitId };
  }
}

class RenewOption {
  @ApiProperty({ type: String, format: 'date' })
  askBy: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP, invoiced by the management.',
  })
  fee: string | null;
  @ApiProperty({
    type: RenewalView,
    nullable: true,
    description: 'The latest request.',
  })
  request: RenewalView | null;
}

class MoveOutOption {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Announce leaving by this day.',
  })
  noticeBy: string;
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Leave by this day (the lease’s end).',
  })
  leaveBy: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP, invoiced by the management.',
  })
  fee: string | null;
}

/** A lease's two ways out (ADR 0062); what each means is the compound's moving guide. */
export class EndOptionsView {
  @ApiProperty({ type: ContractView })
  contract: ContractView;
  @ApiProperty({ type: RenewOption })
  renewal: RenewOption;
  @ApiProperty({ type: MoveOutOption })
  moveOut: MoveOutOption;

  static from(o: EndOptions): EndOptionsView {
    return {
      contract: ContractView.from(o.contract),
      renewal: {
        askBy: day(o.renewal.askBy)!,
        fee: o.renewal.fee,
        request: o.renewal.request ? RenewalView.from(o.renewal.request) : null,
      },
      moveOut: {
        noticeBy: day(o.moveOut.noticeBy)!,
        leaveBy: day(o.moveOut.leaveBy)!,
        fee: o.moveOut.fee,
      },
    };
  }
}
