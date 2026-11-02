import { ApiProperty } from '@nestjs/swagger';
import type {
  ExperienceCompensation,
  ExperienceSignal,
  ServicePromise,
} from '@prisma/client';
import { reference } from '../staff-inbox/staff-inbox';
import {
  COMPENSATION_KINDS,
  COMPENSATION_STATUSES,
  type CompensationAuthority,
  type CompensationKind,
  type CompensationRule,
  type CompensationStatus,
} from './compensations.service';
import {
  CASE_KINDS,
  CASE_PREFIX,
  CASE_STATUSES,
  type CaseKind,
  type CaseRead,
  type CaseStatus,
} from './experience-cases.service';
import type { RatingsReport } from './experience-reports.service';
import type { SignalRule } from './experience-settings.service';
import type { SignalRead } from './experience-signals.service';
import {
  PROMISE_METRICS,
  RATING_SOURCES,
  SIGNAL_CODES,
  type PromiseMetric,
  type RatingSource,
  type SignalCode,
} from './experience-sources';
import type { PromiseMeasurement } from './service-promises.service';

export class ExperienceRuleView {
  @ApiProperty({ enum: SIGNAL_CODES, enumName: 'ExperienceSignalCode' })
  code: SignalCode;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'How many events make a signal; null: the rule is off.',
  })
  count: number | null;
  @ApiProperty({ type: Number, description: 'Within how many days.' })
  days: number;
}

export class ExperienceSettingsView {
  @ApiProperty({ type: [ExperienceRuleView] })
  rules: ExperienceRuleView[];

  static from(s: { rules: SignalRule[] }): ExperienceSettingsView {
    return { rules: s.rules.map((r) => ({ ...r })) };
  }
}

/** A signal: a rule met for a unit (ADR 0082). */
export class ExperienceSignalView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ enum: SIGNAL_CODES, enumName: 'ExperienceSignalCode' })
  code: SignalCode;
  @ApiProperty({ type: Number, description: 'Events within the window.' })
  count: number;
  @ApiProperty({ type: Number })
  windowDays: number;
  @ApiProperty({ type: String, format: 'date-time' })
  detectedAt: Date;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  caseId: string | null;

  static from(s: SignalRead): ExperienceSignalView {
    return ExperienceSignalView.of(s.row, s.unit);
  }

  static of(
    r: ExperienceSignal,
    unit: { code: string; building: string | null } | null,
  ): ExperienceSignalView {
    return {
      id: r.id,
      unitId: r.unitId,
      unitCode: unit?.code ?? null,
      building: unit?.building ?? null,
      code: r.code as SignalCode,
      count: r.count,
      windowDays: r.windowDays,
      detectedAt: r.detectedAt,
      caseId: r.caseId,
    };
  }
}

export class CompensationAuthorityView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'compensation_above_limit’s threshold, EGP.',
  })
  threshold: string | null;
  @ApiProperty({ type: Boolean })
  binding: boolean;
  @ApiProperty({
    enum: ['manager', 'board'],
    description:
      '`board` above a binding threshold: approving names the board’s authorization.',
  })
  decider: 'manager' | 'board';
}

