import type { UnitEntry } from '@prisma/client';

export const ENTRY_NOTE = { min: 1, max: 2000 } as const;
/** Witnesses besides whoever records the entry: one at least (two staff). */
export const ENTRY_WITNESSES = { min: 1, max: 3 } as const;
export const ENTRY_PHOTOS = { before: 5, after: 5 } as const;

/** An entry's reference: `UE-` and its number. */
export const entryReference = (n: number) => `UE-${String(n).padStart(6, '0')}`;

export interface EntryPhoto {
  stage: 'before' | 'after';
  url: string;
  expiresAt: Date;
}

/** An entry with what the reader may see of it. */
export interface EntryRead {
  entry: UnitEntry;
  unitCode: string;
  witnessCount: number;
  photos: EntryPhoto[];
  /** The staff's names, for the staff only; empty for the unit's side. */
  recordedByName: string | null;
  witnessNames: (string | null)[];
}
