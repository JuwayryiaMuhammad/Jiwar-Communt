import { ApiProperty } from '@nestjs/swagger';
import type { GuardHandover, GuardHandoverItem } from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import type { DutyNames } from '../../roster/duty-names';
import { PostView } from '../../roster/views/roster.views';

export class GuardHandoverItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, maxLength: 120 })
  label: string;
  @ApiProperty({ type: Number, description: 'Lower first.' })
  position: number;

  static from(i: GuardHandoverItem): GuardHandoverItemView {
    return { id: i.id, label: i.label, position: i.position };
  }
}

/** An item as the management keeps it. */
export class ManagedGuardHandoverItemView extends GuardHandoverItemView {
  @ApiProperty({
    type: Boolean,
    description: 'Retired items are asked no more; handovers keep them.',
  })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static of(i: GuardHandoverItem): ManagedGuardHandoverItemView {
    return {
      ...GuardHandoverItemView.from(i),
      active: i.active,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    };
  }
}

export class GuardTickedItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  itemId: string;
  @ApiProperty({ type: String, description: 'As it read when ticked.' })
  label: string;
}

/** What both sides read of a handover. */
class GuardHandoverBodyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  shiftId: string;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({
    enum: ['guard', 'system'],
    enumName: 'GuardHandoverKind',
    description:
      '`system`: the system ended the shift (its post out of service, its guard gone); no checklist, no notes.',
  })
  kind: string;
  @ApiProperty({ type: [GuardTickedItemView] })
  checklist: GuardTickedItemView[];
  @ApiProperty({ type: String, nullable: true })
  notes: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acknowledgedAt: Date | null;
  @ApiProperty({
    type: [String],
    description:
      'The tasks the end moved to the post, open again for the next guard (`GET /gate/tasks/{id}`).',
  })
  carriedTaskIds: string[];
}

/** What a handover view reads beside the row. */
export interface HandoverContext {
  names: DutyNames;
  carried: Map<string, string[]>;
}

function body(h: GuardHandover, c: HandoverContext): GuardHandoverBodyView {
  const names = c.names;
  return {
    id: h.id,
    shiftId: h.shiftId,
    post: PostView.of(h, names),
    kind: h.kind,
    checklist: h.checklist as unknown as GuardTickedItemView[],
    notes: h.notes,
    createdAt: h.createdAt,
    acknowledgedAt: h.acknowledgedAt,
    carriedTaskIds: c.carried.get(h.shiftId) ?? [],
  };
}

/** A handover as the guards at its post read it: first names. */
export class GuardHandoverView extends GuardHandoverBodyView {
  @ApiProperty({ type: FirstNameRefView, description: 'Who handed over.' })
  guard: FirstNameRefView;
  @ApiProperty({ type: FirstNameRefView, nullable: true })
  acknowledgedBy: FirstNameRefView | null;

  static from(h: GuardHandover, c: HandoverContext): GuardHandoverView {
    const by = h.acknowledgedById
      ? c.names.people.get(h.acknowledgedById)
      : undefined;
    return {
      ...body(h, c),
      guard: firstNameRef(c.names.people.get(h.guardAccountId)!),
      acknowledgedBy: by ? firstNameRef(by) : null,
    };
  }
}

/** A handover as the management reads it: full names. */
export class StaffGuardHandoverView extends GuardHandoverBodyView {
  @ApiProperty({ type: AccountRefView, description: 'Who handed over.' })
  guard: AccountRefView;
  @ApiProperty({ type: AccountRefView, nullable: true })
  acknowledgedBy: AccountRefView | null;

  static of(h: GuardHandover, c: HandoverContext): StaffGuardHandoverView {
    const by = h.acknowledgedById
      ? c.names.people.get(h.acknowledgedById)
      : undefined;
    return {
      ...body(h, c),
      guard: accountRef(c.names.people.get(h.guardAccountId)!),
      acknowledgedBy: by ? accountRef(by) : null,
    };
  }
}