/** A compensation on a case (ADR 0082). */
export class CompensationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  caseId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ enum: COMPENSATION_KINDS, enumName: 'CompensationKind' })
  kind: CompensationKind;
  @ApiProperty({ type: String, description: '`creditNoteCompensation`.' })
  failureCode: string;
  @ApiProperty({ type: String, nullable: true, description: 'EGP; a credit.' })
  amount: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Staff’s words.' })
  note: string | null;
  @ApiProperty({ enum: COMPENSATION_STATUSES, enumName: 'CompensationStatus' })
  status: CompensationStatus;
  @ApiProperty({ type: String, format: 'uuid' })
  proposedById: string;
  @ApiProperty({ type: String, format: 'date-time' })
  proposedAt: Date;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  decidedById: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`compensationReject`.',
  })
  rejectReason: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The credit note finance issued for an approved credit.',
  })
  creditNoteId: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The board’s authorization it used, above the threshold.',
  })
  authorizationId: string | null;
  @ApiProperty({
    type: () => CompensationAuthorityView,
    nullable: true,
    description: 'Who decides it now; a proposed one only.',
  })
  authority: CompensationAuthorityView | null;

  static from(
    c: ExperienceCompensation,
    limit?: { threshold: string | null; binding: boolean },
  ): CompensationView {
    const amount = c.amount?.toFixed(2) ?? null;
    return {
      id: c.id,
      caseId: c.caseId,
      unitId: c.unitId,
      kind: c.kind as CompensationKind,
      failureCode: c.failureCode,
      amount,
      note: c.note,
      status: c.status as CompensationStatus,
      proposedById: c.proposedById,
      proposedAt: c.proposedAt,
      decidedById: c.decidedById,
      decidedAt: c.decidedAt,
      rejectReason: c.rejectReason,
      creditNoteId: c.creditNoteId,
      authorizationId: c.authorizationId,
      authority:
        c.status === 'proposed' && limit ? decide(limit, amount) : null,
    };
  }
}

function decide(
  limit: { threshold: string | null; binding: boolean },
  amount: string | null,
): CompensationAuthority {
  const above =
    limit.binding &&
    limit.threshold !== null &&
    amount !== null &&
    Number(amount) > Number(limit.threshold);
  return { ...limit, decider: above ? 'board' : 'manager' };
}

/** A follow-up or recovery case (ADR 0082). */
export class ExperienceCaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'EC-000123' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ enum: CASE_KINDS, enumName: 'ExperienceCaseKind' })
  kind: CaseKind;
  @ApiProperty({ enum: ['signal', 'manual'] })
  origin: 'signal' | 'manual';
  @ApiProperty({
    enum: RATING_SOURCES,
    enumName: 'ExperienceSourceType',
    nullable: true,
  })
  sourceType: RatingSource | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sourceId: string | null;
  @ApiProperty({ type: String, nullable: true })
  failureCode: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Staff’s words.' })
  note: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  ownerId: string | null;
  @ApiProperty({ enum: CASE_STATUSES, enumName: 'ExperienceCaseStatus' })
  status: CaseStatus;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  openedById: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  openedAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'An open case’s due time: the staff inbox’s for its kind.',
  })
  dueAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  closedById: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`experienceCaseOutcome`.',
  })
  outcome: string | null;
  @ApiProperty({ type: String, nullable: true })
  outcomeNote: string | null;
  @ApiProperty({
    type: [ExperienceSignalView],
    required: false,
    description: 'One case only: the signals that joined it.',
  })
  signals?: ExperienceSignalView[];
  @ApiProperty({
    type: [CompensationView],
    required: false,
    description: 'One case only: its compensations.',
  })
  compensations?: CompensationView[];

  static from(
    c: CaseRead,
    limit?: { threshold: string | null; binding: boolean },
  ): ExperienceCaseView {
    const r = c.row;
    return {
      id: r.id,
      number: reference(CASE_PREFIX, r.number)!,
      unitId: r.unitId,
      unitCode: c.unit?.code ?? null,
      building: c.unit?.building ?? null,
      kind: r.kind as CaseKind,
      origin: r.origin as 'signal' | 'manual',
      sourceType: r.sourceType as RatingSource | null,
      sourceId: r.sourceId,
      failureCode: r.failureCode,
      note: r.note,
      ownerId: r.ownerId,
      status: r.status as CaseStatus,
      openedById: r.openedById,
      openedAt: r.openedAt,
      dueAt: c.dueAt,
      closedById: r.closedById,
      closedAt: r.closedAt,
      outcome: r.outcome,
      outcomeNote: r.outcomeNote,
      ...(c.signals
        ? { signals: c.signals.map((s) => ExperienceSignalView.of(s, c.unit)) }
        : {}),
      ...(c.compensations
        ? {
            compensations: c.compensations.map((x) =>
              CompensationView.from(x, limit),
            ),
          }
        : {}),
    };
  }
}

