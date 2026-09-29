import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import type { NewInvite } from '../../src/community/households/households.types';
import { InviteAcceptanceService } from '../../src/community/households/invite-acceptance.service';
import { auditReaders } from '../setup/audit';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import { waitForOtp } from '../setup/mailpit';
import { COMMUNITY_COVERAGE } from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/**
 * One scenario per Phase 2 community catalog entry (ADR 0014, 0016, 0017),
 * each asserting actor, target and changes. The rest of the catalog is
 * covered by test/audit/audit-coverage.e2e-spec.ts (see audit-coverage-split).
 */
const covered = new Set<string>();

describe('Audit coverage — community', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let read: ReturnType<typeof auditReaders>;

  const households = () => h.moduleRef.get(HouseholdsService);
  const acceptance = () => h.moduleRef.get(InviteAcceptanceService);

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
  describe('primary resident', () => {
    it('occupancy.primary_changed and unit.household_review_flagged — by the manager', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      await x.resident(c, [u.id]);
      const second = await x.resident(c, [u.id], 'tenant');
      const view = await x.asManager(c, () =>
        x.residents.setPrimary(u.id, second.id),
      );

      const changed = await single(c, 'occupancy.primary_changed', view.id);
      expect(changed).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'occupancy',
        changes: { isPrimary: { from: false, to: true } },
      });

      await x.asManager(c, () => x.residents.endOccupancy(view.id));
      const flagged = await single(c, 'unit.household_review_flagged', u.id);
      expect(flagged).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'unit',
        changes: { needsHouseholdReview: { from: false, to: true } },
        metadata: { reason: 'primary_left', occupancyId: view.id },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('settings', () => {
    it('tenant.settings_changed — by the manager, values recorded', async () => {
      const c = await x.compound();
      await x.asManager(c, () =>
        h.moduleRef
          .get(TenantSettingsService)
          .update({ familyJoinRequiresApproval: true }),
      );
      const entry = await single(c, 'tenant.settings_changed', c.tenantId);
      expect(entry).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'tenant',
        changes: { familyJoinRequiresApproval: { from: false, to: true } },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('household', () => {
    const adult = (label: string): NewInvite => ({
      fullName: `Adult ${label}`,
      phone: uniquePhone(),
      email: uniqueEmail(label),
      nationalId: nationalIdFor(bornYearsAgo(30)),
      relation: 'spouse',
    });

    async function home() {
      const c = await x.compound();
      const u = await x.unit(c);
      const primary = await x.resident(c, [u.id]);
      const asPrimary = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: primary.id, type: 'resident' }, fn);
      return { c, unitId: u.id, primary, asPrimary };
    }

    it('household.invite_created, invite_revoked — by the primary, no token or personal data', async () => {
      const { c, unitId, primary, asPrimary } = await home();
      const input = adult('audited');
      const invite = await asPrimary(() =>
        households().createInvite(unitId, input),
      );
      const created = await single(
        c,
        'household.invite_created',
        invite.inviteId,
      );
      expect(created).toMatchObject({
        actorType: 'account',
        actorId: primary.id,
        targetType: 'household_invite',
        changes: {
          unitId: { from: null, to: unitId },
          relation: { from: null, to: 'spouse' },
          status: { from: null, to: 'pending' },
        },
      });
      const text = JSON.stringify(created);
      for (const secret of [
        invite.token,
        input.email,
        input.phone,
        input.nationalId,
        input.fullName,
      ]) {
        expect(text).not.toContain(secret);
      }

      await asPrimary(() => households().revokeInvite(invite.inviteId));
      const revoked = await single(
        c,
        'household.invite_revoked',
        invite.inviteId,
      );
      expect(revoked).toMatchObject({
        actorType: 'account',
        actorId: primary.id,
        changes: { status: { from: 'pending', to: 'revoked' } },
      });
    });

    it('household.invite_accepted (actor system, invitedBy), member_approved, member_rejected', async () => {
      const { c, unitId, primary, asPrimary } = await home();
      await x.asManager(c, () =>
        h.moduleRef
          .get(TenantSettingsService)
          .update({ familyJoinRequiresApproval: true }),
      );
      const join = async (label: string) => {
        const input = adult(label);
        const invite = await asPrimary(() =>
          households().createInvite(unitId, input),
        );
        const since = new Date();
        await acceptance().startAcceptance(invite.token, '10.2.0.1', 'en');
        return {
          invite,
          accepted: await acceptance().completeAcceptance(
            invite.token,
            await waitForOtp(input.email, since),
          ),
        };
      };
      const first = await join('approved');
      const accepted = await single(
        c,
        'household.invite_accepted',
        first.invite.inviteId,
      );
      expect(accepted).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: 'household_invite',
        changes: { status: { from: 'pending', to: 'accepted' } },
        metadata: {
          invitedBy: primary.id,
          memberId: first.accepted.memberId,
          membershipStatus: 'pending_approval',
          accountCreated: true,
        },
      });

      await x.asManager(c, () =>
        households().approveMember(first.accepted.memberId),
      );
      expect(
        await single(c, 'household.member_approved', first.accepted.memberId),
      ).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'household_member',
        changes: { status: { from: 'pending_approval', to: 'active' } },
      });

      const second = await join('rejected');
      await x.asManager(c, () =>
        households().rejectMember(second.accepted.memberId, 'Unknown person'),
      );
      const rejected = await single(
        c,
        'household.member_rejected',
        second.accepted.memberId,
      );
      expect(rejected).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        changes: { status: { from: 'pending_approval', to: 'removed' } },
        metadata: { accountDeactivated: true },
      });
      expect(JSON.stringify(rejected)).not.toContain('Unknown person');
    });

    it('household.member_added (minor, values withheld) and member_removed', async () => {
      const { c, unitId, primary, asPrimary } = await home();
      const nationalId = nationalIdFor(bornYearsAgo(8));
      const kid = await asPrimary(() =>
        households().addMinor(unitId, {
          fullName: 'Little Audit',
          nationalId,
          relation: 'child',
        }),
      );
      const added = await single(c, 'household.member_added', kid.id);
      expect(added).toMatchObject({
        actorType: 'account',
        actorId: primary.id,
        targetType: 'household_member',
        changes: {
          relation: { from: null, to: 'child' },
          isMinor: { from: null, to: true },
          fullName: { changed: true },
          nationalId: { changed: true },
          birthDate: { changed: true },
        },
      });
      expect(JSON.stringify(added)).not.toContain(nationalId);
      expect(JSON.stringify(added)).not.toContain('Little Audit');

      await asPrimary(() => households().removeMember(kid.id, 'moved'));
      expect(await single(c, 'household.member_removed', kid.id)).toMatchObject(
        {
          actorType: 'account',
          actorId: primary.id,
          changes: { status: { from: 'active', to: 'removed' } },
          metadata: { unitId, accountId: null, accountDeactivated: false },
        },
      );
    });

    it('invite.token_invalid — no token, no tenant', async () => {
      const since = new Date();
      await acceptance().startAcceptance('no-such-token', '10.2.0.2', 'en');
      await expect(
        acceptance().completeAcceptance('no-such-token', '123456'),
      ).rejects.toMatchObject({ response: { code: 'OTP_INVALID' } });
      const deadline = Date.now() + 5000;
      let events: Awaited<ReturnType<typeof read.security>> = [];
      while (Date.now() < deadline) {
        events = (
          await read.security({ event: 'invite.token_invalid' })
        ).filter((e) => e.occurredAt >= since);
        if (events.length >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(
        events.map((e) => (e.metadata as { stage: string }).stage).sort(),
      ).toEqual(['complete', 'start']);
      for (const e of events) {
        expect(e.tenantId).toBeNull();
        expect(e.identifierHash).toBeNull();
        expect(JSON.stringify(e)).not.toContain('no-such-token');
      }
      covered.add('invite.token_invalid');
    });
  });

  // --------------------------------------------------------------------------
  describe('catalog completeness', () => {
    it('every community catalog entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of COMMUNITY_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...COMMUNITY_COVERAGE].sort());
    });
  });
});
