import { Prisma } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import {
  createAccountRow,
  createTenant,
  createUnit,
  uniqueSuffix,
} from '../setup/fixtures';

/**
 * Phase 2 tenant tables (ADR 0016, 0017): isolated exactly like the Phase 0
 * and 1a tables, linked with composite keys, and guarded by the constraints
 * the services rely on. The RLS coverage test checks the policies exist; this
 * suite checks they hold for every new table.
 */
describe('RLS isolation — household and worker tables', () => {
  let h: DbHarness;
  let tenantA: string;
  let tenantB: string;
  let unitA: { id: string };
  let unitB: { id: string };
  let ownerA: { id: string };
  let ownerB: { id: string };
  let familyA: { id: string };

  /** One row of every new tenant table, all in tenant A. */
  const rows = {} as {
    memberId: string;
    inviteId: string;
    delegationId: string;
    workerId: string;
    engagementId: string;
    noticeId: string;
  };

  const inYear = () => new Date(Date.now() + 30 * 86_400_000);

  beforeAll(async () => {
    h = await createDbHarness();
    tenantA = await createTenant(h, 'Household A');
    tenantB = await createTenant(h, 'Household B');
    unitA = await createUnit(h, tenantA);
    unitB = await createUnit(h, tenantB);
    ownerA = await createAccountRow(h, tenantA, 'resident');
    ownerB = await createAccountRow(h, tenantB, 'resident');
    // No family role until Phase 2 wiring; any adult account serves here.
    familyA = await createAccountRow(h, tenantA, 'resident');

    await h.asTenant(tenantA, async () => {
      const db = h.prisma.tenant;
      await db.tenantSettings.create({ data: { tenantId: tenantA } });
      rows.memberId = (
        await db.householdMember.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            unitId: unitA.id,
            accountId: familyA.id,
            relation: 'spouse',
            isMinor: false,
            birthDate: new Date('1990-01-01'),
            status: 'active',
            addedById: ownerA.id,
          },
        })
      ).id;
      rows.inviteId = (
        await db.householdInvite.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            unitId: unitA.id,
            invitedById: ownerA.id,
            fullName: 'Invited Person',
            phone: '+201000000099',
            email: `invited-${uniqueSuffix()}@example.test`,
            nationalId: '29001010100099',
            relation: 'sibling',
            tokenHash:
              'a'.repeat(48) + uniqueSuffix().padEnd(16, '0').slice(0, 16),
            expiresAt: inYear(),
          },
        })
      ).id;
      rows.delegationId = (
        await db.householdDelegation.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            unitId: unitA.id,
            delegatorAccountId: ownerA.id,
            delegateAccountId: familyA.id,
            scopes: ['household'],
            expiresAt: inYear(),
          },
        })
      ).id;
      rows.workerId = (
        await db.domesticWorker.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            nationalIdHash:
              'b'.repeat(48) + uniqueSuffix().padEnd(16, '0').slice(0, 16),
            nationalId: '29001010100098',
            fullName: 'Worker A',
            phone: '+201000000098',
            birthDate: new Date('1990-01-01'),
          },
        })
      ).id;
      rows.engagementId = (
        await db.workerEngagement.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            workerId: rows.workerId,
            unitId: unitA.id,
            requestedById: ownerA.id,
            capacity: 'hourly',
            schedule: { days: [1], windows: [{ from: '08:00', to: '12:00' }] },
          },
        })
      ).id;
      rows.noticeId = (
        await db.workerNotice.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            workerId: rows.workerId,
            engagementId: rows.engagementId,
            noticeKey: 'test',
            params: {},
          },
        })
      ).id;
    });
  });

  afterAll(() => h.close());

  // --------------------------------------------------------------------------
  describe('tenant B sees and changes none of A’s rows', () => {
    it('lists nothing of A on any new table', async () => {
      await h.asTenant(tenantB, async () => {
        const db = h.prisma.tenant;
        expect(await db.tenantSettings.findMany()).toEqual([]);
        expect(await db.householdMember.findMany()).toEqual([]);
        expect(await db.householdInvite.findMany()).toEqual([]);
        expect(await db.householdDelegation.findMany()).toEqual([]);
        expect(await db.domesticWorker.findMany()).toEqual([]);
        expect(await db.workerEngagement.findMany()).toEqual([]);
        expect(await db.workerNotice.findMany()).toEqual([]);
      });
    });

    it('gets nothing when fetching A’s rows by id', async () => {
      await h.asTenant(tenantB, async () => {
        const db = h.prisma.tenant;
        expect(
          await db.tenantSettings.findUnique({ where: { tenantId: tenantA } }),
        ).toBeNull();
        expect(
          await db.householdMember.findUnique({ where: { id: rows.memberId } }),
        ).toBeNull();
        expect(
          await db.householdInvite.findUnique({ where: { id: rows.inviteId } }),
        ).toBeNull();
        expect(
          await db.householdDelegation.findUnique({
            where: { id: rows.delegationId },
          }),
        ).toBeNull();
        expect(
          await db.domesticWorker.findUnique({ where: { id: rows.workerId } }),
        ).toBeNull();
        expect(
          await db.workerEngagement.findUnique({
            where: { id: rows.engagementId },
          }),
        ).toBeNull();
        expect(
          await db.workerNotice.findUnique({ where: { id: rows.noticeId } }),
        ).toBeNull();
      });
    });

    it('updates nothing of A', async () => {
      await h.asTenant(tenantB, async () => {
        const db = h.prisma.tenant;
        const counts = [
          await db.tenantSettings.updateMany({
            where: { tenantId: tenantA },
            data: { maxHouseholdMembers: 50 },
          }),
          await db.householdMember.updateMany({
            where: { id: rows.memberId },
            data: { relation: 'other' },
          }),
          await db.householdInvite.updateMany({
            where: { id: rows.inviteId },
            data: { status: 'revoked' },
          }),
          await db.householdDelegation.updateMany({
            where: { id: rows.delegationId },
            data: { scopes: ['workers'] },
          }),
          await db.domesticWorker.updateMany({
            where: { id: rows.workerId },
            data: { fullName: 'Changed' },
          }),
          await db.workerEngagement.updateMany({
            where: { id: rows.engagementId },
            data: { status: 'rejected' },
          }),
          await db.workerNotice.updateMany({
            where: { id: rows.noticeId },
            data: { status: 'sent' },
          }),
        ].map((r) => r.count);
        expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
      });
    });

    it('writing A’s tenant_id while acting as B is rejected on every new table', async () => {
      const attempts: (() => Promise<unknown>)[] = [
        () =>
          h.prisma.tenant.tenantSettings.create({
            data: { tenantId: tenantA },
          }),
        () =>
          h.prisma.tenant.householdMember.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              unitId: unitA.id,
              relation: 'child',
              isMinor: true,
              fullName: 'Child',
              nationalId: '31501010100011',
              birthDate: new Date('2015-01-01'),
              status: 'active',
              addedById: ownerA.id,
            },
          }),
        () =>
          h.prisma.tenant.domesticWorker.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              nationalIdHash: 'c'.repeat(64),
              nationalId: '29001010100097',
              fullName: 'Worker',
              phone: '+201000000097',
              birthDate: new Date('1990-01-01'),
            },
          }),
        () =>
          h.prisma.tenant.workerNotice.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              workerId: rows.workerId,
              engagementId: rows.engagementId,
              noticeKey: 'x',
              params: {},
            },
          }),
      ];
      for (const attempt of attempts) {
        await expect(h.asTenant(tenantB, attempt)).rejects.toThrow(
          /row-level security/,
        );
      }
    });

    it('composite keys stop links to another tenant’s units, accounts and workers', async () => {
      const inB = (fn: () => Promise<unknown>) =>
        expect(h.asTenant(tenantB, fn)).rejects.toMatchObject({
          code: 'P2003',
        });
      // A membership in B pointing at A's unit.
      await inB(() =>
        h.prisma.tenant.householdMember.create({
          data: {
            id: newId(),
            tenantId: tenantB,
            unitId: unitA.id,
            accountId: ownerB.id,
            relation: 'spouse',
            isMinor: false,
            birthDate: new Date('1990-01-01'),
            status: 'active',
            addedById: ownerB.id,
          },
        }),
      );
      // A delegation in B naming A's account as delegate.
      await inB(() =>
        h.prisma.tenant.householdDelegation.create({
          data: {
            id: newId(),
            tenantId: tenantB,
            unitId: unitB.id,
            delegatorAccountId: ownerB.id,
            delegateAccountId: familyA.id,
            scopes: ['workers'],
            expiresAt: inYear(),
          },
        }),
      );
      // An engagement in B for A's worker.
      await inB(() =>
        h.prisma.tenant.workerEngagement.create({
          data: {
            id: newId(),
            tenantId: tenantB,
            workerId: rows.workerId,
            unitId: unitB.id,
            requestedById: ownerB.id,
            capacity: 'hourly',
            schedule: {},
          },
        }),
      );
    });

    it('invite_tokens is global and holds no personal data', async () => {
      const columns = await h.asTenant(tenantA, () =>
        h.tenantTx.withTenantTx(
          (tx) =>
            tx.$queryRaw<{ column_name: string }[]>`
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'invite_tokens'
             ORDER BY column_name`,
        ),
      );
      expect(columns.map((c) => c.column_name)).toEqual([
        'created_at',
        'expires_at',
        'invite_id',
        'tenant_id',
        'token_hash',
      ]);
    });
  });

  // --------------------------------------------------------------------------
  describe('constraints the services rely on', () => {
    /** Runs `fn` in tenant A's transaction; resolves to the error, if any. */
    const inA = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      h
        .asTenant(tenantA, () => h.tenantTx.withTenantTx(fn))
        .then(() => null)
        .catch((e: unknown) => e);

    /** The error names exactly this constraint (not merely "some error"). */
    const violation = (constraint: string) => ({
      message: expect.stringContaining(constraint) as unknown,
    });

    const occupancy = (
      tx: Prisma.TransactionClient,
      unitId: string,
      accountId: string,
      isPrimary: boolean,
    ) =>
      tx.unitOccupancy.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          unitId,
          accountId,
          occupancyType: 'owner',
          isPrimary,
          createdById: accountId,
        },
      });

    it('one primary per unit among active occupancies; an ended primary does not count', async () => {
      const unit = await createUnit(h, tenantA);
      const a = await createAccountRow(h, tenantA);
      const b = await createAccountRow(h, tenantA);
      expect(
        await inA(async (tx) => {
          await occupancy(tx, unit.id, a.id, true);
          await occupancy(tx, unit.id, b.id, true);
        }),
      ).toMatchObject({ code: 'P2002' });

      expect(
        await inA(async (tx) => {
          const first = await occupancy(tx, unit.id, a.id, true);
          await tx.unitOccupancy.update({
            where: { id: first.id },
            data: { status: 'ended', endedAt: new Date() },
          });
          await occupancy(tx, unit.id, b.id, true);
        }),
      ).toBeNull();
    });

    it('adults have an account and no personal fields; minors the reverse', async () => {
      const member = (
        data: Partial<Prisma.HouseholdMemberUncheckedCreateInput>,
      ) =>
        inA((tx) =>
          tx.householdMember.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              unitId: unitA.id,
              relation: 'child',
              birthDate: new Date('2015-01-01'),
              status: 'active',
              addedById: ownerA.id,
              isMinor: true,
              ...data,
            },
          }),
        );
      // An adult without an account.
      expect(await member({ isMinor: false })).toMatchObject(
        violation('household_members_minor_or_account'),
      );
      // An adult carrying a name next to the account.
      expect(
        await member({
          isMinor: false,
          accountId: (await createAccountRow(h, tenantA)).id,
          fullName: 'Duplicate of the account',
        }),
      ).toMatchObject(violation('household_members_minor_or_account'));
      // A minor with an account.
      expect(
        await member({
          accountId: (await createAccountRow(h, tenantA)).id,
          fullName: 'Kid',
          nationalId: '31501010100011',
        }),
      ).toMatchObject(violation('household_members_minor_or_account'));
      // A minor with no name.
      expect(await member({ nationalId: '31501010100011' })).toMatchObject(
        violation('household_members_minor_or_account'),
      );
      // A valid minor.
      expect(
        await member({ fullName: 'Kid', nationalId: '31501010100011' }),
      ).toBeNull();
      // Removed without a reason.
      expect(
        await member({
          fullName: 'Kid',
          nationalId: '31501010100011',
          status: 'removed',
          removedAt: new Date(),
        }),
      ).toMatchObject(violation('household_members_removed_has_reason'));
    });

    it('delegations: at most a year, at least one scope, never to oneself, one live per delegate', async () => {
      const delegation = (
        data: Partial<Prisma.HouseholdDelegationUncheckedCreateInput>,
      ) =>
        inA((tx) =>
          tx.householdDelegation.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              unitId: unitA.id,
              delegatorAccountId: ownerA.id,
              delegateAccountId: familyA.id,
              scopes: ['workers'],
              expiresAt: inYear(),
              ...data,
            },
          }),
        );
      expect(
        await delegation({
          expiresAt: new Date(Date.now() + 367 * 86_400_000),
        }),
      ).toMatchObject(violation('household_delegations_expiry_within_a_year'));
      expect(
        await delegation({ expiresAt: new Date(Date.now() - 1000) }),
      ).toMatchObject(violation('household_delegations_expiry_within_a_year'));
      expect(await delegation({ scopes: [] })).toMatchObject(
        violation('household_delegations_scopes_not_empty'),
      );
      expect(await delegation({ delegateAccountId: ownerA.id })).toMatchObject(
        violation('household_delegations_not_to_self'),
      );
      // familyA already holds a live delegation on unitA (beforeAll).
      expect(await delegation({})).toMatchObject({ code: 'P2002' });
      // Ended with no reason.
      expect(
        await delegation({
          delegateAccountId: (await createAccountRow(h, tenantA)).id,
          revokedAt: new Date(),
        }),
      ).toMatchObject(violation('household_delegations_end_has_reason'));
    });

    it('engagement codes: active needs one, suspended keeps it, ended has none, unique among active', async () => {
      const worker = await h.asTenant(tenantA, () =>
        h.prisma.tenant.domesticWorker.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            nationalIdHash:
              'd'.repeat(48) + uniqueSuffix().padEnd(16, '0').slice(0, 16),
            nationalId: '29001010100096',
            fullName: 'Worker B',
            phone: '+201000000096',
            birthDate: new Date('1990-01-01'),
          },
        }),
      );
      const code = 'e'.repeat(64);
      const engagement = (
        data: Partial<Prisma.WorkerEngagementUncheckedCreateInput>,
        unitId?: string,
      ) =>
        (async () => {
          const unit = unitId ?? (await createUnit(h, tenantA)).id;
          return inA((tx) =>
            tx.workerEngagement.create({
              data: {
                id: newId(),
                tenantId: tenantA,
                workerId: worker.id,
                unitId: unit,
                requestedById: ownerA.id,
                capacity: 'hourly',
                schedule: {},
                ...data,
              },
            }),
          );
        })();
      expect(await engagement({ status: 'active' })).toMatchObject(
        violation('worker_engagements_code_matches_status'),
      );
      expect(
        await engagement({ status: 'ended', accessCodeHash: code }),
      ).toMatchObject(violation('worker_engagements_code_matches_status'));
      expect(
        await engagement({ status: 'pending_review', accessCodeHash: code }),
      ).toMatchObject(violation('worker_engagements_code_matches_status'));
      expect(
        await engagement({
          status: 'active',
          suspendedByManagement: true,
          accessCodeHash: code,
        }),
      ).toMatchObject(violation('worker_engagements_management_suspension'));
      expect(await engagement({ capacity: 'temporary' })).toMatchObject(
        violation('worker_engagements_temporary_has_end'),
      );

      expect(
        await engagement({ status: 'active', accessCodeHash: code }),
      ).toBeNull();
      // The same code on a second ACTIVE engagement: rejected…
      expect(
        await engagement({ status: 'active', accessCodeHash: code }),
      ).toMatchObject({ code: 'P2002' });
      // …but a suspended one may still hold it (resume must check).
      expect(
        await engagement({ status: 'suspended', accessCodeHash: code }),
      ).toBeNull();

      // One open engagement per worker and unit.
      const unit = await createUnit(h, tenantA);
      expect(await engagement({}, unit.id)).toBeNull();
      expect(await engagement({}, unit.id)).toMatchObject({ code: 'P2002' });
    });

    it('the app role cannot delete household or worker records', async () => {
      for (const table of [
        'tenant_settings',
        'household_members',
        'household_invites',
        'household_delegations',
        'domestic_workers',
        'worker_engagements',
        'worker_notices',
      ]) {
        const error = await inA((tx) =>
          tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE false`),
        );
        expect(String(error)).toMatch(/permission denied/);
      }
      // invite_tokens rows are deleted on acceptance and revocation.
      expect(
        await inA((tx) =>
          tx.$executeRawUnsafe('DELETE FROM "invite_tokens" WHERE false'),
        ),
      ).toBeNull();
    });
  });
});