export class CompensationRuleView {
  @ApiProperty({ type: String })
  failureCode: string;
  @ApiProperty({ enum: COMPENSATION_KINDS, enumName: 'CompensationKind' })
  kind: CompensationKind;
  @ApiProperty({ type: String, nullable: true })
  amount: string | null;

  static from(r: CompensationRule): CompensationRuleView {
    return { ...r };
  }
}

/** A service promise (ADR 0082). */
export class ServicePromiseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  titleEn: string;
  @ApiProperty({ type: String })
  titleAr: string;
  @ApiProperty({
    enum: PROMISE_METRICS,
    enumName: 'ServicePromiseMetric',
    nullable: true,
  })
  metric: PromiseMetric | null;
  @ApiProperty({ type: Number, nullable: true })
  target: number | null;
  @ApiProperty({ type: Number, nullable: true })
  targetShare: number | null;
  @ApiProperty({ type: Boolean })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(p: ServicePromise): ServicePromiseView {
    return {
      id: p.id,
      titleEn: p.titleEn,
      titleAr: p.titleAr,
      metric: p.metric as PromiseMetric | null,
      target: p.target === null ? null : Number(p.target),
      targetShare: p.targetShare,
      active: p.active,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }
}

export class PromiseMeasurementView {
  @ApiProperty({ type: () => ServicePromiseView })
  promise: ServicePromiseView;
  @ApiProperty({ type: Boolean, description: 'False: no metric.' })
  measured: boolean;
  @ApiProperty({ type: Number })
  items: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The share within the hours (%), or the average rating.',
  })
  value: number | null;
  @ApiProperty({ type: Boolean, nullable: true })
  met: boolean | null;
}

export class PromisesReportView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: [PromiseMeasurementView] })
  items: PromiseMeasurementView[];

  static from(r: {
    period: { from: string; to: string };
    items: PromiseMeasurement[];
  }): PromisesReportView {
    return {
      from: r.period.from,
      to: r.period.to,
      items: r.items.map((m) => ({
        ...m,
        promise: ServicePromiseView.from(m.promise),
      })),
    };
  }
}

export class ExperienceRatingTotalsView {
  @ApiProperty({ type: Number })
  count: number;
  @ApiProperty({ type: Number, nullable: true })
  average: number | null;
  @ApiProperty({ type: Number, description: 'Ratings of 1 or 2.' })
  low: number;
}

export class ExperienceSourceTotalsView extends ExperienceRatingTotalsView {
  @ApiProperty({ enum: RATING_SOURCES, enumName: 'ExperienceSourceType' })
  source: RatingSource;
}

export class ExperienceBuildingTotalsView extends ExperienceRatingTotalsView {
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
}

export class LowRatingReasonCountView {
  @ApiProperty({ type: String, description: '`lowRating`.' })
  code: string;
  @ApiProperty({ type: Number })
  count: number;
  @ApiProperty({ type: Number, description: 'Of the stated, %.' })
  share: number;
}

export class LowRatedUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: Number })
  low: number;
}

/** The ratings report (ADR 0082): never who rated, never a comment. */
export class RatingsReportView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: () => ExperienceRatingTotalsView })
  totals: ExperienceRatingTotalsView;
  @ApiProperty({ type: [ExperienceSourceTotalsView] })
  bySource: ExperienceSourceTotalsView[];
  @ApiProperty({ type: [LowRatingReasonCountView] })
  reasons: LowRatingReasonCountView[];
  @ApiProperty({ type: Number, description: 'Low ratings with no reason.' })
  unstated: number;
  @ApiProperty({ type: [ExperienceBuildingTotalsView] })
  byBuilding: ExperienceBuildingTotalsView[];
  @ApiProperty({ type: [LowRatedUnitView] })
  units: LowRatedUnitView[];

  static from(r: RatingsReport): RatingsReportView {
    const { period, ...rest } = r;
    return { from: period.from, to: period.to, ...rest };
  }
}
