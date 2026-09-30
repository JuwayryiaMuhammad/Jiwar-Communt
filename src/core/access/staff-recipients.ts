import { Injectable } from '@nestjs/common';
import type { Locale } from '@prisma/client';
import type { TenantTxClient } from '../database/tenant-tx.service';
import type { Permission } from './permissions';

export interface StaffRecipient {
  id: string;
  email: string;
  preferredLocale: Locale;
}

/**
 * Who in this compound holds a permission right now: active accounts whose
 * role carries it (ADR 0010). Used to tell "compliance", "management and
 * security" and the like, whatever roles a compound gives them. An empty
 * list is not an error: callers record the notice as undeliverable.
 */
@Injectable()
export class StaffRecipients {
  async holding(
    tx: TenantTxClient,
    permission: Permission,
  ): Promise<StaffRecipient[]> {
    const rows = await tx.account.findMany({
      where: {
        status: 'active',
        role: { permissions: { some: { permission } } },
      },
      select: { id: true, email: true, preferredLocale: true },
      orderBy: { id: 'asc' },
    });
    // An active account always has an email; erased ones are never active.
    return rows.flatMap((r) =>
      r.email
        ? [{ id: r.id, email: r.email, preferredLocale: r.preferredLocale }]
        : [],
    );
  }
}
