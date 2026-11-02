import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// Experience sources (ADR 0082)
// ============================================================================
//
// What the experience rules read lives in the domains: the ratings (a
// ticket's confirmation, a management request's, a partner request's), the
// tickets sent back, the complaints a unit made, the units themselves. Core
// imports no domain (ADR 0015), so each registers its reader here at startup,
// as with StaffInbox and BoardMatters, and reads in the caller's tenant
// transaction (RLS). Codes, ids, numbers and times only: never a comment.

/** The ratings the compound has, one source each. */
export const RATING_SOURCES = [
  'ticket',
  'management_request',
  'partner_request',
] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

/** The rules, one code each. */
export const SIGNAL_CODES = [
  'repeated_low_ratings',
  'reopened_tickets',
  'repeated_complaints',
] as const;
export type SignalCode = (typeof SIGNAL_CODES)[number];

/** What a promise is measured by, where the data exists. */
export const PROMISE_METRICS = [
  'ticket_resolution_hours',
  'request_response_hours',
  'ticket_rating',
  'request_rating',
  'partner_rating',
] as const;
export type PromiseMetric = (typeof PROMISE_METRICS)[number];
/** The metrics a domain measures; the rating ones are the ratings' average. */
export type HoursMetric = Extract<
  PromiseMetric,
  'ticket_resolution_hours' | 'request_response_hours'
>;
export const HOURS_METRICS: readonly HoursMetric[] = [
  'ticket_resolution_hours',
  'request_response_hours',
];
export const RATING_METRIC_SOURCE: Record<
  Exclude<PromiseMetric, HoursMetric>,
  RatingSource
> = {
  ticket_rating: 'ticket',
  request_rating: 'management_request',
  partner_rating: 'partner_request',
};

/** One rating, as the reports read it. */
export interface RatingRow {
  source: RatingSource;
  /**
   * The rating's own id in its domain: a ticket's feedback row (a ticket is
   * rated once per cycle), a request's id (a request is rated once).
   */
  itemId: string;
  /** Null when the item names no unit (a request about none). */
  unitId: string | null;
  /** 1 to 5. */
  rating: number;
  /** REASON_CODES.lowRating, on a rating of 1 or 2 since ADR 0082. */
  lowReason: string | null;
  ratedAt: Date;
}

/** Something that counts towards a rule, for one unit. */
export interface ExperienceEvent {
  unitId: string;
  /** Its id in its own table: the newest one is a signal's basis. */
  itemId: string;
  at: Date;
}

export interface RatingSourceReader {
  source: RatingSource;
  /** Its ratings given in [from, to). */
  ratings(tx: TenantTxClient, from: Date, to: Date): Promise<RatingRow[]>;
}

/** Events since an instant, for one rule. */
export type EventReader = (
  tx: TenantTxClient,
  since: Date,
) => Promise<ExperienceEvent[]>;

/** A unit as the lists show it: its code and building, never its people. */
export interface UnitLabel {
  code: string;
  building: string | null;
}

export type UnitReader = (
  tx: TenantTxClient,
  unitIds: readonly string[],
) => Promise<Map<string, UnitLabel>>;

/**
 * A promise's hours, measured over the items that started in [from, to):
 * how many there were and how many were done within `hours`.
 */
export type HoursMeasure = (
  tx: TenantTxClient,
  period: { from: Date; to: Date },
  hours: number,
) => Promise<{ items: number; within: number }>;

@Injectable()
export class ExperienceSources {
  private readonly ratingSources = new Map<RatingSource, RatingSourceReader>();
  private readonly events = new Map<SignalCode, [string, EventReader][]>();
  private readonly measures = new Map<HoursMetric, HoursMeasure>();
  private unitReader: UnitReader | null = null;

  registerRatings(reader: RatingSourceReader): void {
    if (this.ratingSources.has(reader.source))
      throw new Error(`Rating source ${reader.source} is registered twice`);
    this.ratingSources.set(reader.source, reader);
  }

  /**
   * What counts towards a rule. `repeated_low_ratings` is read from the
   * rating sources; the other two take one reader per domain, by name.
   */
  registerEvents(
    code: Exclude<SignalCode, 'repeated_low_ratings'>,
    name: string,
    reader: EventReader,
  ): void {
    const list = this.events.get(code) ?? [];
    if (list.some(([n]) => n === name))
      throw new Error(`Events ${code}/${name} are registered twice`);
    list.push([name, reader]);
    this.events.set(code, list);
  }

  registerMeasure(metric: HoursMetric, measure: HoursMeasure): void {
    if (this.measures.has(metric))
      throw new Error(`Measure ${metric} is registered twice`);
    this.measures.set(metric, measure);
  }

  /** Community's units (one reader). */
  registerUnits(reader: UnitReader): void {
    if (this.unitReader) throw new Error('Units are registered twice');
    this.unitReader = reader;
  }

  /** In RATING_SOURCES order. */
  ratingReaders(): RatingSourceReader[] {
    return RATING_SOURCES.flatMap((s) => {
      const r = this.ratingSources.get(s);
      return r ? [r] : [];
    });
  }

  async ratings(
    tx: TenantTxClient,
    from: Date,
    to: Date,
  ): Promise<RatingRow[]> {
    const rows: RatingRow[] = [];
    for (const r of this.ratingReaders())
      rows.push(...(await r.ratings(tx, from, to)));
    return rows;
  }

  /** The rule's events since `since`, from every domain that registered. */
  async eventsOf(
    tx: TenantTxClient,
    code: SignalCode,
    since: Date,
    until: Date,
  ): Promise<ExperienceEvent[]> {
    if (code === 'repeated_low_ratings')
      return (await this.ratings(tx, since, until))
        .filter((r) => r.rating <= 2 && r.unitId !== null)
        .map((r) => ({ unitId: r.unitId!, itemId: r.itemId, at: r.ratedAt }));
    const out: ExperienceEvent[] = [];
    for (const [, reader] of this.events.get(code) ?? [])
      out.push(...(await reader(tx, since)));
    return out.filter((e) => e.at < until);
  }

  measure(metric: HoursMetric): HoursMeasure | null {
    return this.measures.get(metric) ?? null;
  }

  units(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, UnitLabel>> {
    if (!this.unitReader) throw new Error('No unit reader is registered');
    if (!unitIds.length) return Promise.resolve(new Map<string, UnitLabel>());
    return this.unitReader(tx, [...new Set(unitIds)]);
  }

  /** What is missing (checked at bootstrap). */
  missing(): string[] {
    return [
      ...RATING_SOURCES.filter((s) => !this.ratingSources.has(s)).map(
        (s) => `ratings:${s}`,
      ),
      ...(['reopened_tickets', 'repeated_complaints'] as const)
        .filter((c) => !this.events.get(c)?.length)
        .map((c) => `events:${c}`),
      ...HOURS_METRICS.filter((m) => !this.measures.has(m)).map(
        (m) => `measure:${m}`,
      ),
      ...(this.unitReader ? [] : ['units']),
    ];
  }
}
