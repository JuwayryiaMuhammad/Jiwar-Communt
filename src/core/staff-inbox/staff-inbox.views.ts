import { ApiProperty } from '@nestjs/swagger';
import { INBOX_TYPES, type InboxType } from './staff-inbox';
import type {
  BulkOutcome,
  InboxCount,
  InboxEntry,
  InboxSetting,
} from './staff-inbox.service';

export class InboxAuthorityView {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The board’s threshold for the type (EGP); null: the compound set none.',
  })
  limit: string | null;
  @ApiProperty({
    enum: ['manager', 'board'],
    description:
      '`board`: the amount is above the limit, so it goes to the board as an approval request (ADR 0055).',
  })
  decider: 'manager' | 'board';
}

/**
 * One item waiting for a staff decision (ADR 0073): what it is, how long it
 * has waited, when it is due and who decides it. The dashboard opens and
 * decides it on its own domain's route.
 */
export class InboxItemView {
  @ApiProperty({ enum: INBOX_TYPES, enumName: 'InboxType' })
  type: InboxType;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Its reference, as its domain shows it.',
  })
  number: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What it is within its type (a permit’s kind), a code.',
  })
  kind: string | null;
  @ApiProperty({ type: String, description: 'Its domain’s pending status.' })
  status: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  dueAt: Date;
  @ApiProperty({ type: Boolean })
  overdue: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EGP at stake, for a type with a threshold.',
  })
  amount: string | null;
  @ApiProperty({ type: () => InboxAuthorityView, nullable: true })
  authority: InboxAuthorityView | null;
  @ApiProperty({
    type: Boolean,
    description: 'Its approval takes no input: a bulk approval may take it.',
  })
  bulk: boolean;

  static from(e: InboxEntry): InboxItemView {
    return Object.assign(new InboxItemView(), {
      type: e.type,
      id: e.id,
      number: e.number,
      kind: e.kind,
      status: e.status,
      unitId: e.unitId,
      requestedAt: e.requestedAt,
      dueAt: e.dueAt,
      overdue: e.overdue,
      amount: e.amount,
      authority: e.authority ? { ...e.authority } : null,
      bulk: e.bulk,
    });
  }
}

export class InboxTypeCountView {
  @ApiProperty({ enum: INBOX_TYPES, enumName: 'InboxType' })
  type: InboxType;
  @ApiProperty({ type: Number })
  total: number;
  @ApiProperty({ type: Number })
  overdue: number;
}

export class InboxCountView {
  @ApiProperty({ type: Number })
  total: number;
  @ApiProperty({ type: Number })
  overdue: number;
  @ApiProperty({
    type: [InboxTypeCountView],
    description: 'The types the caller decides, in a fixed order.',
  })
  types: InboxTypeCountView[];

  static from(c: InboxCount): InboxCountView {
    return Object.assign(new InboxCountView(), {
      total: c.total,
      overdue: c.overdue,
      types: c.types.map((t) => ({ ...t })),
    });
  }
}

export class InboxSettingView {
  @ApiProperty({ enum: INBOX_TYPES, enumName: 'InboxType' })
  type: InboxType;
  @ApiProperty({ type: Number })
  dueHours: number;
  @ApiProperty({ type: Number })
  defaultDueHours: number;
  @ApiProperty({
    type: Boolean,
    description: 'The compound set its own due time.',
  })
  custom: boolean;

  static from(s: InboxSetting): InboxSettingView {
    return Object.assign(new InboxSettingView(), { ...s });
  }
}

export class BulkOutcomeView {
  @ApiProperty({ enum: INBOX_TYPES, enumName: 'InboxType' })
  type: InboxType;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ['approved', 'failed'] })
  outcome: 'approved' | 'failed';
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it failed: the error code its own route answers.',
  })
  code: string | null;

  static from(o: BulkOutcome): BulkOutcomeView {
    return Object.assign(new BulkOutcomeView(), {
      type: o.type,
      id: o.id,
      outcome: o.outcome,
      code: o.outcome === 'failed' ? o.code : null,
    });
  }
}
