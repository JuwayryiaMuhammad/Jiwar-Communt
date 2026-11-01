import { Injectable } from '@nestjs/common';
import type { Permission } from '../access/permissions';
import type { TenantTxClient } from '../database/tenant-tx.service';
import type { ItemQuery } from '../resident-items/resident-items';

/** What the staff's search finds (ADR 0072), one kind a source. */
export const STAFF_SEARCH_TYPES = [
  'unit',
  'building',
  'resident',
  'staff',
  'ticket',
  'asset',
] as const;
export type StaffSearchType = (typeof STAFF_SEARCH_TYPES)[number];

/**
 * A hit: what it is, its id for the page it opens, and the words that
 * name it — a code, a name, a reference — never anything more.
 */
export interface StaffSearchHit {
  type: StaffSearchType;
  id: string;
  title: string;
  subtitle: string | null;
}

export interface StaffSearchSource {
  type: StaffSearchType;
  /** The caller holds any of these, or the source is skipped. */
  permissions: readonly Permission[];
  /** At most `take` hits, best first, read under the caller's RLS. */
  search(
    tx: TenantTxClient,
    q: ItemQuery,
    take: number,
  ): Promise<StaffSearchHit[]>;
}

/**
 * The registry of the staff's search sources (ADR 0072), modelled on the
 * residents' (ADR 0058): each domain registers its own at startup, so core
 * searches units, people, tickets and assets without importing anyone.
 * Each source answers only to a caller holding its list route's permission.
 */
@Injectable()
export class StaffSearch {
  private readonly sources = new Map<StaffSearchType, StaffSearchSource>();

  register(source: StaffSearchSource): void {
    if (this.sources.has(source.type))
      throw new Error(`Staff search source ${source.type} registered twice`);
    this.sources.set(source.type, source);
  }

  all(): StaffSearchSource[] {
    return STAFF_SEARCH_TYPES.flatMap((t) => {
      const s = this.sources.get(t);
      return s ? [s] : [];
    });
  }

  /** The types no source registered (checked at bootstrap). */
  missing(): StaffSearchType[] {
    return STAFF_SEARCH_TYPES.filter((t) => !this.sources.has(t));
  }
}
