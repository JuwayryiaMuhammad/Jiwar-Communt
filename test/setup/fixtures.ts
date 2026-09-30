import { randomInt } from 'node:crypto';
import type { AccountType } from '@prisma/client';
import { CODE_ACCESS_CATALOG } from '../../src/core/access/access-catalog';
import { RoleProvisioner } from '../../src/core/access/role-provisioner';
import { egyptToday } from '../../src/core/common/egyptian-national-id';
import { newId } from '../../src/core/common/uuid';
import type { DbHarness } from './db-module';

const provisioner = new RoleProvisioner(CODE_ACCESS_CATALOG);

/**
 * A valid Egyptian national ID for someone born on `birthDate` (default
 * 1990-01-01, an adult): the right century digit, Cairo as governorate, and a
 * random sequence so values differ between calls.
 */
export function nationalIdFor(
  birthDate: Date = new Date(Date.UTC(1990, 0, 1)),
): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const year = birthDate.getUTCFullYear();
  return [
    year >= 2000 ? '3' : '2',
    pad(year % 100),
    pad(birthDate.getUTCMonth() + 1),
    pad(birthDate.getUTCDate()),
    '01',
    pad(randomInt(1e4), 4),
    String(randomInt(10)),
  ].join('');
}

/** Egypt's calendar date `years` years (and `days` days) before today. */
export function bornYearsAgo(years: number, days = 0): Date {
  const today = egyptToday();
  return new Date(
    Date.UTC(
      today.getUTCFullYear() - years,
      today.getUTCMonth(),
      today.getUTCDate() - days,
    ),
  );
}

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
  // Every compound has its default roles (ADR 0010).
  await h.asTenant(id, () =>
    h.tenantTx.withTenantTx(async (tx) => {
      await provisioner.provision(tx, id);
      await tx.tenantSettings.create({ data: { tenantId: id } });
    }),
  );
  return id;
}

/** The id of a tenant's system role, e.g. `roleId(h, t, 'resident')`. */
export async function roleId(
  h: DbHarness,
  tenantId: string,
  key: string,
): Promise<string> {
  const role = await h.asTenant(tenantId, () =>
    h.prisma.tenant.role.findUniqueOrThrow({
      where: { tenantId_key: { tenantId, key } },
    }),
  );
  return role.id;
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
  return h.asTenant(tenantId, async () =>
    h.prisma.tenant.account.create({
      data: {
        id: newId(),
        tenantId,
        type,
        roleId: await roleId(h, tenantId, type),
        fullName: `Person ${s}`,
        idDocumentNumber: nationalIdFor(),
        birthDate: new Date(Date.UTC(1990, 0, 1)),
        phone: `+2010${randomInt(1e8).toString().padStart(8, '0')}`,
        email: `p-${s}@example.test`,
      },
    }),
  );
}

/** A valid reason for ending an occupancy (Phase 2.2 reason codes). */
export const MOVED_OUT = { code: 'moved_out', text: 'Moved out' } as const;

/** 'resolved', or the error code a call failed with (or its message). */
export function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'resolved',
    (e: { response?: { code?: string }; message?: string }) =>
      e.response?.code ?? e.message ?? 'rejected',
  );
}
