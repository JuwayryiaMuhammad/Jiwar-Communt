import { Client } from 'pg';
import {
  TenantClientMisuseError,
  TenantContextMissingError,
} from '../../src/core/common/errors';
import { newId } from '../../src/core/common/uuid';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import {
  createAccountRow,
  createTenant,
  createUnit,
  roleId,
  uniqueSuffix,
} from '../setup/fixtures';

/**
 * Exit criteria 1–5 (ADR 0005), at the database/service level, against real
 * Postgres, connected as jiwar_app. The HTTP-level versions live in
 * http-isolation.e2e-spec.ts.
 */
describe('RLS tenant isolation (database level)', () => {
  let h: DbHarness;
  let tenantA: string;
  let tenantB: string;
  let unitA: { id: string };
  let accountA: { id: string };
  let residentRoleB: string;

  /** A plain pg connection as the runtime role, outside Prisma entirely. */
  async function rawAppClient(): Promise<Client> {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    return c;
  }

  beforeAll(async () => {
    h = await createDbHarness();
    tenantA = await createTenant(h, 'Compound A');
    tenantB = await createTenant(h, 'Compound B');
    unitA = await createUnit(h, tenantA);
    await createUnit(h, tenantB);
    accountA = await createAccountRow(h, tenantA);
    residentRoleB = await roleId(h, tenantB, 'resident');
    await createAccountRow(h, tenantB);
  });

  afterAll(() => h.close());

  // --------------------------------------------------------------------------
  describe('1. tenant B cannot list or fetch tenant A rows', () => {
    it('lists only its own units and accounts', async () => {
      const [units, accounts] = await h.asTenant(tenantB, () =>
        Promise.all([
          h.prisma.tenant.unit.findMany(),
          h.prisma.tenant.account.findMany(),
        ]),
      );
      expect(units.length).toBeGreaterThan(0);
      expect(accounts.length).toBeGreaterThan(0);
      expect(units.every((u) => u.tenantId === tenantB)).toBe(true);
      expect(accounts.every((a) => a.tenantId === tenantB)).toBe(true);
    });

    it("gets nothing when fetching A's rows by id", async () => {
      const [unit, account] = await h.asTenant(tenantB, () =>
        Promise.all([
          h.prisma.tenant.unit.findUnique({ where: { id: unitA.id } }),
          h.prisma.tenant.account.findUnique({ where: { id: accountA.id } }),
        ]),
      );
      expect(unit).toBeNull();
      expect(account).toBeNull();
    });

    it("cannot update or delete A's rows", async () => {
      const [updated, deleted] = await h.asTenant(tenantB, () =>
        Promise.all([
          h.prisma.tenant.unit.updateMany({
            where: { id: unitA.id },
            data: { building: 'hijacked' },
          }),
          h.prisma.tenant.unit.deleteMany({ where: { id: unitA.id } }),
        ]),
      );
      expect(updated.count).toBe(0);
      expect(deleted.count).toBe(0);
      const stillThere = await h.asTenant(tenantA, () =>
        h.prisma.tenant.unit.findUnique({ where: { id: unitA.id } }),
      );
      expect(stillThere?.building).toBeNull();
    });

    it('scopes raw SQL inside withTenantTx', async () => {
      const rows = await h.asTenant(tenantB, () =>
        h.tenantTx.withTenantTx(
          (tx) =>
            tx.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM units`,
        ),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === tenantB)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  describe('1b. Phase 1a tenant tables are isolated too', () => {
    let occupancyA: { id: string };
    let managerRoleA: string;

    beforeAll(async () => {
      managerRoleA = await roleId(h, tenantA, 'manager');
      occupancyA = await h.asTenant(tenantA, () =>
        h.prisma.tenant.unitOccupancy.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            unitId: unitA.id,
            accountId: accountA.id,
            occupancyType: 'owner',
            createdById: accountA.id,
          },
        }),
      );
    });

    it('B sees only its own roles, role permissions and catalog', async () => {
      const [roles, perms, catalog] = await h.asTenant(tenantB, () =>
        Promise.all([
          h.prisma.tenant.role.findMany(),
          h.prisma.tenant.rolePermission.findMany(),
          h.prisma.tenant.tenantPermissionCatalog.findMany(),
        ]),
      );
      for (const rows of [roles, perms, catalog]) {
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.tenantId === tenantB)).toBe(true);
      }
    });

    it("B cannot fetch A's role, its permissions or A's occupancy", async () => {
      const [role, perms, occupancy, occupancies] = await h.asTenant(
        tenantB,
        () =>
          Promise.all([
            h.prisma.tenant.role.findUnique({ where: { id: managerRoleA } }),
            h.prisma.tenant.rolePermission.findMany({
              where: { roleId: managerRoleA },
            }),
            h.prisma.tenant.unitOccupancy.findUnique({
              where: { id: occupancyA.id },
            }),
            h.prisma.tenant.unitOccupancy.findMany(),
          ]),
      );
      expect(role).toBeNull();
      expect(perms).toEqual([]);
      expect(occupancy).toBeNull();
      expect(occupancies.every((o) => o.tenantId === tenantB)).toBe(true);
    });

    it("B cannot edit A's role permissions", async () => {
      const removed = await h.asTenant(tenantB, () =>
        h.prisma.tenant.rolePermission.deleteMany({
          where: { roleId: managerRoleA },
        }),
      );
      expect(removed.count).toBe(0);
    });

    it("writing another tenant's tenant_id is rejected on every new table", async () => {
      const attempts: (() => Promise<unknown>)[] = [
        () =>
          h.prisma.tenant.role.create({
            data: {
              id: newId(),
              tenantId: tenantB,
              key: `x-${uniqueSuffix()}`,
              kind: 'resident',
            },
          }),
        () =>
          h.prisma.tenant.tenantPermissionCatalog.create({
            data: { tenantId: tenantB, permission: `x.${uniqueSuffix()}` },
          }),
        () =>
          h.prisma.tenant.rolePermission.create({
            data: {
              tenantId: tenantB,
              roleId: residentRoleB,
              permission: 'units.read2',
            },
          }),
        () =>
          h.prisma.tenant.unitOccupancy.create({
            data: {
              id: newId(),
              tenantId: tenantB,
              unitId: unitA.id,
              accountId: accountA.id,
              occupancyType: 'tenant',
              createdById: accountA.id,
            },
          }),
      ];
      for (const attempt of attempts) {
        await expect(h.asTenant(tenantA, attempt)).rejects.toThrow(
          /row-level security/,
        );
      }
    });

    it("composite keys stop links to another tenant's rows (FK checks bypass RLS)", async () => {
      // An account in A pointing at B's resident role.
      await expect(
        h.asTenant(tenantA, () =>
          h.prisma.tenant.account.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              type: 'resident',
              roleId: residentRoleB,
              fullName: 'Cross link',
              nationalId: '29001010000001',
              phone: '+201000000011',
              email: `cross-${uniqueSuffix()}@example.test`,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });

      // An occupancy in A pointing at a unit of B.
      const unitOfB = await createUnit(h, tenantB);
      await expect(
        h.asTenant(tenantA, () =>
          h.prisma.tenant.unitOccupancy.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              unitId: unitOfB.id,
              accountId: accountA.id,
              occupancyType: 'owner',
              createdById: accountA.id,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('an account cannot hold a role of another kind', async () => {
      await expect(
        h.asTenant(tenantA, () =>
          h.prisma.tenant.account.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              type: 'resident',
              roleId: managerRoleA,
              fullName: 'Wrong kind',
              nationalId: '29001010000002',
              phone: '+201000000012',
              email: `kind-${uniqueSuffix()}@example.test`,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('only one active occupancy per unit and account; ended ones may repeat', async () => {
      const again = () =>
        h.asTenant(tenantA, () =>
          h.prisma.tenant.unitOccupancy.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              unitId: unitA.id,
              accountId: accountA.id,
              occupancyType: 'tenant',
              createdById: accountA.id,
            },
          }),
        );
      await expect(again()).rejects.toMatchObject({ code: 'P2002' });
      await h.asTenant(tenantA, () =>
        h.prisma.tenant.unitOccupancy.update({
          where: { id: occupancyA.id },
          data: { status: 'ended', endedAt: new Date() },
        }),
      );
      await expect(again()).resolves.toMatchObject({ status: 'active' });
    });

    it("B cannot read A's audit entries, even by target id; nor write into A", async () => {
      const entryId = newId();
      await h.asTenant(tenantA, () =>
        h.prisma.tenant.auditLog.create({
          data: {
            id: entryId,
            tenantId: tenantA,
            actorType: 'system',
            action: 'unit.created',
            targetType: 'unit',
            targetId: unitA.id,
          },
        }),
      );
      const [byId, byTarget, all] = await h.asTenant(tenantB, () =>
        Promise.all([
          h.prisma.tenant.auditLog.findUnique({ where: { id: entryId } }),
          h.prisma.tenant.auditLog.findMany({ where: { targetId: unitA.id } }),
          h.prisma.tenant.auditLog.findMany(),
        ]),
      );
      expect(byId).toBeNull();
      expect(byTarget).toEqual([]);
      expect(all.every((e) => e.tenantId === tenantB)).toBe(true);
      await expect(
        h.asTenant(tenantB, () =>
          h.prisma.tenant.auditLog.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              actorType: 'system',
              action: 'unit.created',
              targetType: 'unit',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('ended_at must match the status', async () => {
      await expect(
        h.asTenant(tenantA, () =>
          h.prisma.tenant.unitOccupancy.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              unitId: unitA.id,
              accountId: accountA.id,
              occupancyType: 'owner',
              status: 'ended',
              createdById: accountA.id,
            },
          }),
        ),
      ).rejects.toThrow(/ended_at_matches_status|check constraint/i);
    });
  });

  // --------------------------------------------------------------------------
  describe('2. no tenant in context', () => {
    it('the tenant client throws outside any request context', async () => {
      await expect(h.prisma.tenant.unit.findMany()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
    });

    it('the tenant client throws in a context without a tenant', async () => {
      await expect(
        h.cls.run(() => h.prisma.tenant.unit.findMany()),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
      await expect(
        h.cls.run(() => h.tenantTx.withTenantTx((tx) => tx.unit.findMany())),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
    });

    it('the database itself returns nothing and rejects writes', async () => {
      const c = await rawAppClient();
      try {
        const read = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM units',
        );
        expect(read.rows[0].n).toBe(0);
        const accounts = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM accounts',
        );
        expect(accounts.rows[0].n).toBe(0);

        await expect(
          c.query(
            'INSERT INTO units (id, tenant_id, code, updated_at) VALUES ($1, $2, $3, now())',
            [newId(), tenantA, `raw-${uniqueSuffix()}`],
          ),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await c.end();
      }
    });
  });

  // --------------------------------------------------------------------------
  describe("3. writing another tenant's tenant_id is rejected by WITH CHECK", () => {
    it('through the tenant client', async () => {
      await expect(
        h.asTenant(tenantA, () =>
          h.prisma.tenant.unit.create({
            data: {
              id: newId(),
              tenantId: tenantB,
              code: `x-${uniqueSuffix()}`,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('through withTenantTx', async () => {
      await expect(
        h.asTenant(tenantA, () =>
          h.tenantTx.withTenantTx((tx) =>
            tx.account.create({
              data: {
                id: newId(),
                tenantId: tenantB,
                type: 'resident',
                roleId: residentRoleB,
                fullName: 'Intruder',
                nationalId: '29001010000000',
                phone: '+201000000000',
                email: `intruder-${uniqueSuffix()}@example.test`,
              },
            }),
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('moving an own row into another tenant', async () => {
      await expect(
        h.asTenant(tenantA, () =>
          h.prisma.tenant.unit.update({
            where: { id: unitA.id },
            data: { tenantId: tenantB },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  // --------------------------------------------------------------------------
  describe('4. a single-connection pool never leaks a tenant', () => {
    let small: DbHarness;

    beforeAll(async () => {
      small = await createDbHarness({ poolMax: 1 });
      // A few more rows so a leak would show up as a foreign tenant id.
      await createUnit(small, tenantA);
      await createUnit(small, tenantB);
    });

    afterAll(() => small.close());

    it('200 interleaved A/B operations, mixing both access paths', async () => {
      const ops = Array.from({ length: 200 }, (_, i) => {
        const tenant = i % 2 === 0 ? tenantA : tenantB;
        const viaTx = i % 4 >= 2;
        return small.asTenant(tenant, async () => {
          if (!viaTx) {
            const units = await small.prisma.tenant.unit.findMany();
            return {
              tenant,
              tenantIds: units.map((u) => u.tenantId),
              setting: tenant,
            };
          }
          return small.tenantTx.withTenantTx(async (tx) => {
            const units = await tx.unit.findMany();
            const [row] = await tx.$queryRaw<{ value: string }[]>`
              SELECT current_setting('app.tenant_id', true) AS value`;
            return {
              tenant,
              tenantIds: units.map((u) => u.tenantId),
              setting: row.value,
            };
          });
        });
      });

      const results = await Promise.all(ops);
      for (const r of results) {
        expect(r.tenantIds.length).toBeGreaterThan(0);
        expect(r.tenantIds.every((t) => t === r.tenant)).toBe(true);
        expect(r.setting).toBe(r.tenant);
      }
      expect(await small.globalDb.leakedTenantSetting()).toBeNull();
    });

    it('the setting is gone after withTenantTx commits', async () => {
      await small.asTenant(tenantA, () =>
        small.tenantTx.withTenantTx((tx) => tx.unit.findMany()),
      );
      expect(await small.globalDb.leakedTenantSetting()).toBeNull();
    });

    it('the setting is gone after withTenantTx throws midway', async () => {
      await expect(
        small.asTenant(tenantA, () =>
          small.tenantTx.withTenantTx(async (tx) => {
            await tx.unit.findMany();
            throw new Error('boom');
          }),
        ),
      ).rejects.toThrow('boom');
      expect(await small.globalDb.leakedTenantSetting()).toBeNull();
    });

    it('the setting is gone after a failed tenant-client write', async () => {
      await expect(
        small.asTenant(tenantA, () =>
          small.prisma.tenant.unit.create({
            data: {
              id: newId(),
              tenantId: tenantB,
              code: `y-${uniqueSuffix()}`,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(await small.globalDb.leakedTenantSetting()).toBeNull();
    });

    describe('misuse guards (and none of them hangs the pool of one)', () => {
      it('$transaction and raw SQL are unavailable on the tenant client', () => {
        const client = small.prisma.tenant as unknown as Record<
          string,
          (...args: unknown[]) => unknown
        >;
        for (const member of [
          '$transaction',
          '$queryRaw',
          '$queryRawUnsafe',
          '$executeRaw',
          '$executeRawUnsafe',
        ]) {
          expect(() => client[member]([])).toThrow(TenantClientMisuseError);
        }
      });

      it('the tenant client refuses to run inside withTenantTx', async () => {
        await expect(
          small.asTenant(tenantA, () =>
            small.tenantTx.withTenantTx(() =>
              small.prisma.tenant.unit.findMany(),
            ),
          ),
        ).rejects.toBeInstanceOf(TenantClientMisuseError);
      });

      it('withTenantTx cannot be nested', async () => {
        await expect(
          small.asTenant(tenantA, () =>
            small.tenantTx.withTenantTx(() =>
              small.tenantTx.withTenantTx((tx) => tx.unit.findMany()),
            ),
          ),
        ).rejects.toBeInstanceOf(TenantClientMisuseError);
      });

      it('the pool is still usable afterwards', async () => {
        const units = await small.asTenant(tenantB, () =>
          small.prisma.tenant.unit.findMany(),
        );
        expect(units.every((u) => u.tenantId === tenantB)).toBe(true);
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('5. jiwar_app cannot bypass RLS', () => {
    let c: Client;

    beforeAll(async () => {
      c = await rawAppClient();
    });

    afterAll(() => c.end());

    it('is not a superuser and has no BYPASSRLS', async () => {
      const { rows } = await c.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('does not own the tables', async () => {
      const { rows } = await c.query<{ tablename: string; tableowner: string }>(
        `SELECT tablename, tableowner FROM pg_tables
          WHERE schemaname = 'public' AND tablename IN ('units', 'accounts')`,
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.tableowner).toBe('jiwar_migrator');
    });

    it.each([
      'ALTER TABLE units DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE units NO FORCE ROW LEVEL SECURITY',
      'DROP POLICY tenant_isolation ON units',
      'ALTER POLICY tenant_isolation ON units USING (true)',
    ])('cannot run: %s', async (sql) => {
      await expect(c.query(sql)).rejects.toThrow(/must be owner/);
    });

    it('cannot switch to the owner role', async () => {
      await expect(c.query('SET ROLE jiwar_migrator')).rejects.toThrow(
        /permission denied/,
      );
    });

    it('row_security = off raises instead of returning rows', async () => {
      await c.query('SET row_security = off');
      try {
        await expect(c.query('SELECT * FROM units')).rejects.toThrow(
          /row-level security/,
        );
      } finally {
        await c.query('RESET row_security');
      }
    });
  });
});
