import type { PartnerRequest } from '@prisma/client';
import { currentVersion } from '../../core/consents/consent-catalog';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { PartnerCategory } from '../categories';
import { partnerConsent } from '../consents';

/**
 * The requests whose requester still grants the category's consent at its
 * current version, read now (ADR 0036: readers check at read time). A
 * partner's desk and the relay show the rest with nothing of the requester
 * and act on none of them. One query for a page.
 */
export async function consentedRequests(
  tx: TenantTxClient,
  rows: readonly Pick<PartnerRequest, 'id' | 'requesterId' | 'category'>[],
): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const codes = [
    ...new Set(rows.map((r) => partnerConsent(r.category as PartnerCategory))),
  ];
  const granted = await tx.accountConsent.findMany({
    where: {
      accountId: { in: [...new Set(rows.map((r) => r.requesterId))] },
      code: { in: codes },
    },
    select: { accountId: true, code: true, grantedVersion: true },
  });
  const ok = new Set(
    granted
      .filter(
        (g) =>
          g.grantedVersion !== null &&
          g.grantedVersion ===
            currentVersion(g.code as ReturnType<typeof partnerConsent>),
      )
      .map((g) => `${g.accountId}:${g.code}`),
  );
  return new Set(
    rows
      .filter((r) =>
        ok.has(
          `${r.requesterId}:${partnerConsent(r.category as PartnerCategory)}`,
        ),
      )
      .map((r) => r.id),
  );
}
