import { ApiProperty } from '@nestjs/swagger';
import type { MaintenanceContract, ReadinessItem } from '@prisma/client';
import { REASON_CODES } from '../../../core/common/reasons';
import { ofDateColumn } from '../../schedules/local-dates';
import type { CampaignRead } from '../campaigns.service';
import {
  itemState,
  READINESS_ITEM_KINDS,
  READINESS_KINDS,
} from '../readiness-rules';
import type { ContractDue, CopyRead, ProgramRead } from '../readiness.service';

export class ReadinessView {
  @ApiProperty({ type: Number })
  items: number;
  @ApiProperty({ type: Number })
  done: number;
  @ApiProperty({ type: Number })
  cancelled: number;
  @ApiProperty({ type: Number })
  open: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Done over everything not called off, in whole percent; null with nothing to do.',
  })
  percent: number | null;
  @ApiProperty({
    type: String,
    description: 'EGP: the estimates of the items not called off.',
  })
  budget: string;
}

export class ReadinessProgramView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: READINESS_KINDS, enumName: 'ReadinessKind' })
  kind: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, format: 'date' })
  startsOn: string;
  @ApiProperty({ type: String, format: 'date' })
  endsOn: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  copiedFromId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: ReadinessView })
  readiness: ReadinessView;

  static from({ program: p, readiness }: ProgramRead): ReadinessProgramView {
    return {
      id: p.id,
      kind: p.kind,
      title: p.title,
      startsOn: ofDateColumn(p.startsOn),
      endsOn: ofDateColumn(p.endsOn),
      copiedFromId: p.copiedFromId,
      closedAt: p.closedAt,
      createdAt: p.createdAt,
      readiness: { ...readiness },
    };
  }
}

export class ReadinessCopyView extends ReadinessProgramView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    isArray: true,
    description:
      'Copied items whose owner may no longer own one: they are now the copier’s.',
  })
  reassignedItemIds: string[];

  static fromCopy(c: CopyRead): ReadinessCopyView {
    return {
      ...ReadinessProgramView.from(c),
      reassignedItemIds: [...c.reassignedItemIds],
    };
  }
}

export class ReadinessItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  programId: string;
  @ApiProperty({ enum: READINESS_ITEM_KINDS, enumName: 'ReadinessItemKind' })
  kind: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ownerId: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP, two places.',
  })
  estimateAmount: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  contractId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  checklistId: string | null;
  @ApiProperty({ enum: ['open', 'done', 'cancelled'] })
  state: 'open' | 'done' | 'cancelled';
  @ApiProperty({
    enum: REASON_CODES.contractReviewDecision,
    enumName: 'ContractReviewDecision',
    nullable: true,
  })
  decision: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  doneAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.readinessItemCancel,
    enumName: 'ReadinessItemCancelReason',
    nullable: true,
  })
  cancelReason: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  copiedFromId: string | null;

  static from(i: ReadinessItem): ReadinessItemView {
    return {
      id: i.id,
      programId: i.programId,
      kind: i.kind,
      title: i.title,
      ownerId: i.ownerId,
      dueOn: ofDateColumn(i.dueOn),
      estimateAmount: i.estimateAmount?.toFixed(2) ?? null,
      contractId: i.contractId,
      checklistId: i.checklistId,
      state: itemState(i),
      decision: i.decision,
      doneAt: i.doneAt,
      cancelledAt: i.cancelledAt,
      cancelReason: i.cancelReason,
      copiedFromId: i.copiedFromId,
    };
  }
}

export class ContractDueView {
  @ApiProperty({ type: String, format: 'uuid' })
  contractId: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  kind: string;
  @ApiProperty({ type: String, format: 'date' })
  endsOn: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The program’s review of it, when there is one.',
  })
  itemId: string | null;

  static from({ contract: c, itemId }: ContractDue): ContractDueView {
    return ContractDueView.of(c, itemId);
  }

  private static of(c: MaintenanceContract, itemId: string | null) {
    return {
      contractId: c.id,
      code: c.code,
      kind: c.kind,
      endsOn: ofDateColumn(c.endsOn),
      itemId,
    };
  }
}

export class CampaignInspectionView {
  @ApiProperty({ type: String, format: 'uuid' })
  inspectionId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  commonAreaId: string | null;
  @ApiProperty({
    type: String,
    description: 'scheduled, in_progress, submitted or cancelled.',
  })
  status: string;
}

export class CampaignView {
  @ApiProperty({ type: ReadinessItemView })
  item: ReadinessItemView;
  @ApiProperty({ type: [CampaignInspectionView] })
  inspections: CampaignInspectionView[];
  @ApiProperty({
    type: String,
    format: 'uuid',
    isArray: true,
    description:
      'The inspections this call scheduled: none when every target had one.',
  })
  spawned: string[];

  static from(c: CampaignRead): CampaignView {
    return {
      item: ReadinessItemView.from(c.item),
      inspections: c.inspections.map((i) => ({ ...i })),
      spawned: [...c.spawned],
    };
  }
}
