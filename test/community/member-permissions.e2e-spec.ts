import { Client } from 'pg';
import { CapabilitiesService } from '../../src/community/capabilities/capabilities.service';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { auditReaders } from '../setup/audit';
import {
  communityHelpers,
  type Compound,
  type Person,
} from '../setup/community';
import { bornYearsAgo, codeOf, nationalIdFor } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

const MISUSE = { code: 'misuse', text: 'Shared the gate code with strangers' };

/** Per-member permissions, the finance cap, deferred actions (ADR 0021). */
describe('Member permissions', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let perms: MemberPermissionsService;
  let caps: CapabilitiesService;
  let globalDb: GlobalDbService;
  let tenantTx: TenantTx;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    perms = h.moduleRef.get(MemberPermissionsService);
    caps = h.moduleRef.get(CapabilitiesService);
    globalDb = h.moduleRef.get(GlobalDbService);
    tenantTx = h.moduleRef.get(TenantTx);
  });

  afterAll(() => h.close());

  interface Home {
    c: Compound;
    unitId: string;
    primary: Person;
    family: Awaited<ReturnType<typeof x.joinFamily>>;
  }

  async function home(): Promise<Home> {
    const c = await x.compound('Permissions Court');
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const family = await x.joinFamily(c, u.id, primary);
    return { c, unitId: u.id, primary, family };
  }

  const asPrimary = <T>(hm: Home, fn: () => Promise<T>) =>
    x.as(hm.c, { id: hm.primary.id, type: 'resident' }, fn);
  const asFamily = <T>(hm: Home, id: string, fn: () => Promise<T>) =>
    x.as(hm.c, { id, type: 'family' }, fn);
  const allowed = (
    hm: Home,
    permission: 'finance' | 'bookings',
    amount?: string,
  ) =>
    asPrimary(hm, () =>
      tenantTx.withTenantTx((tx) =>
        perms.assertAllowed(tx, hm.family.accountId, hm.unitId, permission, {
          amount,
        }),
      ),
    );

  it('an adult joins with the defaults; the member sees them with the baseline', async () => {
    const hm = await home();
    const mine = await asFamily(hm, hm.family.accountId, () =>
      perms.myPermissions(hm.unitId),
    );
    expect(mine.grants.map((g) => g.permission).sort()).toEqual([
      'bookings',
      'tickets',
      'visitors_invite',
    ]);
    expect(mine.baseline).toEqual([
      'emergency',
      'conduct_guide',
      'contact_primary',
    ]);
    const [accepted] = await auditReaders(h).tenant(hm.c.tenantId, {
      action: 'household.invite_accepted',
    });
    expect(accepted.metadata).toMatchObject({
      defaultPermissions: ['visitors_invite', 'bookings', 'tickets'],
    });
  });

  it("a member's grants, for the primary; the member themselves is refused", async () => {
    const hm = await home();
    const view = await asPrimary(hm, () =>
      perms.memberPermissions(hm.family.memberId),
    );
    expect(view.memberId).toBe(hm.family.memberId);
    expect(view.grants.map((g) => g.permission).sort()).toEqual([
      'bookings',
      'tickets',
      'visitors_invite',
    ]);
    expect(
      await codeOf(
        asFamily(hm, hm.family.accountId, () =>
          perms.memberPermissions(hm.family.memberId),
        ),
      ),
    ).toBe('NOT_PRIMARY_RESIDENT');
    const other = await x.compound();
    expect(
      await codeOf(
        x.asManager(other, () => perms.memberPermissions(hm.family.memberId)),
      ),
    ).toBe('HOUSEHOLD_MEMBER_NOT_FOUND');
  });

  it('finance: primary only, with a positive cap; enforced per operation', async () => {
    const hm = await home();
    expect(
      await codeOf(
        asPrimary(hm, () => perms.grant(hm.family.memberId, 'finance')),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        asPrimary(hm, () =>
          perms.grant(hm.family.memberId, 'bookings', {
            capPerOperation: '10',
          }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    for (const bad of ['0', '-5', '1.234', 'abc']) {
      expect(
        await codeOf(
          asPrimary(hm, () =>
            perms.grant(hm.family.memberId, 'finance', {
              capPerOperation: bad,
            }),
          ),
        ),
      ).toBe('VALIDATION_FAILED');
    }
    expect(await codeOf(allowed(hm, 'finance', '1'))).toBe(
      'MEMBER_PERMISSION_MISSING',
    );

    const granted = await asPrimary(hm, () =>
      perms.grant(hm.family.memberId, 'finance', { capPerOperation: '500' }),
    );
    expect(granted.capPerOperation).toBe('500.00');
    expect(
      await asFamily(hm, hm.family.accountId, () => caps.mine(hm.unitId)),
    ).toMatchObject({ financePay: true, financeCapPerOperation: '500.00' });
    expect(await codeOf(allowed(hm, 'finance', '500.00'))).toBe('resolved');
    expect(await codeOf(allowed(hm, 'finance', '500.01'))).toBe(
      'FINANCE_CAP_EXCEEDED',
    );

    // A new cap changes the live grant.
    await asPrimary(hm, () =>
      perms.grant(hm.family.memberId, 'finance', { capPerOperation: '100.50' }),
    );
    expect(await codeOf(allowed(hm, 'finance', '200'))).toBe(
      'FINANCE_CAP_EXCEEDED',
    );

    // A death review stops every financial action.
    await x.asManager(hm.c, () =>
      x.residents.markPrimaryDeceased(hm.unitId, {
        code: 'deceased',
        text: 'x',
      }),
    );
    expect(await codeOf(allowed(hm, 'finance', '1'))).toBe(
      'HOUSEHOLD_UNDER_REVIEW',
    );
    expect(await codeOf(allowed(hm, 'bookings'))).toBe('resolved');
  });

  it('a household delegate grants daily permissions but never finance', async () => {
    const hm = await home();
    const other = await x.joinFamily(hm.c, hm.unitId, hm.primary);
    await asPrimary(hm, () =>
      h.moduleRef
        .get(DelegationsService)
        .create(
          hm.unitId,
          hm.family.accountId,
          ['household'],
          new Date(Date.now() + 86_400_000),
        ),
    );
    const asDelegate = <T>(fn: () => Promise<T>) =>
      asFamily(hm, hm.family.accountId, fn);
    await asDelegate(() => perms.grant(other.memberId, 'unit_security'));
    expect(
      await codeOf(
        asDelegate(() =>
          perms.grant(other.memberId, 'finance', { capPerOperation: '5' }),
        ),
      ),
    ).toBe('DELEGATION_NOT_ALLOWED');
    const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
      action: 'household.permission_granted',
      targetId: other.memberId,
    });
    expect(entry.metadata).toMatchObject({
      permission: 'unit_security',
      onBehalfOf: hm.primary.id,
    });
  });

  it('a minor holds nothing, and the database refuses finance to a minor', async () => {
    const hm = await home();
    const kid = await asPrimary(hm, () =>
      h.moduleRef.get(HouseholdsService).addMinor(hm.unitId, {
        fullName: 'Kid Perms',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(12)),
        relation: 'child',
      }),
    );
    for (const p of ['finance', 'bookings'] as const) {
      expect(
        await codeOf(
          asPrimary(hm, () =>
            perms.grant(
              kid.id,
              p,
              p === 'finance' ? { capPerOperation: '1' } : {},
            ),
          ),
        ),
      ).toBe('MEMBER_HAS_NO_ACCOUNT');
    }
    const db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        hm.c.tenantId,
      ]);
      await expect(
        db.query(
          `INSERT INTO household_member_grants
             (id, tenant_id, member_id, member_is_minor, permission, cap_per_operation)
           VALUES (gen_random_uuid(), $1, $2, true, 'finance', 10)`,
          [hm.c.tenantId, kid.id],
        ),
      ).rejects.toThrow(/household_member_grants_no_minor_finance/);
      await db.query('ROLLBACK');
      // An adult with a finance grant can never be turned into a minor.
      await asPrimary(hm, () =>
        perms.grant(hm.family.memberId, 'finance', { capPerOperation: '10' }),
      );
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        hm.c.tenantId,
      ]);
      await expect(
        db.query(`UPDATE household_members SET is_minor = true WHERE id = $1`, [
          hm.family.memberId,
        ]),
      ).rejects.toThrow(
        /household_member_grants_no_minor_finance|household_members_minor_or_account/,
      );
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });

  it('a revocation is never silent: reason required, the member is told, the audit keeps the code', async () => {
    const hm = await home();
    expect(
      await codeOf(
        asPrimary(hm, () =>
          perms.revoke(hm.family.memberId, 'bookings', { code: 'misuse' }),
        ),
      ),
    ).toBe('REASON_REQUIRED');
    await asPrimary(hm, () =>
      perms.revoke(hm.family.memberId, 'bookings', MISUSE),
    );
    expect(
      await codeOf(
        asPrimary(hm, () =>
          perms.revoke(hm.family.memberId, 'bookings', MISUSE),
        ),
      ),
    ).toBe('MEMBER_PERMISSION_MISSING');
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: hm.c.tenantId,
        templateKey: 'community.permission_revoked',
      },
    });
    expect(mail).toMatchObject({
      recipientAccountId: hm.family.accountId,
      params: expect.objectContaining({
        permissions: 'bookings',
        reason: MISUSE.text,
      }) as object,
    });
    const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
      action: 'household.permission_revoked',
      targetId: hm.family.memberId,
    });
    expect(entry).toMatchObject({
      actorId: hm.primary.id,
      metadata: { permission: 'bookings', reasonCode: 'misuse', bulk: false },
    });
    expect(JSON.stringify(entry)).not.toContain('strangers');
  });

  it('revoke all keeps the baseline: emergency, the conduct guide, contacting the primary', async () => {
    const hm = await home();
    await asPrimary(hm, () => perms.revokeAll(hm.family.memberId, MISUSE));
    const mine = await asFamily(hm, hm.family.accountId, () =>
      perms.myPermissions(hm.unitId),
    );
    expect(mine.grants).toEqual([]);
    expect(
      await asFamily(hm, hm.family.accountId, () => caps.mine(hm.unitId)),
    ).toMatchObject({
      emergency: true,
      conductGuide: true,
      contactPrimary: true,
      visitorsInvite: false,
      bookings: false,
      tickets: false,
    });
    const mails = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: hm.c.tenantId,
        templateKey: 'community.permission_revoked',
      },
    });
    expect(mails).toHaveLength(1);
    expect(
      (mails[0].params as { permissions: string }).permissions
        .split(',')
        .sort(),
    ).toEqual(['bookings', 'tickets', 'visitors_invite']);
  });

  it('a revocation mid-action: the input is saved and sent to the primary, who decides', async () => {
    const hm = await home();
    await asPrimary(hm, () =>
      perms.revoke(hm.family.memberId, 'bookings', MISUSE),
    );
    // What the bookings domain will do when assertAllowed fails midway.
    const id = await asFamily(hm, hm.family.accountId, () =>
      tenantTx.withTenantTx(async (tx) => {
        const failed = await codeOf(
          perms.assertAllowed(tx, hm.family.accountId, hm.unitId, 'bookings'),
        );
        expect(failed).toBe('MEMBER_PERMISSION_MISSING');
        return perms.submitDeferredAction(tx, {
          accountId: hm.family.accountId,
          unitId: hm.unitId,
          permission: 'bookings',
          payload: { facility: 'pool', slot: '2026-10-02T10:00' },
        });
      }),
    );
    const [toPrimary] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: hm.c.tenantId,
        templateKey: 'community.deferred_action_submitted',
      },
    });
    expect(toPrimary.recipientAccountId).toBe(hm.primary.id);
    const pending = await asPrimary(hm, () => perms.deferredActions(hm.unitId));
    expect(pending).toEqual([
      expect.objectContaining({
        id,
        permission: 'bookings',
        payload: { facility: 'pool', slot: '2026-10-02T10:00' },
      }),
    ]);
    expect(
      await codeOf(
        asFamily(hm, hm.family.accountId, () =>
          perms.deferredActions(hm.unitId),
        ),
      ),
    ).toBe('NOT_PRIMARY_RESIDENT');
    expect(
      await codeOf(
        asPrimary(hm, () => perms.decideDeferredAction(id, 'decline')),
      ),
    ).toBe('REASON_REQUIRED');
    await asPrimary(hm, () =>
      perms.decideDeferredAction(id, 'decline', {
        code: 'not_needed',
        text: 'We booked already',
      }),
    );
    const [declined] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: hm.c.tenantId,
        templateKey: 'community.deferred_action_declined',
      },
    });
    expect(declined).toMatchObject({
      recipientAccountId: hm.family.accountId,
      params: expect.objectContaining({
        reason: 'We booked already',
      }) as object,
    });
    expect(
      await codeOf(
        asPrimary(hm, () => perms.decideDeferredAction(id, 'approve')),
      ),
    ).toBe('DEFERRED_ACTION_NOT_FOUND');
  });

  it("during a separation an adult's permission is revoked only by the management", async () => {
    const hm = await home();
    await x.asManager(hm.c, () =>
      x.residents.tagSeparation(hm.unitId, { code: 'separation', text: 'x' }),
    );
    expect(
      await codeOf(
        asPrimary(hm, () =>
          perms.revoke(hm.family.memberId, 'tickets', MISUSE),
        ),
      ),
    ).toBe('SEPARATION_MANAGER_DECISION');
    await x.asManager(hm.c, () =>
      perms.revokeByManagement(hm.family.memberId, 'tickets', MISUSE),
    );
    const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
      action: 'household.permission_revoked',
    });
    expect(entry).toMatchObject({
      actorId: hm.c.managerId,
      metadata: { byManagement: true },
    });
  });

  it('under a death review nothing is granted or revoked', async () => {
    const hm = await home();
    await x.asManager(hm.c, () =>
      x.residents.markPrimaryDeceased(hm.unitId, {
        code: 'deceased',
        text: 'x',
      }),
    );
    expect(
      await codeOf(
        asPrimary(hm, () => perms.grant(hm.family.memberId, 'unit_security')),
      ),
    ).toBe('HOUSEHOLD_UNDER_REVIEW');
    expect(
      await codeOf(
        asPrimary(hm, () =>
          perms.revoke(hm.family.memberId, 'tickets', MISUSE),
        ),
      ),
    ).toBe('HOUSEHOLD_UNDER_REVIEW');
  });

  it("tenant B can't grant or revoke on A's members, nor read A's requests", async () => {
    const a = await home();
    const b = await home();
    const asB = <T>(fn: () => Promise<T>) => asPrimary(b, fn);
    expect(
      await codeOf(asB(() => perms.grant(a.family.memberId, 'unit_security'))),
    ).toBe('HOUSEHOLD_MEMBER_NOT_FOUND');
    expect(
      await codeOf(
        asB(() => perms.revoke(a.family.memberId, 'tickets', MISUSE)),
      ),
    ).toBe('HOUSEHOLD_MEMBER_NOT_FOUND');
    expect(await codeOf(asB(() => perms.deferredActions(a.unitId)))).toBe(
      'UNIT_NOT_FOUND',
    );
  });
});
