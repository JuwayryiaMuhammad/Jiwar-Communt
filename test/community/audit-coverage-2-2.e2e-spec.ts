import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  PHASE_2_2_COVERAGE,
} from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo, MOVED_OUT, nationalIdFor } from '../setup/fixtures';
import { WorkersService } from '../../src/community/workers/workers.service';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { InviteAcceptanceService } from '../../src/community/households/invite-acceptance.service';
import { MAJORITY_SWEEP } from '../../src/community/households/majority-notices';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { waitForOtp } from '../setup/mailpit';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/**
 * One scenario per Phase 2.2 catalog entry (ADR 0014), each asserting actor,
 * target and changes, with no personal values (strict in tests).
 */
const covered = new Set<string>();

describe('Audit coverage — Phase 2.2', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  /** Exactly one entry for (action, target); marks the action covered. */
  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  // --------------------------------------------------------------------------
  describe('capacities (ADR 0020)', () => {
    it('occupancy.converted, residence_changed, handed_over — by the manager', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const tenant = await x.resident(c, [u.id], 'tenant');
      const [rented] = await x.occupancies(c, u.id);
      const owned = await x.asManager(c, () =>
        x.residents.convertToOwner(rented.id),
      );
      expect(await single(c, 'occupancy.converted', owned.id)).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'occupancy',
        changes: { occupancyType: { from: 'tenant', to: 'owner' } },
        metadata: {
          unitId: u.id,
          accountId: tenant.id,
          convertedFromId: rented.id,
          isPrimary: true,
        },
      });

      // A second owner, who then moves out and lets the unit.
      const other = await x.resident(c, [u.id]);
      const second = (await x.occupancies(c, u.id)).find(
        (o) => o.accountId === other.id,
      )!;
      await x.asManager(c, () => x.residents.setResidence(second.id, false));
      expect(
        await single(c, 'occupancy.residence_changed', second.id),
      ).toMatchObject({
        actorId: c.managerId,
        changes: { resides: { from: true, to: false } },
        metadata: { unitId: u.id, accountId: other.id },
      });

      await x.asManager(c, () =>
        x.residents.endOccupancy(second.id, MOVED_OUT),
      );
      await x.asManager(c, () => x.residents.recordHandover(second.id));
      expect(await single(c, 'occupancy.handed_over', second.id)).toMatchObject(
        {
          actorId: c.managerId,
          changes: { handedOver: { from: false, to: true } },
        },
      );
    });

    it('unit.closed_mode_changed — by the owner-resident primary', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const owner = await x.resident(c, [u.id]);
      await x.as(c, { id: owner.id, type: 'resident' }, () =>
        x.residents.setUnitClosed(u.id, true),
      );
      expect(await single(c, 'unit.closed_mode_changed', u.id)).toMatchObject({
        actorType: 'account',
        actorId: owner.id,
        targetType: 'unit',
        changes: { closed: { from: false, to: true } },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('unit states (ADR 0021)', () => {
    const SOLD = { code: 'unit_changed_hands', text: 'Sold' };

    it('unit.household_review_cleared, household.permissions_reviewed — manager, then the new primary', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      await x.resident(c, [u.id]);
      const { flagId } = await x.asManager(c, () =>
        x.residents.tagSeparation(u.id, { code: 'separation', text: 'Letter' }),
      );
      await x.asManager(c, () =>
        x.residents.clearReviewFlag(flagId, 'resolved'),
      );
      expect(
        await single(c, 'unit.household_review_cleared', u.id),
      ).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'unit',
        changes: { reviewFlag: { from: 'separation', to: null } },
        metadata: { reason: 'separation', flagId, clearReasonCode: 'resolved' },
      });

      const t = await x.resident(c, [u.id], 'tenant');
      await x.asManager(c, () => x.residents.setPrimary(u.id, t.id));
      await x.as(c, { id: t.id, type: 'resident' }, () =>
        x.residents.markMembersReviewed(u.id, 'all'),
      );
      expect(
        await single(c, 'household.permissions_reviewed', u.id),
      ).toMatchObject({
        actorId: t.id,
        targetType: 'unit',
        metadata: { members: 'all', count: 0 },
      });
    });

    it('unit.household_ended, worker.wage_obligation_recorded — by the manager', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const r = await x.resident(c, [u.id]);
      const workers = h.moduleRef.get(WorkersService);
      const reg = await x.as(c, { id: r.id, type: 'resident' }, () =>
        workers.register(u.id, {
          fullName: 'Audited Worker',
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
          phone: uniquePhone(),
          capacity: 'live_in',
        }),
      );
      await x.asManager(c, () => workers.review(reg.engagementId, 'approve'));
      await x.asManager(c, () => x.residents.endHousehold(u.id, SOLD));
      expect(await single(c, 'unit.household_ended', u.id)).toMatchObject({
        actorId: c.managerId,
        metadata: { reasonCode: 'unit_changed_hands', engagementsEnded: 1 },
      });
      expect(
        await single(c, 'worker.wage_obligation_recorded', reg.engagementId),
      ).toMatchObject({
        actorId: c.managerId,
        targetType: 'worker_engagement',
        metadata: { kind: 'settle_before_close', unitId: u.id },
      });
    });

    it('unit.ownership_transferred — by the manager', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      await x.resident(c, [u.id]);
      const buyer = await x.resident(c, [(await x.unit(c)).id]);
      const view = await x.asManager(c, () =>
        x.residents.transferOwnership(u.id, { toAccountId: buyer.id }, SOLD),
      );
      expect(await single(c, 'unit.ownership_transferred', u.id)).toMatchObject(
        {
          actorId: c.managerId,
          targetType: 'unit',
          metadata: {
            reasonCode: 'unit_changed_hands',
            newOccupancyId: view.id,
            newOwnerAccountId: buyer.id,
          },
        },
      );
    });
  });

  // --------------------------------------------------------------------------
  describe('member permissions (ADR 0021)', () => {
    it('permission_granted, permission_revoked, deferred_action_submitted, deferred_action_decided', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const primary = await x.resident(c, [u.id]);
      const family = await x.joinFamily(c, u.id, primary);
      const perms = h.moduleRef.get(MemberPermissionsService);
      const asPrimary = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: primary.id, type: 'resident' }, fn);

      await asPrimary(() =>
        perms.grant(family.memberId, 'finance', { capPerOperation: '250' }),
      );
      expect(
        await single(c, 'household.permission_granted', family.memberId),
      ).toMatchObject({
        actorId: primary.id,
        targetType: 'household_member',
        changes: {
          permission: { from: null, to: 'finance' },
          capPerOperation: { from: null, to: '250' },
        },
        metadata: { permission: 'finance', unitId: u.id },
      });

      await asPrimary(() =>
        perms.revoke(family.memberId, 'finance', {
          code: 'misuse',
          text: 'Why',
        }),
      );
      expect(
        await single(c, 'household.permission_revoked', family.memberId),
      ).toMatchObject({
        actorId: primary.id,
        changes: { permission: { from: 'finance', to: null } },
        metadata: { reasonCode: 'misuse', bulk: false },
      });

      const id = await x.as(c, { id: family.accountId, type: 'family' }, () =>
        h.moduleRef.get(TenantTx).withTenantTx((tx) =>
          perms.submitDeferredAction(tx, {
            accountId: family.accountId,
            unitId: u.id,
            permission: 'finance',
            payload: { amount: '99.00' },
          }),
        ),
      );
      expect(
        await single(c, 'household.deferred_action_submitted', id),
      ).toMatchObject({
        actorId: family.accountId,
        targetType: 'household_deferred_action',
        metadata: {
          unitId: u.id,
          memberId: family.memberId,
          permission: 'finance',
        },
      });
      await asPrimary(() => perms.decideDeferredAction(id, 'approve'));
      expect(
        await single(c, 'household.deferred_action_decided', id),
      ).toMatchObject({
        actorId: primary.id,
        changes: { status: { from: 'pending', to: 'approved' } },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('majority (ADR 0021)', () => {
    it('member_majority_reached (system), member_came_of_age (system)', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const primary = await x.resident(c, [u.id]);
      const households = h.moduleRef.get(HouseholdsService);
      const asPrimary = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: primary.id, type: 'resident' }, fn);
      const kid = await asPrimary(() =>
        households.addMinor(u.id, {
          fullName: 'Audited Kid',
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(18, -1)),
          relation: 'child',
        }),
      );
      await x.asManager(c, () =>
        x.prisma.tenant.householdMember.update({
          where: { id: kid.id },
          data: { birthDate: bornYearsAgo(18) },
        }),
      );
      await h.moduleRef.get(SweepRunner).run(MAJORITY_SWEEP);
      expect(
        await single(c, 'household.member_majority_reached', kid.id),
      ).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: 'household_member',
        metadata: { unitId: u.id, primaryTold: true },
      });

      const email = uniqueEmail('coming');
      const invite = await asPrimary(() =>
        households.inviteMemberToAdulthood(kid.id, {
          email,
          phone: uniquePhone(),
        }),
      );
      const acceptance = h.moduleRef.get(InviteAcceptanceService);
      const since = new Date();
      await acceptance.startAcceptance(invite.token, '10.1.1.1', 'ar');
      const accepted = await acceptance.completeAcceptance(
        invite.token,
        await waitForOtp(email, since),
      );
      expect(
        await single(c, 'household.member_came_of_age', kid.id),
      ).toMatchObject({
        actorType: 'system',
        changes: {
          isMinor: { from: true, to: false },
          hasAccount: { from: false, to: true },
        },
        metadata: { accountId: accepted.accountId, confirmedBy: primary.id },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('catalog completeness', () => {
    it('every Phase 2.2 entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PHASE_2_2_COVERAGE) {
        expect(all).toContain(key);
        expect(COMMUNITY_COVERAGE).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...PHASE_2_2_COVERAGE].sort());
    });
  });
});
