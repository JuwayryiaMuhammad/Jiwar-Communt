import { ApiProperty } from '@nestjs/swagger';
import {
  TicketPriority,
  type MaintenancePlan,
  type MaintenancePlanEvent,
  type MaintenancePlanOccurrence,
} from '@prisma/client';
import { ofDateColumn, ofDateColumnOrNull } from '../../schedules/local-dates';
import { OCCURRENCE_STATUSES, PLAN_BASES, PLAN_TRIGGERS } from '../plan-rules';
import type { PlanRead } from '../plans.service';

class PlanStatsView {
  @ApiProperty({ type: Number })
  done: number;
  @ApiProperty({
    type: Number,
    description: 'Done by the due date plus the grace.',
  })
  onTime: number;
  @ApiProperty({ type: Number, description: 'Open past the grace.' })
  overdue: number;
  @ApiProperty({ type: Number })
  open: number;
}

/** An asset's plan (ADR 0064), with its record so far. */
export class MaintenancePlanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  assetId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  checklistId: string | null;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, format: 'uuid' })
  categoryId: string;
  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' })
  priority: TicketPriority;
  @ApiProperty({ enum: PLAN_TRIGGERS })
  trigger: string;
  @ApiProperty({ type: Number, nullable: true })
  every: number | null;
  @ApiProperty({ enum: ['day', 'week', 'month', 'year'], nullable: true })
  unit: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  anchorOn: string | null;
  @ApiProperty({ enum: PLAN_BASES, nullable: true })
  basis: string | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'The next due date not yet opened; null for a usage plan, or while a floating one’s is open.',
  })
  nextDueOn: string | null;
  @ApiProperty({ type: String, nullable: true })
  metricKey: string | null;
  @ApiProperty({ type: String, nullable: true })
  usageInterval: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The reading the next interval counts from.',
  })
  usageLastValue: string | null;
  @ApiProperty({ type: Number })
  leadDays: number;
  @ApiProperty({ type: Number })
  graceDays: number;
  @ApiProperty({ type: String, format: 'uuid' })
  ownerId: string;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: PlanStatsView })
  stats: PlanStatsView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static fromRead({ plan: p, stats }: PlanRead): MaintenancePlanView {
    return {
      id: p.id,
      assetId: p.assetId,
      checklistId: p.checklistId,
      title: p.title,
      categoryId: p.categoryId,
      priority: p.priority,
      trigger: p.trigger,
      every: p.every,
      unit: p.unit,
      anchorOn: ofDateColumnOrNull(p.anchorOn),
      basis: p.basis,
      nextDueOn: ofDateColumnOrNull(p.nextDueOn),
      metricKey: p.metricKey,
      usageInterval: p.usageInterval?.toFixed(4) ?? null,
      usageLastValue: p.usageLastValue?.toFixed(4) ?? null,
      leadDays: p.leadDays,
      graceDays: p.graceDays,
      ownerId: p.ownerId,
      active: p.active,
      stats,
      createdAt: p.createdAt,
    };
  }
}

/** A plan in a list. */
export class MaintenancePlanSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  assetId: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ enum: PLAN_TRIGGERS })
  trigger: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextDueOn: string | null;
  @ApiProperty({ type: Boolean })
  active: boolean;

  static from(p: MaintenancePlan): MaintenancePlanSummaryView {
    return {
      id: p.id,
      assetId: p.assetId,
      title: p.title,
      trigger: p.trigger,
      nextDueOn: ofDateColumnOrNull(p.nextDueOn),
      active: p.active,
    };
  }
}

/** One due date of a plan, and how it ended. */
export class PlanOccurrenceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  planId: string;
  @ApiProperty({ type: String, format: 'date' })
  originalDueOn: string;
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Moved when deferred.',
  })
  dueOn: string;
  @ApiProperty({ enum: OCCURRENCE_STATUSES })
  status: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  ticketId: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  doneOn: string | null;
  @ApiProperty({ type: Boolean, nullable: true })
  onTime: boolean | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt: Date;

  static from(o: MaintenancePlanOccurrence): PlanOccurrenceView {
    return {
      id: o.id,
      planId: o.planId,
      originalDueOn: ofDateColumn(o.originalDueOn),
      dueOn: ofDateColumn(o.dueOn),
      status: o.status,
      ticketId: o.ticketId,
      doneOn: ofDateColumnOrNull(o.doneOn),
      onTime: o.onTime,
      reasonCode: o.reasonCode,
      generatedAt: o.generatedAt,
    };
  }
}

/** What happened to a plan: codes and dates. */
export class PlanEventView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  occurrenceId: string | null;
  @ApiProperty({
    enum: [
      'created',
      'updated',
      'deactivated',
      'reactivated',
      'deferred',
      'skipped',
      'generated',
      'done',
      'cancelled',
      'overdue',
    ],
  })
  kind: string;
  @ApiProperty({ type: String, nullable: true })
  fromValue: string | null;
  @ApiProperty({ type: String, nullable: true })
  toValue: string | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null: the system.',
  })
  actorId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;

  static from(e: MaintenancePlanEvent): PlanEventView {
    return {
      id: e.id,
      occurrenceId: e.occurrenceId,
      kind: e.kind,
      fromValue: e.fromValue,
      toValue: e.toValue,
      reasonCode: e.reasonCode,
      actorId: e.actorId,
      occurredAt: e.occurredAt,
    };
  }
}
