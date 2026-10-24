import { ApiProperty } from '@nestjs/swagger';
import {
  APPEAL_STATES,
  RESIDENT_ITEM_TYPES,
  type AppealState,
  type ResidentItem,
} from './resident-items';

export class ItemAppealView {
  @ApiProperty({
    enum: APPEAL_STATES,
    enumName: 'AppealState',
    description:
      '`upheld`: the decision stands; `overturned`: the appellant won.',
  })
  state: AppealState;
  @ApiProperty({ type: String, format: 'date-time', description: 'Lodged.' })
  at: Date;
  @ApiProperty({ enum: ['management', 'board'] })
  decidedBy: 'management' | 'board';
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: () => ItemDeciderRoleView,
    nullable: true,
    description:
      'The deciding manager’s role as it was then (a decision appeal); never a person. Null for the board and for the rest.',
  })
  deciderRole: ItemDeciderRoleView | null;
}

export class ItemDeciderRoleView {
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, nullable: true })
  name: string | null;
}

/**
 * One row of a resident's lists (ADR 0058): what it is, its reference and
 * status, and when it last moved. The app opens it on its own route.
 */
export class ResidentItemView {
  @ApiProperty({ enum: RESIDENT_ITEM_TYPES, enumName: 'ResidentItemType' })
  type: string;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Its reference, as its own screens show it.',
  })
  number: string | null;
  @ApiProperty({
    type: String,
    description: 'The item’s own status, a code of its kind of item.',
  })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  lastActivityAt: Date;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A permit’s or an appeal’s kind; a violation’s kind.',
  })
  kind: string | null;
  @ApiProperty({ type: String, nullable: true })
  categoryKey: string | null;
  @ApiProperty({ type: String, nullable: true })
  topicKey: string | null;
  @ApiProperty({ type: String, nullable: true })
  requestType: string | null;

  @ApiProperty({
    type: () => ItemAppealView,
    nullable: true,
    description: 'Where its appeal stands (the appeals list); null elsewhere.',
  })
  appeal: ItemAppealView | null;

  static from(i: ResidentItem): ResidentItemView {
    return {
      type: i.type,
      id: i.id,
      number: i.number,
      status: i.status,
      lastActivityAt: i.lastActivityAt,
      unitId: i.unitId,
      kind: i.kind,
      categoryKey: i.categoryKey,
      topicKey: i.topicKey,
      requestType: i.requestType,
      appeal: i.appeal
        ? {
            state: i.appeal.state,
            at: i.appeal.at,
            decidedBy: i.appeal.decidedBy,
            decidedAt: i.appeal.decidedAt,
            deciderRole: i.appeal.deciderRole ?? null,
          }
        : null,
    };
  }
}
