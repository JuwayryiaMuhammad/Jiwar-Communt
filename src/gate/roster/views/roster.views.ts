import { ApiProperty } from '@nestjs/swagger';
import type { GuardRosterSlot, GuardRosterTemplate } from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { GuardGateView } from '../../gates/views/gate.views';
import { PlaceView } from '../../places/views/place.views';
import type { DutyNames } from '../duty-names';
import { dateOnly } from '../roster-core';
import { isLate } from '../roster-rules';

/** What a view needs to name a post and people. */
export type RosterNames = DutyNames;

export class WeeklyWindowView {
  @ApiProperty({ type: String, example: '22:00' })
  from: string;
  @ApiProperty({
    type: String,
    example: '06:00',
    description: 'Before `from`: the window runs into the next day.',
  })
  to: string;
}

export class WeeklyScheduleView {
  @ApiProperty({
    type: [Number],
    description: 'Weekdays, 0 = Sunday … 6 = Saturday.',
  })
  days: number[];
  @ApiProperty({ type: [WeeklyWindowView] })
  windows: WeeklyWindowView[];
}

/** Where a guard works: a gate or a zone (ADR 0050). */
export class PostView {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  gateId: string | null;
  @ApiProperty({ type: String, nullable: true })
  gateName: string | null;
  @ApiProperty({ type: PlaceView, nullable: true })
  zone: PlaceView | null;

  static of(
    p: { gateId: string | null; placeId: string | null },
    names: RosterNames,
  ): PostView {
    return {
      gateId: p.gateId,
      gateName: p.gateId ? (names.gates.get(p.gateId) ?? null) : null,
      zone: p.placeId ? (names.zones.get(p.placeId) ?? null) : null,
    };
  }
}

export class RosterTemplateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView })
  guard: AccountRefView;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({ type: WeeklyScheduleView })
  schedule: WeeklyScheduleView;
  @ApiProperty({ type: String, format: 'date', example: '2026-11-01' })
  effectiveFrom: string;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Its last day, inclusive; null for no end.',
  })
  effectiveUntil: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    enum: [...REASON_CODES.guardTemplateEnd],
    enumName: 'GuardTemplateEnd',
    nullable: true,
  })
  endReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(t: GuardRosterTemplate, names: RosterNames): RosterTemplateView {
    return {
      id: t.id,
      guard: accountRef(names.people.get(t.guardAccountId)!),
      post: PostView.of(t, names),
      schedule: t.schedule as unknown as WeeklyScheduleView,
      effectiveFrom: dateOnly(t.effectiveFrom),
      effectiveUntil: t.effectiveUntil ? dateOnly(t.effectiveUntil) : null,
      endedAt: t.endedAt,
      endReason: t.endReason,
      createdAt: t.createdAt,
    };
  }
}

export class SlotShiftView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minutes worked beyond the slot, once the shift ended.',
  })
  overtimeMinutes: number | null;
}

/** A slot as its guard sees it. */
export class MySlotView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({
    enum: ['scheduled', 'cancelled'],
    enumName: 'GuardSlotStatus',
  })
  status: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'From `guardSlotCancel`, or `guardSlotCancelSystem` when the system cancelled it.',
  })
  cancelReason: string | null;
  @ApiProperty({ type: SlotShiftView, nullable: true })
  shift: SlotShiftView | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minutes after the start the shift opened; null until it did.',
  })
  lateMinutes: number | null;
  @ApiProperty({
    type: Boolean,
    description: 'Opened more than ten minutes after the start.',
  })
  late: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Not opened an hour after its start.',
  })
  absentAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When a swap gave it to this guard.',
  })
  swappedAt: Date | null;

  static from(
    s: GuardRosterSlot,
    names: RosterNames,
    shifts: Map<string, SlotShiftView>,
  ): MySlotView {
    return {
      id: s.id,
      post: PostView.of(s, names),
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      status: s.status,
      cancelReason: s.cancelReason,
      shift: s.shiftId ? (shifts.get(s.shiftId) ?? null) : null,
      lateMinutes: s.lateMinutes,
      late: isLate(s.lateMinutes),
      absentAt: s.absentAt,
      swappedAt: s.swappedAt,
    };
  }
}

/** A slot as the management sees it. */
export class RosterSlotView extends MySlotView {
  @ApiProperty({ type: AccountRefView })
  guard: AccountRefView;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The template that made it; null for a single slot.',
  })
  templateId: string | null;

  static of(
    s: GuardRosterSlot,
    names: RosterNames,
    shifts: Map<string, SlotShiftView>,
  ): RosterSlotView {
    return {
      ...MySlotView.from(s, names, shifts),
      guard: accountRef(names.people.get(s.guardAccountId)!),
      templateId: s.templateId,
    };
  }
}

/** One guard's attendance over a period (ADR 0050). Recorded only, no payroll. */
export class GuardAttendanceView {
  @ApiProperty({ type: AccountRefView })
  guard: AccountRefView;
  @ApiProperty({
    type: Number,
    description: 'Scheduled slots starting in the period.',
  })
  slots: number;
  @ApiProperty({ type: Number, description: 'Of them, filled by a shift.' })
  filled: number;
  @ApiProperty({
    type: Number,
    description: 'Of them, opened more than ten minutes late.',
  })
  late: number;
  @ApiProperty({
    type: Number,
    description: 'Of them, not opened an hour after the start.',
  })
  absent: number;
  @ApiProperty({ type: Number })
  scheduledMinutes: number;
  @ApiProperty({
    type: Number,
    description: 'Every ended shift that started in the period.',
  })
  workedMinutes: number;
  @ApiProperty({
    type: Number,
    description: 'Beyond the slots, for shifts that filled one.',
  })
  overtimeMinutes: number;
  @ApiProperty({
    type: Number,
    description: 'Ended shifts that filled no slot.',
  })
  unscheduledShifts: number;
  @ApiProperty({ type: Number, description: 'Their length; never overtime.' })
  unscheduledMinutes: number;
}

/** What the roster's forms offer: posts in service. */
export class RosterPostsView {
  @ApiProperty({ type: [GuardGateView] })
  gates: GuardGateView[];
  @ApiProperty({ type: [PlaceView] })
  zones: PlaceView[];
}

/** An account the roster may schedule: an active `gate.operate` holder. */
export class RosterGuardView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
}
