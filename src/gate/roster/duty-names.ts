import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { PlaceView } from '../places/views/place.views';

/** What the guards' duty views name (ADR 0050): people, gates and zones. */
export interface DutyNames {
  people: Map<string, { id: string; fullName: string | null; status: string }>;
  gates: Map<string, string>;
  zones: Map<string, PlaceView>;
}

/** Reads the names a set of rows needs, one query per kind. */
@Injectable()
export class DutyNamesReader {
  async read(
    tx: TenantTxClient,
    accountIds: readonly (string | null)[],
    posts: readonly { gateId: string | null; placeId: string | null }[],
  ): Promise<DutyNames> {
    const people = [
      ...new Set(accountIds.filter((id): id is string => id !== null)),
    ];
    const gateIds = [
      ...new Set(posts.flatMap((r) => (r.gateId ? [r.gateId] : []))),
    ];
    const placeIds = [
      ...new Set(posts.flatMap((r) => (r.placeId ? [r.placeId] : []))),
    ];
    const accounts = people.length
      ? await tx.account.findMany({
          where: { id: { in: people } },
          select: { id: true, fullName: true, status: true },
        })
      : [];
    const gates = gateIds.length
      ? await tx.gate.findMany({
          where: { id: { in: gateIds } },
          select: { id: true, name: true },
        })
      : [];
    const zones = placeIds.length
      ? await tx.place.findMany({ where: { id: { in: placeIds } } })
      : [];
    return {
      people: new Map(accounts.map((a) => [a.id, a])),
      gates: new Map(gates.map((g) => [g.id, g.name])),
      zones: new Map(zones.map((z) => [z.id, PlaceView.from(z)])),
    };
  }
}
