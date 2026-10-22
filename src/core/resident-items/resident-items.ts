import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

/**
 * What a resident's lists are made of (ADR 0058): one row per thing they
 * asked for, appealed, or may look up. Codes and references only: never a
 * text anyone wrote.
 */
export const RESIDENT_ITEM_TYPES = [
  // What the resident asked for (`GET /me/requests`).
  'maintenance',
  'management',
  'invoice_dispute',
  'unit_permit',
  'neighbour_complaint',
  // Appeals (`GET /me/appeals`).
  'vehicle_fine',
  'unit_violation',
  'board_appeal',
  // Found by the search alone.
  'invoice',
  'booking',
  'parcel',
] as const;
export type ResidentItemType = (typeof RESIDENT_ITEM_TYPES)[number];

export type ResidentItemGroup = 'request' | 'appeal';

export interface ResidentItem {
  type: ResidentItemType;
  id: string;
  /** Its reference as the domain shows it (`MT-000123`), or null. */
  number: string | null;
  /** The item's own status, a code of its domain. */
  status: string;
  /** The last thing that happened to it: the lists' order. */
  lastActivityAt: Date;
  unitId: string | null;
  /** A code that says what it is within its type (a permit's or appeal's kind). */
  kind: string | null;
  /** A ticket's category key. */
  categoryKey: string | null;
  /** A management request's topic key and type. */
  topicKey: string | null;
  requestType: string | null;
  /** Where its appeal stands (`GET /me/appeals`); null elsewhere. */
  appeal: ItemAppeal | null;
}

/** An appeal's state, the same codes for every kind (ADR 0058). */
export const APPEAL_STATES = [
  'pending',
  'upheld',
  'overturned',
  'withdrawn',
] as const;
export type AppealState = (typeof APPEAL_STATES)[number];

export interface ItemAppeal {
  /** `upheld`: the decision stands; `overturned`: the appellant won. */
  state: AppealState;
  at: Date;
  /** Who decides it, or decided it: the management or the owners' board. */
  decidedBy: 'management' | 'board';
  decidedAt: Date | null;
}

export interface ItemCursor {
  at: Date;
  id: string;
}

/**
 * Open items, or finished ones (the archive), or both; each source says
 * which of its statuses are finished.
 */
export type ItemState = 'open' | 'closed';

/**
 * The caller's role permissions, read once before the transaction (a
 * permission's first read loads the role, outside any transaction).
 */
export interface ItemCaller {
  holds(permission: string): boolean;
}

export interface PageRequest {
  after: ItemCursor | null;
  take: number;
  state: ItemState | null;
  caller: ItemCaller;
}

/**
 * The search's text (ADR 0058): a reference (`MT-000123`, `mt123`, `123`)
 * read as an optional prefix and a number, or else words matched against
 * the names the compound wrote (a category, a topic, a facility).
 */
export interface ItemQuery {
  text: string;
  prefix: string | null;
  number: number | null;
}

export interface ResidentItemSource {
  type: ResidentItemType;
  /** The list it is part of; null: the search finds it, no list shows it. */
  group: ResidentItemGroup | null;
  /**
   * Newest activity first, strictly past `after`, at most `take`: the
   * items the caller sees by the domain's own rule, as its list route.
   */
  page?: (tx: TenantTxClient, q: PageRequest) => Promise<ResidentItem[]>;
  /** The caller's items matching the query, newest first, at most `take`. */
  search?: (
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
    caller: ItemCaller,
  ) => Promise<ResidentItem[]>;
}

/**
 * What a resident may ask the management to release (ADR 0058): a ticket
 * on hold, a stopped work permit, and the unit's credit awaiting a refund
 * (the one held money there is).
 */
export const HOLD_TYPES = [
  'maintenance',
  'unit_permit',
  'unit_credit',
] as const;
export type HoldType = (typeof HOLD_TYPES)[number];

/** A held item the caller sees: its unit and why it is held (a code). */
export interface HeldItem {
  unitId: string | null;
  reasonCode: string;
}

/**
 * The item `id`, if the caller sees it by its domain's rule and it is held
 * now; null otherwise (the one not-found).
 */
export type HoldReader = (
  tx: TenantTxClient,
  id: string,
) => Promise<HeldItem | null>;

/**
 * The registry of resident item sources (ADR 0058), modelled on
 * `ExportSections` and `BoardMatters`: each domain registers its own at
 * startup, so core lists what finance and governance hold without anyone
 * importing them. Every source reads inside the caller's tenant
 * transaction (RLS) and applies the visibility of its own list route.
 */
@Injectable()
export class ResidentItems {
  private readonly sources = new Map<ResidentItemType, ResidentItemSource>();
  private readonly holds = new Map<HoldType, HoldReader>();

  registerHold(type: HoldType, reader: HoldReader): void {
    if (this.holds.has(type))
      throw new Error(`Hold reader ${type} registered twice`);
    this.holds.set(type, reader);
  }

  hold(type: HoldType): HoldReader {
    const reader = this.holds.get(type);
    if (!reader) throw new Error(`No hold reader for ${type}`);
    return reader;
  }

  register(source: ResidentItemSource): void {
    if (this.sources.has(source.type))
      throw new Error(`Resident item source ${source.type} registered twice`);
    this.sources.set(source.type, source);
  }

  of(group: ResidentItemGroup): ResidentItemSource[] {
    return [...this.sources.values()].filter(
      (s) => s.group === group && s.page,
    );
  }

  searchable(): ResidentItemSource[] {
    return [...this.sources.values()].filter((s) => s.search);
  }

  /** The types no source or hold reader registered (checked at bootstrap). */
  missing(): string[] {
    return [
      ...RESIDENT_ITEM_TYPES.filter((t) => !this.sources.has(t)),
      ...HOLD_TYPES.filter((t) => !this.holds.has(t)).map((t) => `hold:${t}`),
    ];
  }
}

/** Newest first: time, then id, both descending (the database's order). */
export function byActivity(a: ResidentItem, b: ResidentItem): number {
  return (
    b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
    (a.id < b.id ? 1 : -1)
  );
}

/**
 * A source's "strictly past the cursor" on its own activity column, as a
 * Prisma condition: (at, id) below the cursor's.
 */
export function pastCursor<F extends string>(
  field: F,
  after: ItemCursor | null,
): object[] {
  if (!after) return [];
  return [
    {
      OR: [
        { [field]: { lt: after.at } },
        { [field]: after.at, id: { lt: after.id } },
      ],
    },
  ];
}

/** A status filter for a state, given a source's finished statuses. */
export function stateWhere<S extends string>(
  field: string,
  state: ItemState | null,
  finished: readonly S[],
): object[] {
  if (!state) return [];
  return [
    state === 'closed'
      ? { [field]: { in: finished } }
      : { [field]: { notIn: finished } },
  ];
}

/** Whether a query names this source's reference prefix (or none). */
export function wantsNumber(q: ItemQuery, ...prefixes: string[]): boolean {
  return (
    q.number !== null && (q.prefix === null || prefixes.includes(q.prefix))
  );
}

const REFERENCE = /^([A-Za-z]{1,3})?\s*-?\s*0*(\d{1,9})$/;

export function parseItemQuery(raw: string): ItemQuery {
  const text = raw.trim();
  const m = REFERENCE.exec(text);
  return m
    ? {
        text,
        prefix: m[1] ? m[1].toUpperCase() : null,
        number: Number(m[2]),
      }
    : { text, prefix: null, number: null };
}
