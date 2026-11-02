import { Injectable } from '@nestjs/common';
import type { Permission } from '../access/permissions';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// A unit's correspondence (ADR 0080)
// ============================================================================
//
// One timeline over what a unit's people and the management wrote each
// other, across the domains: requests and conversations, letters, the
// announcements put to the unit itself, neighbour complaints by and about
// it, formal notices, tickets. Core imports no domain (ADR 0015): each domain
// registers its source here at startup, as with StaffInbox and
// ResidentItems, and reads it in the caller's tenant transaction (RLS).
// Codes and references only: never a word anyone wrote, never a name.

export const CORRESPONDENCE_TYPES = [
  'management_request',
  'official_letter',
  'announcement',
  'neighbour_complaint',
  'formal_notice',
  'ticket',
] as const;
export type CorrespondenceType = (typeof CORRESPONDENCE_TYPES)[number];

/** Who wrote first: the unit's people, or the management (or another unit). */
export type Direction = 'from_unit' | 'to_unit';

export interface CorrespondenceRow {
  type: CorrespondenceType;
  id: string;
  /** Its reference as the domain shows it (`MR-000123`), or null. */
  number: string | null;
  /** What it is within its type (a topic's key, a letter's kind), or null. */
  kind: string | null;
  /** The domain's own status, or null for what has none. */
  status: string | null;
  direction: Direction;
  /** When it was written: the timeline's order, newest first. */
  at: Date;
}

export interface CorrespondenceCursor {
  at: Date;
  id: string;
}

export interface CorrespondenceSource {
  type: CorrespondenceType;
  /** Shown only to the holders of the permission of its own list. */
  permission: Permission;
  /** The unit's items, newest first, strictly before the cursor. */
  page(
    tx: TenantTxClient,
    unitId: string,
    q: { before: CorrespondenceCursor | null; take: number },
  ): Promise<CorrespondenceRow[]>;
}

/**
 * "Strictly before the cursor" in the timeline's order (newest first) on a
 * source's own column, as a Prisma condition.
 */
export function beforeCursor<F extends string>(
  field: F,
  before: CorrespondenceCursor | null,
): object[] {
  if (!before) return [];
  return [
    {
      OR: [
        { [field]: { lt: before.at } },
        { [field]: before.at, id: { lt: before.id } },
      ],
    },
  ];
}

/** Newest first, then by id descending: the order every source keeps. */
export function newestFirst(a: CorrespondenceRow, b: CorrespondenceRow) {
  return (
    b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

@Injectable()
export class UnitCorrespondence {
  private readonly sources = new Map<
    CorrespondenceType,
    CorrespondenceSource
  >();

  register(source: CorrespondenceSource): void {
    if (this.sources.has(source.type))
      throw new Error(`Correspondence source ${source.type} registered twice`);
    this.sources.set(source.type, source);
  }

  /** In CORRESPONDENCE_TYPES order. */
  all(): CorrespondenceSource[] {
    return CORRESPONDENCE_TYPES.flatMap((t) => {
      const s = this.sources.get(t);
      return s ? [s] : [];
    });
  }

  /** The types no domain registered (checked when the app starts). */
  missing(): CorrespondenceType[] {
    return CORRESPONDENCE_TYPES.filter((t) => !this.sources.has(t));
  }
}
