import { randomInt } from 'node:crypto';
import type { AccountType } from '@prisma/client';
import { newId } from '../../src/common/uuid';
import type { DbHarness } from './db-module';

/** Unique per call, so suites never collide on unique constraints. */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomInt(1e9).toString(36)}`;
}

export async function createTenant(
  h: DbHarness,
  name: string,
): Promise<string> {
  const id = newId();
  await h.globalDb.tenant.create({
    data: { id, name: `${name} ${uniqueSuffix()}` },
  });
  return id;
}

export function createUnit(h: DbHarness, tenantId: string, code?: string) {
  return h.asTenant(tenantId, () =>
    h.prisma.tenant.unit.create({
      data: { id: newId(), tenantId, code: code ?? `U-${uniqueSuffix()}` },
    }),
  );
}

export function createAccountRow(
  h: DbHarness,
  tenantId: string,
  type: AccountType = 'resident',
) {
  const s = uniqueSuffix();
  return h.asTenant(tenantId, () =>
    h.prisma.tenant.account.create({
      data: {
        id: newId(),
        tenantId,
        type,
        fullName: `Person ${s}`,
        nationalId: `2900101${randomInt(1e7).toString().padStart(7, '0')}`,
        phone: `+2010${randomInt(1e8).toString().padStart(8, '0')}`,
        email: `p-${s}@example.test`,
      },
    }),
  );
}
