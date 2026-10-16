import { ApiProperty } from '@nestjs/swagger';
import type { GuardTask } from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { PresignedReadView } from '../../../core/files/views/file.views';
import type { DutyNames } from '../../roster/duty-names';
import { PostView } from '../../roster/views/roster.views';

/** What the task views read beside the rows. */
export interface TaskContext {
  names: DutyNames;
  locations: Map<
    string,
    { unitId: string; unitCode: string; building: string | null }
  >;
  photos: Map<string, { url: string; expiresAt: Date }[]>;
}

export class TaskUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
}

const KIND = {
  enum: ['closed_unit_inspection', 'custom'],
  enumName: 'GuardTaskKind',
};
const STATUS = {
  enum: ['open', 'in_progress', 'done', 'cancelled'],
  enumName: 'GuardTaskStatus',
};

/** What both sides read of a task. Never a resident's name or phone. */
class GuardTaskBodyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty(KIND)
  kind: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A custom task’s, the management’s words; null for an inspection (the app names it).',
  })
  title: string | null;
  @ApiProperty({ type: String, nullable: true })
  details: string | null;
  @ApiProperty({
    type: TaskUnitView,
    nullable: true,
    description: 'The closed unit to inspect: where it is, nobody in it.',
  })
  unit: TaskUnitView | null;
  @ApiProperty({
    type: PostView,
    nullable: true,
    description: 'For a gate or a zone; null for one guard (`assignee`).',
  })
  post: PostView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dueAt: Date | null;
  @ApiProperty(STATUS)
  status: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  takenAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  doneAt: Date | null;
  @ApiProperty({
    enum: [...REASON_CODES.guardTaskOutcome],
    enumName: 'GuardTaskOutcome',
    nullable: true,
  })
  outcome: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The guard’s.' })
  resultNote: string | null;
  @ApiProperty({ type: [PresignedReadView] })
  photos: PresignedReadView[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From `guardTaskCancel`, or `guardTaskCancelSystem`.',
  })
  cancelReason: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'A shift’s end moved it here from the guard who had it.',
  })
  carried: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

function body(t: GuardTask, c: TaskContext): GuardTaskBodyView {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    details: t.details,
    unit: t.unitId ? (c.locations.get(t.unitId) ?? null) : null,
    post: t.gateId || t.placeId ? PostView.of(t, c.names) : null,
    dueAt: t.dueAt,
    status: t.status,
    takenAt: t.takenAt,
    doneAt: t.doneAt,
    outcome: t.outcome,
    resultNote: t.resultNote,
    photos: c.photos.get(t.id) ?? [],
    cancelReason: t.cancelReason,
    carried: t.carriedFromShiftId !== null,
    createdAt: t.createdAt,
  };
}

const ref = <V>(
  id: string | null,
  c: TaskContext,
  as: (a: { id: string; fullName: string | null; status: string }) => V,
): V | null => {
  const a = id ? c.names.people.get(id) : undefined;
  return a ? as(a) : null;
};

/** A task as a guard reads it: colleagues by first name. */
export class GuardTaskView extends GuardTaskBodyView {
  @ApiProperty({ type: FirstNameRefView, nullable: true })
  assignee: FirstNameRefView | null;
  @ApiProperty({ type: FirstNameRefView, nullable: true })
  takenBy: FirstNameRefView | null;

  static from(t: GuardTask, c: TaskContext): GuardTaskView {
    return {
      ...body(t, c),
      assignee: ref(t.assigneeId, c, firstNameRef),
      takenBy: ref(t.takenById, c, firstNameRef),
    };
  }
}

/** A task as the management reads it: full names, who made it. */
export class StaffGuardTaskView extends GuardTaskBodyView {
  @ApiProperty({ type: AccountRefView, nullable: true })
  assignee: AccountRefView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  takenBy: AccountRefView | null;
  @ApiProperty({ type: AccountRefView })
  createdBy: AccountRefView;

  static of(t: GuardTask, c: TaskContext): StaffGuardTaskView {
    return {
      ...body(t, c),
      assignee: ref(t.assigneeId, c, accountRef),
      takenBy: ref(t.takenById, c, accountRef),
      createdBy: ref(t.createdById, c, accountRef)!,
    };
  }
}
