import { AccountSelfService } from '../../src/core/accounts/account-self.service';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { WorkersService } from '../../src/community/workers/workers.service';
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
  const delegations = () => h.moduleRef.get(DelegationsService);
  const workers = () => h.moduleRef.get(WorkersService);

  /** Every compound this suite creates, and every secret it handles. */
  const compounds = new Set<Compound>();
  const secrets = new Set<string>();
  const remember = (...values: string[]) =>
    values.forEach((v) => secrets.add(v));

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    const compound = x.compound;
    x.compound = async (...args) => {
      const c = await compound(...args);
      compounds.add(c);
      return c;
    };
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
      idDocumentType: 'national_id' as const,
      idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
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
        input.idDocumentNumber,
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
      remember(nationalId, 'Little Audit');
      const kid = await asPrimary(() =>
        households().addMinor(unitId, {
          fullName: 'Little Audit',
          idDocumentType: 'national_id' as const,
          idDocumentNumber: nationalId,
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
          idDocumentNumber: { changed: true },
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
  describe('delegation', () => {
    it('household.delegation_created, delegation_revoked (by the primary) and delegation_ended (automatic)', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const primary = await x.resident(c, [u.id]);
      const member = await x.joinFamily(c, u.id, primary);
      const asPrimary = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: primary.id, type: 'resident' }, fn);
      const expiresAt = new Date(Date.now() + 30 * 86_400_000);

      const first = await asPrimary(() =>
        delegations().create(
          u.id,
          member.id,
          ['workers', 'household'],
          expiresAt,
        ),
      );
      expect(
        await single(c, 'household.delegation_created', first.id),
      ).toMatchObject({
        actorType: 'account',
        actorId: primary.id,
        targetType: 'household_delegation',
        changes: {
          unitId: { from: null, to: u.id },
          delegateAccountId: { from: null, to: member.id },
          scopes: { from: null, to: ['household', 'workers'] },
          expiresAt: { from: null, to: expiresAt.toISOString() },
        },
      });

      await asPrimary(() => delegations().revoke(first.id));
      expect(
        await single(c, 'household.delegation_revoked', first.id),
      ).toMatchObject({
        actorType: 'account',
        actorId: primary.id,
        changes: { endReason: { from: null, to: 'revoked' } },
      });

      const second = await asPrimary(() =>
        delegations().create(u.id, member.id, ['household'], expiresAt),
      );
      await asPrimary(() =>
        households().removeMember(member.memberId, 'moved'),
      );
      expect(
        await single(c, 'household.delegation_ended', second.id),
      ).toMatchObject({
        actorType: 'account',
        actorId: primary.id,
        changes: { endReason: { from: null, to: 'member_removed' } },
        metadata: { unitId: u.id, reason: 'member_removed' },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('self-service', () => {
    it('account.locale_changed — by the account itself', async () => {
      const c = await x.compound();
      const r = await x.resident(c, [(await x.unit(c)).id]);
      await x.as(c, { id: r.id, type: 'resident' }, () =>
        h.moduleRef.get(AccountSelfService).updatePreferredLocale('en'),
      );
      expect(await single(c, 'account.locale_changed', r.id)).toMatchObject({
        actorType: 'account',
        actorId: r.id,
        targetType: 'account',
        changes: { preferredLocale: { from: 'ar', to: 'en' } },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('domestic workers', () => {
    it('worker.registered, engagement_reviewed, code_reissued, suspended, resumed, ended, banned, unbanned', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const r = await x.resident(c, [u.id]);
      const asResident = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: r.id, type: 'resident' }, fn);
      const nationalId = nationalIdFor(bornYearsAgo(30));
      const workerName = 'Audited Worker Name';
      remember(nationalId, workerName);

      const reg = await asResident(() =>
        workers().register(u.id, {
          fullName: workerName,
          idDocumentType: 'national_id' as const,
          idDocumentNumber: nationalId,
          phone: uniquePhone(),
          capacity: 'live_in',
        }),
      );
      expect(
        await single(c, 'worker.registered', reg.engagementId),
      ).toMatchObject({
        actorType: 'account',
        actorId: r.id,
        targetType: 'worker_engagement',
        changes: {
          unitId: { from: null, to: u.id },
          capacity: { from: null, to: 'live_in' },
          status: { from: null, to: 'pending_review' },
        },
      });

      const approved = await x.asManager(c, () =>
        workers().review(reg.engagementId, 'approve'),
      );
      remember(approved!.accessCode);
      expect(
        await single(c, 'worker.engagement_reviewed', reg.engagementId),
      ).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        changes: { status: { from: 'pending_review', to: 'active' } },
        metadata: { decision: 'approve' },
      });

      const reissued = await asResident(() =>
        workers().reissueCode(reg.engagementId),
      );
      remember(reissued.accessCode);
      expect(
        await single(c, 'worker.code_reissued', reg.engagementId),
      ).toMatchObject({ actorType: 'account', actorId: r.id });

      await asResident(() => workers().suspend(reg.engagementId, 'Vacation'));
      expect(
        await single(c, 'worker.engagement_suspended', reg.engagementId),
      ).toMatchObject({
        actorId: r.id,
        changes: { status: { from: 'active', to: 'suspended' } },
      });
      await asResident(() => workers().resume(reg.engagementId));
      expect(
        await single(c, 'worker.engagement_resumed', reg.engagementId),
      ).toMatchObject({
        actorId: r.id,
        changes: { status: { from: 'suspended', to: 'active' } },
        metadata: { codeReplaced: false },
      });

      const workerId = (
        await x.asManager(c, () =>
          x.prisma.tenant.workerEngagement.findUniqueOrThrow({
            where: { id: reg.engagementId },
          }),
        )
      ).workerId;
      await x.asManager(c, () => workers().ban(workerId, 'Banned for audit'));
      expect(await single(c, 'worker.banned', workerId)).toMatchObject({
        actorId: c.managerId,
        targetType: 'domestic_worker',
        changes: { banned: { from: false, to: true } },
        metadata: { engagementsSuspended: [reg.engagementId] },
      });
      await x.asManager(c, () => workers().unban(workerId));
      expect(await single(c, 'worker.unbanned', workerId)).toMatchObject({
        actorId: c.managerId,
        changes: { banned: { from: true, to: false } },
      });

      await x.asManager(c, () => workers().end(reg.engagementId, 'Left'));
      expect(
        await single(c, 'worker.engagement_ended', reg.engagementId),
      ).toMatchObject({
        actorId: c.managerId,
        changes: { status: { from: 'suspended', to: 'ended' } },
      });
    });

    it('worker.birth_date_attested and birth_date_corrected — passport workers, dates withheld', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const r = await x.resident(c, [u.id]);
      const entered = bornYearsAgo(31).toISOString().slice(0, 10);
      const attested = bornYearsAgo(32).toISOString().slice(0, 10);
      const later = bornYearsAgo(33).toISOString().slice(0, 10);
      const number = `PX${Date.now().toString(36).toUpperCase()}`;
      remember(number, entered, attested, later);
      const reg = await x.as(c, { id: r.id, type: 'resident' }, () =>
        workers().register(u.id, {
          fullName: 'Passport Audit',
          phone: '+639171234567',
          capacity: 'live_in',
          idDocumentType: 'passport',
          idDocumentNumber: number,
          nationality: 'PH',
          birthDate: entered,
        }),
      );
      await x.asManager(c, () =>
        workers().review(reg.engagementId, 'approve', {
          birthDateConfirmed: true,
          birthDate: attested,
        }),
      );
      const workerId = (
        await x.asManager(c, () =>
          x.prisma.tenant.workerEngagement.findUniqueOrThrow({
            where: { id: reg.engagementId },
          }),
        )
      ).workerId;
      expect(
        await single(c, 'worker.birth_date_attested', workerId),
      ).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'domestic_worker',
        changes: {
          birthDate: { changed: true },
          birthDateVerified: { from: false, to: true },
        },
        metadata: { engagementId: reg.engagementId, corrected: true },
      });

      await x.asManager(c, () => workers().correctBirthDate(workerId, later));
      expect(
        await single(c, 'worker.birth_date_corrected', workerId),
      ).toMatchObject({
        actorId: c.managerId,
        changes: {
          birthDate: { changed: true },
          birthDateVerified: { from: true, to: false },
        },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('no secrets or personal values in the trail', () => {
    it('no access code, invite token, national ID or name appears in any entry this suite wrote', async () => {
      const text = JSON.stringify([
        ...(await Promise.all(
          [...compounds].map((c) => read.tenant(c.tenantId)),
        )),
        await read.security(),
      ]);
      expect(secrets.size).toBeGreaterThan(5);
      for (const secret of secrets) expect(text).not.toContain(secret);
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
