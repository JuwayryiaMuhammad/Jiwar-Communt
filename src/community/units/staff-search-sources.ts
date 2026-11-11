import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AccountType } from '@prisma/client';
import { accountTextFilter } from '../../core/accounts/account-search';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { ItemQuery } from '../../core/resident-items/resident-items';
import {
  StaffSearch,
  type StaffSearchHit,
} from '../../core/staff-search/staff-search';

/**
 * The community's sources of the staff's search (ADR 0072): units by code,
 * buildings by name — for whoever lists units — and people by name, or by
 * exactly their phone or email, for whoever lists them. A hit names the
 * person and nothing more; an erased account is never found.
 */
@Injectable()
export class CommunityStaffSearchSources implements OnModuleInit {
  constructor(private readonly search: StaffSearch) {}

  onModuleInit(): void {
    this.search.register({
      type: 'unit',
      permissions: ['units.manage', 'units.directory'],
      search: async (tx, q, take) =>
        (
          await tx.unit.findMany({
            where: { code: { contains: q.text, mode: 'insensitive' } },
            orderBy: [{ code: 'asc' }, { id: 'asc' }],
            take,
            select: { id: true, code: true, building: true },
          })
        ).map((u) => ({
          type: 'unit' as const,
          id: u.id,
          title: u.code,
          subtitle: u.building,
        })),
    });
    this.search.register({
      type: 'building',
      permissions: ['units.manage', 'units.directory'],
      search: async (tx, q, take) =>
        (
          await tx.building.findMany({
            where: { name: { contains: q.text, mode: 'insensitive' } },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take,
          })
        ).map((b) => ({
          type: 'building' as const,
          id: b.id,
          title: b.name,
          subtitle: null,
        })),
    });
    this.search.register({
      type: 'resident',
      permissions: ['residents.read'],
      search: (tx, q, take) =>
        people(tx, q, take, ['resident', 'family'], 'resident'),
    });
    this.search.register({
      type: 'staff',
      permissions: ['accounts.read'],
      search: (tx, q, take) => people(tx, q, take, ['staff'], 'staff'),
    });
  }
}

async function people(
  tx: TenantTxClient,
  q: ItemQuery,
  take: number,
  types: AccountType[],
  hit: 'resident' | 'staff',
): Promise<StaffSearchHit[]> {
  const rows = await tx.account.findMany({
    where: { type: { in: types }, ...accountTextFilter(q.text) },
    orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    take,
    select: { id: true, fullName: true },
  });
  return rows.map((a) => ({
    type: hit,
    id: a.id,
    title: a.fullName ?? '',
    subtitle: null,
  }));
}
