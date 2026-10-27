import { ApiProperty } from '@nestjs/swagger';
import {
  TicketPriority,
  type ChecklistTemplate,
  type ChecklistTemplateItem,
} from '@prisma/client';
import {
  CHECKLIST_PURPOSES,
  ITEM_KINDS,
  type ChecklistPurpose,
  type ItemKind,
} from '../checklist-rules';
import type { RunRead } from '../checklist-runs';
import type { ChecklistRead } from '../checklists.service';

const decimal = (d: { toFixed(n: number): string } | null) =>
  d === null ? null : d.toFixed(4);

/** A checklist in a list (ADR 0064). */
export class ChecklistSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ enum: CHECKLIST_PURPOSES })
  purpose: ChecklistPurpose;
  @ApiProperty({ type: Boolean })
  requireScan: boolean;
  @ApiProperty({ type: Number })
  version: number;
  @ApiProperty({ type: Boolean })
  active: boolean;

  static from(t: ChecklistTemplate): ChecklistSummaryView {
    return {
      id: t.id,
      key: t.key,
      nameAr: t.nameAr,
      nameEn: t.nameEn,
      purpose: t.purpose as ChecklistPurpose,
      requireScan: t.requireScan,
      version: t.currentVersion,
      active: t.active,
    };
  }
}

export class ChecklistItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Number, description: '1 first.' })
  position: number;
  @ApiProperty({ enum: ITEM_KINDS })
  kind: ItemKind;
  @ApiProperty({ type: String })
  labelAr: string;
  @ApiProperty({ type: String })
  labelEn: string;
  @ApiProperty({ type: Boolean })
  required: boolean;
  @ApiProperty({ type: String, nullable: true })
  metricKey: string | null;
  @ApiProperty({ type: String, nullable: true })
  unit: string | null;
  @ApiProperty({ type: String, nullable: true })
  minValue: string | null;
  @ApiProperty({ type: String, nullable: true })
  maxValue: string | null;
  @ApiProperty({ type: Boolean })
  failCreatesTicket: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  followUpCategoryId: string | null;
  @ApiProperty({
    enum: TicketPriority,
    enumName: 'TicketPriority',
    nullable: true,
  })
  followUpPriority: TicketPriority | null;

  static from(i: ChecklistTemplateItem): ChecklistItemView {
    return {
      id: i.id,
      position: i.position,
      kind: i.kind as ItemKind,
      labelAr: i.labelAr,
      labelEn: i.labelEn,
      required: i.required,
      metricKey: i.metricKey,
      unit: i.unit,
      minValue: decimal(i.minValue),
      maxValue: decimal(i.maxValue),
      failCreatesTicket: i.failCreatesTicket,
      followUpCategoryId: i.followUpCategoryId,
      followUpPriority: i.followUpPriority,
    };
  }
}

/** A checklist with its current version's items. */
export class ChecklistView extends ChecklistSummaryView {
  @ApiProperty({ type: [ChecklistItemView] })
  items: ChecklistItemView[];

  static fromRead(r: ChecklistRead): ChecklistView {
    return {
      ...ChecklistSummaryView.from(r.template),
      items: r.items.map((i) => ChecklistItemView.from(i)),
    };
  }
}

class ChecklistPhotoView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned; null when gone.',
  })
  url: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  urlExpiresAt: Date | null;
}

class ChecklistAnswerView {
  @ApiProperty({
    enum: ['pass', 'fail', 'na'],
    nullable: true,
    description: 'A reading out of its range is `fail`.',
  })
  result: string | null;
  @ApiProperty({ type: String, nullable: true })
  value: string | null;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  answeredById: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  answeredAt: Date;
  @ApiProperty({ type: [ChecklistPhotoView] })
  photos: ChecklistPhotoView[];
}

class ChecklistRunItemView extends ChecklistItemView {
  @ApiProperty({ type: ChecklistAnswerView, nullable: true })
  answer: ChecklistAnswerView | null;
}

/**
 * A checklist being filled, or submitted (ADR 0064): its items, as of the
 * version it took, with their answers; once submitted, who, when, and the
 * SHA-256 of exactly what it said.
 */
export class ChecklistRunView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  checklistId: string;
  @ApiProperty({ type: Number })
  version: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetId: string | null;
  @ApiProperty({ enum: ['open', 'submitted'] })
  status: 'open' | 'submitted';
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  submittedAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  submittedById: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Hex SHA-256 of the submitted answers.',
  })
  attestationSha256: string | null;
  @ApiProperty({ type: [ChecklistRunItemView] })
  items: ChecklistRunItemView[];

  static from(r: RunRead): ChecklistRunView {
    return {
      id: r.run.id,
      checklistId: r.run.templateId,
      version: r.run.version,
      assetId: r.run.assetId,
      status: r.run.status as 'open' | 'submitted',
      submittedAt: r.run.submittedAt,
      submittedById: r.run.submittedById,
      attestationSha256: r.run.attestationSha256,
      items: r.items.map(({ item, answer }) => ({
        ...ChecklistItemView.from(item),
        answer: answer
          ? {
              result: answer.answer.result,
              value: decimal(answer.answer.value),
              note: answer.answer.note,
              answeredById: answer.answer.answeredById,
              answeredAt: answer.answer.answeredAt,
              photos: answer.photos.map((p) => ({
                id: p.photo.id,
                url: p.read?.url ?? null,
                urlExpiresAt: p.read?.expiresAt ?? null,
              })),
            }
          : null,
      })),
    };
  }
}
