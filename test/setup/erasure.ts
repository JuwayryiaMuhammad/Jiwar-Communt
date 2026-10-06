import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { newId } from '../../src/core/common/uuid';
import { communityHelpers, type Compound } from './community';
import type { HttpHarness } from './http-app';

/**
 * Erases an account now, as staff would after its grace (ADR 0023): a
 * deletion request already past grace is written directly (a test-only
 * shortcut through time), then erased through the real service.
 */
export async function eraseNow(
  h: HttpHarness,
  c: Compound,
  accountId: string,
): Promise<string> {
  const x = communityHelpers(h);
  const id = newId();
  await x.asManager(c, () =>
    x.prisma.tenant.accountDeletionRequest.create({
      data: {
        id,
        tenantId: c.tenantId,
        accountId,
        requestedById: accountId,
        requestedAt: new Date(Date.now() - 31 * 86_400_000),
        effectiveAt: new Date(Date.now() - 86_400_000),
      },
    }),
  );
  await x.asManager(c, () =>
    h.moduleRef.get(AccountDeletionService).erase(id, scopePhrase(accountId)),
  );
  return id;
}
