import { randomInt } from 'node:crypto';
import type { AccountType } from '@prisma/client';
import { CODE_ACCESS_CATALOG } from '../../src/core/access/access-catalog';
import { RoleProvisioner } from '../../src/core/access/role-provisioner';
import { egyptToday } from '../../src/core/common/egyptian-national-id';
import { newId } from '../../src/core/common/uuid';
import { TenantLifecycle } from '../../src/core/tenant-settings/tenant-lifecycle';
import { MaintenanceProvisioning } from '../../src/maintenance/provisioning';
import type { DbHarness } from './db-module';
import { suiteSequence } from './id-blocks';

const provisioner = new RoleProvisioner(CODE_ACCESS_CATALOG);
const maintenance = new MaintenanceProvisioning(new TenantLifecycle());

/** 29 governorates x 100,000 sequences; 1,000 per suite. */
const NATIONAL_ID_SPACE = 29 * 1e5;
const nationalIdSequence = suiteSequence(NATIONAL_ID_SPACE, 1e3);
// prettier-ignore
const GOVERNORATES = [
  '01', '02', '03', '04', '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '23', '24', '25', '26', '27', '28', '29', '31', '32', '33', '34', '35',
  '88',
];

/** A fresh, valid Egyptian mobile number in E.164, never repeated in a run. */
const phoneSequence = suiteSequence(1e8, 1e5);
export function uniquePhone(): string {
  return `+2010${phoneSequence().toString().padStart(8, '0')}`;
}

/** The digits after 7400 of a UK mobile, never repeated in a run. */
const ukSequence = suiteSequence(1e6, 1e3);
export function uniqueUkDigits(): string {
  return ukSequence().toString().padStart(6, '0');
}

/**
 * A valid Egyptian national ID for someone born on `birthDate` (default
 * 1990-01-01, an adult): the right century digit, and a governorate and
 * sequence that never repeat within a run, whatever the birth date.
 */
export function nationalIdFor(
  birthDate: Date = new Date(Date.UTC(1990, 0, 1)),
): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const year = birthDate.getUTCFullYear();
  const sequence = nationalIdSequence();
  return [
    year >= 2000 ? '3' : '2',
    pad(year % 100),
    pad(birthDate.getUTCMonth() + 1),
    pad(birthDate.getUTCDate()),
    GOVERNORATES[Math.floor(sequence / 1e5)],
    pad(Math.floor((sequence % 1e5) / 10), 4),
    String(sequence % 10),
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
      await maintenance.provision(tx, id);
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

/** The default role of each account type (ADR 0010, 0028). */
const DEFAULT_ROLE_KEY: Record<AccountType, string> = {
  manager: 'manager',
  resident: 'resident',
  family: 'family_member',
  staff: 'guard',
};

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
        roleId: await roleId(h, tenantId, DEFAULT_ROLE_KEY[type]),
        fullName: `Person ${s}`,
        idDocumentNumber: nationalIdFor(),
        birthDate: new Date(Date.UTC(1990, 0, 1)),
        phone: uniquePhone(),
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
