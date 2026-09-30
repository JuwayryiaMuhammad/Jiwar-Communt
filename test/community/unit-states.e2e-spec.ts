import { CapabilitiesService } from '../../src/community/capabilities/capabilities.service';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { auditReaders } from '../setup/audit';
import {
  communityHelpers,
  type Compound,
  type Person,
} from '../setup/community';
import {
  bornYearsAgo,
  codeOf,
  MOVED_OUT,
  nationalIdFor,
} from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

const DECEASED = {
  code: 'deceased',
  text: 'Death certificate received from the son',
};
const SEPARATED = {
  code: 'separation',
  text: 'Spouses separated, lawyer letter',
};
const SOLD = { code: 'unit_changed_hands', text: 'The unit was sold' };

/** Death, separation, change of primary, end of household (ADR 0021). */
describe('Unit states', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let households: HouseholdsService;
  let delegations: DelegationsService;
  let workers: WorkersService;
  let caps: CapabilitiesService;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    households = h.moduleRef.get(HouseholdsService);
    delegations = h.moduleRef.get(DelegationsService);
    workers = h.moduleRef.get(WorkersService);
    caps = h.moduleRef.get(CapabilitiesService);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  interface Home {
    c: Compound;
    unitId: string;
    primary: Person;
    family: Awaited<ReturnType<typeof x.joinFamily>>;
  }

  async function home(): Promise<Home> {
    const c = await x.compound('States Court');
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const family = await x.joinFamily(c, u.id, primary);
    return { c, unitId: u.id, primary, family };
  }

  const asPrimary = <T>(hm: Home, fn: () => Promise<T>) =>
    x.as(hm.c, { id: hm.primary.id, type: 'resident' }, fn);
  const inAYear = () => new Date(Date.now() + 30 * 86_400_000);
  const minor = () => ({
    fullName: 'Kid States',
    idDocumentType: 'national_id' as const,
    idDocumentNumber: nationalIdFor(bornYearsAgo(8)),
    relation: 'child' as const,
  });
  const adult = () => ({
    fullName: 'Adult States',
    phone: uniquePhone(),
    email: uniqueEmail('st'),
    idDocumentType: 'national_id' as const,
    idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
    relation: 'sibling' as const,
  });
  const mail = (c: Compound, templateKey: string) =>
    globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId, templateKey },
      orderBy: { createdAt: 'asc' },
    });

  // --------------------------------------------------------------------------
  describe('death of the primary', () => {
    it('freezes every household grant and revocation, for everyone, until the manager settles it', async () => {
      const hm = await home();
      const invite = await asPrimary(hm, () =>
        households.createInvite(hm.unitId, adult()),
      );
      const delegation = await asPrimary(hm, () =>
        delegations.create(
          hm.unitId,
          hm.family.accountId,
          ['household'],
          inAYear(),
        ),
      );
      await x.asManager(hm.c, () =>
        x.residents.markPrimaryDeceased(hm.unitId, DECEASED),
      );

      const frozen = [
        () => asPrimary(hm, () => households.createInvite(hm.unitId, adult())),
        () => asPrimary(hm, () => households.addMinor(hm.unitId, minor())),
        () => asPrimary(hm, () => households.revokeInvite(invite.inviteId)),
        () =>
          asPrimary(hm, () =>
            households.removeMember(hm.family.memberId, {
              code: 'other',
              text: 'x',
            }),
          ),
        () => asPrimary(hm, () => delegations.revoke(delegation.id)),
        () =>
          asPrimary(hm, () =>
            delegations.create(
              hm.unitId,
              hm.family.accountId,
              ['workers'],
              inAYear(),
            ),
          ),
        () =>
          x.asManager(hm.c, () =>
            households.removeMemberByManagement(hm.family.memberId, {
              code: 'other',
              text: 'x',
            }),
          ),
      ];
      for (const call of frozen)
        expect(await codeOf(call())).toBe('HOUSEHOLD_UNDER_REVIEW');

      // Nothing was closed or revoked by the flag itself.
      const members = await asPrimary(hm, () =>
        households.listMembers(hm.unitId),
      );
      expect(members.map((m) => m.status)).toEqual(['active']);
      expect(
        await x.asManager(hm.c, () =>
          x.prisma.tenant.householdDelegation.findUniqueOrThrow({
            where: { id: delegation.id },
          }),
        ),
      ).toMatchObject({ revokedAt: null });

      // Everything financial stops; visitors, tickets and emergency go on.
      const family = await x.as(
        hm.c,
        { id: hm.family.accountId, type: 'family' },
        () => caps.mine(hm.unitId),
      );
      const primary = await asPrimary(hm, () => caps.mine(hm.unitId));
      for (const cap of [family, primary]) {
        expect(cap).toMatchObject({
          financeView: false,
          financePay: false,
          emergency: true,
          visitorsNotify: true,
        });
      }
      expect(primary.tickets).toBe(true);

      // The adults are told the unit is under review — never why.
      const notices = await mail(hm.c, 'community.unit_under_review');
      expect(notices.map((n) => n.recipientAccountId).sort()).toEqual(
        [hm.primary.id, hm.family.accountId].sort(),
      );
      expect(JSON.stringify(notices.map((n) => n.params))).not.toContain(
        'certificate',
      );
      const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'unit.household_review_flagged',
        targetId: hm.unitId,
      });
      expect(entry.metadata).toMatchObject({
        reason: 'primary_deceased',
        reasonCode: 'deceased',
      });
      expect(JSON.stringify(entry)).not.toContain('certificate');

      // The manager lists it and settles it; the freeze lifts.
      const review = await x.asManager(hm.c, () =>
        x.residents.unitsNeedingReview(),
      );
      const flag = review.items.find((i) => i.unitId === hm.unitId)!;
      expect(flag.reason).toBe('primary_deceased');
      await x.asManager(hm.c, () =>
        x.residents.clearReviewFlag(flag.flagId, 'resolved'),
      );
      await asPrimary(hm, () => households.addMinor(hm.unitId, minor()));
    });

    it('a new primary settles it too', async () => {
      const hm = await home();
      const t = await x.resident(hm.c, [hm.unitId], 'tenant');
      await x.asManager(hm.c, () =>
        x.residents.markPrimaryDeceased(hm.unitId, DECEASED),
      );
      await x.asManager(hm.c, () => x.residents.setPrimary(hm.unitId, t.id));
      expect(await x.openReviews(hm.c, hm.unitId)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  describe('separation', () => {
    it("an adult's access is a manager decision; activity stops; visitor notices go on", async () => {
      const hm = await home();
      const kid = await asPrimary(hm, () =>
        households.addMinor(hm.unitId, minor()),
      );
      await x.asManager(hm.c, () =>
        x.residents.tagSeparation(hm.unitId, SEPARATED),
      );

      expect(
        await codeOf(
          asPrimary(hm, () =>
            households.removeMember(hm.family.memberId, {
              code: 'other',
              text: 'out',
            }),
          ),
        ),
      ).toBe('SEPARATION_MANAGER_DECISION');
      // A child without an account is not "an adult's access".
      await asPrimary(hm, () =>
        households.removeMember(kid.id, {
          code: 'other',
          text: 'moved to school',
        }),
      );

      const family = await x.as(
        hm.c,
        { id: hm.family.accountId, type: 'family' },
        () => caps.mine(hm.unitId),
      );
      expect(family).toMatchObject({
        activityVisibleToPrimary: false,
        emergency: true,
        visitorsNotify: true,
      });
      expect(
        (await mail(hm.c, 'community.activity_paused'))
          .map((n) => n.recipientAccountId)
          .sort(),
      ).toEqual([hm.primary.id, hm.family.accountId].sort());

      await x.asManager(hm.c, () =>
        households.removeMemberByManagement(hm.family.memberId, {
          code: 'separation',
          text: 'Court decision',
        }),
      );
      const [removed] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'household.member_removed',
        targetId: hm.family.memberId,
      });
      expect(removed).toMatchObject({
        actorId: hm.c.managerId,
        metadata: { byManagement: true, reasonCode: 'separation' },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('change of primary', () => {
    it('members are told, keep their permissions, and appear on the new primary’s review list; history keeps its actors', async () => {
      const hm = await home();
      const kid = await asPrimary(hm, () =>
        households.addMinor(hm.unitId, minor()),
      );
      await asPrimary(hm, () =>
        delegations.create(
          hm.unitId,
          hm.family.accountId,
          ['household'],
          inAYear(),
        ),
      );
      const t = await x.resident(hm.c, [hm.unitId], 'tenant');
      await x.asManager(hm.c, () => x.residents.setPrimary(hm.unitId, t.id));

      expect(
        (await mail(hm.c, 'community.primary_changed')).map(
          (n) => n.recipientAccountId,
        ),
      ).toEqual([hm.family.accountId]);
      // The old primary's delegation ended, and both sides were told.
      const ended = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'household.delegation_ended',
      });
      expect(ended.map((e) => e.metadata)).toEqual([
        expect.objectContaining({ reason: 'primary_changed' }),
      ]);

      const asNew = <T>(fn: () => Promise<T>) =>
        x.as(hm.c, { id: t.id, type: 'resident' }, fn);
      const toReview = await asNew(() =>
        x.residents.membersToReview(hm.unitId),
      );
      expect(toReview.map((m) => m.memberId).sort()).toEqual(
        [hm.family.memberId, kid.id].sort(),
      );
      expect(
        await codeOf(
          asPrimary(hm, () => x.residents.membersToReview(hm.unitId)),
        ),
      ).toBe('NOT_PRIMARY_RESIDENT');
      await asNew(() => x.residents.markMembersReviewed(hm.unitId, [kid.id]));
      expect(
        (await asNew(() => x.residents.membersToReview(hm.unitId))).map(
          (m) => m.memberId,
        ),
      ).toEqual([hm.family.memberId]);
      await asNew(() => x.residents.markMembersReviewed(hm.unitId, 'all'));
      expect(await asNew(() => x.residents.membersToReview(hm.unitId))).toEqual(
        [],
      );

      // Nothing is attributed to the new primary.
      const [added] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'household.member_added',
        targetId: kid.id,
      });
      expect(added.actorId).toBe(hm.primary.id);
      expect(
        await x.asManager(hm.c, () =>
          x.prisma.tenant.householdMember.findUniqueOrThrow({
            where: { id: kid.id },
          }),
        ),
      ).toMatchObject({ addedById: hm.primary.id, status: 'active' });
    });
  });

  // --------------------------------------------------------------------------
  describe('when the primary left', () => {
    it('only a decision resolves it: a flag cannot just be cleared', async () => {
      const hm = await home();
      const [o] = await x.occupancies(hm.c, hm.unitId);
      await x.asManager(hm.c, () => x.residents.endOccupancy(o.id, MOVED_OUT));
      const [flag] = (
        await x.asManager(hm.c, () => x.residents.unitsNeedingReview())
      ).items;
      expect(
        await codeOf(
          x.asManager(hm.c, () =>
            x.residents.clearReviewFlag(flag.flagId, 'resolved'),
          ),
        ),
      ).toBe('REVIEW_NEEDS_DECISION');
    });

    it('endHousehold: every membership, invite, delegation and worker ends, each person told; the flag closes', async () => {
      const hm = await home();
      await asPrimary(hm, () => households.addMinor(hm.unitId, minor()));
      const invite = await asPrimary(hm, () =>
        households.createInvite(hm.unitId, adult()),
      );
      await asPrimary(hm, () =>
        delegations.create(
          hm.unitId,
          hm.family.accountId,
          ['workers'],
          inAYear(),
        ),
      );
      const reg = await asPrimary(hm, () =>
        workers.register(hm.unitId, {
          fullName: 'Worker States',
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
          phone: uniquePhone(),
          capacity: 'live_in',
        }),
      );
      await x.asManager(hm.c, () =>
        workers.review(reg.engagementId, 'approve'),
      );
      const [o] = await x.occupancies(hm.c, hm.unitId);
      await x.asManager(hm.c, () => x.residents.endOccupancy(o.id, MOVED_OUT));

      await x.asManager(hm.c, () => x.residents.endHousehold(hm.unitId, SOLD));

      const rows = await x.asManager(hm.c, () =>
        Promise.all([
          x.prisma.tenant.householdMember.findMany({
            where: { unitId: hm.unitId },
          }),
          x.prisma.tenant.householdInvite.findUniqueOrThrow({
            where: { id: invite.inviteId },
          }),
          x.prisma.tenant.householdDelegation.findMany({
            where: { unitId: hm.unitId },
          }),
          x.prisma.tenant.workerEngagement.findUniqueOrThrow({
            where: { id: reg.engagementId },
          }),
          x.prisma.tenant.workerNotice.findMany({
            where: { engagementId: reg.engagementId },
          }),
          x.prisma.tenant.workerWageObligation.findMany({
            where: { engagementId: reg.engagementId },
          }),
        ]),
      );
      const [members, inv, dels, engagement, notices, obligations] = rows;
      expect(members.map((m) => m.status)).toEqual(['removed', 'removed']);
      expect(inv.status).toBe('revoked');
      // Already ended when the primary left (their delegations end with them).
      expect(dels.map((d) => d.endReason)).toEqual(['primary_changed']);
      expect(engagement).toMatchObject({
        status: 'ended',
        accessCodeHash: null,
      });
      expect(notices.map((n) => n.noticeKey)).toContain('engagement_ended');
      expect(obligations.map((ob) => ob.kind)).toEqual(['settle_before_close']);
      expect(await x.openReviews(hm.c, hm.unitId)).toEqual([]);

      // The adult is told with the reason; the child has an undeliverable record.
      const removed = await mail(hm.c, 'household.member_removed');
      expect(
        removed.find((m) => m.recipientAccountId === hm.family.accountId),
      ).toMatchObject({
        params: expect.objectContaining({
          reason: 'The unit was sold',
        }) as object,
      });
      expect(
        removed.filter((m) => m.lastErrorCode === 'NO_RECIPIENT'),
      ).toHaveLength(1);
      const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'unit.household_ended',
        targetId: hm.unitId,
      });
      expect(entry.metadata).toEqual({
        reasonCode: 'unit_changed_hands',
        membersEnded: 2,
        invitesRevoked: 1,
        engagementsEnded: 1,
      });
    });

    it('a worker who never had a code leaves no wage obligation', async () => {
      const hm = await home();
      const reg = await asPrimary(hm, () =>
        workers.register(hm.unitId, {
          fullName: 'Worker Pending',
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
          phone: uniquePhone(),
          capacity: 'live_in',
        }),
      );
      await x.asManager(hm.c, () => x.residents.endHousehold(hm.unitId, SOLD));
      expect(
        await x.asManager(hm.c, () =>
          x.prisma.tenant.workerWageObligation.count({
            where: { engagementId: reg.engagementId },
          }),
        ),
      ).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  describe('transfer of ownership', () => {
    it('ends every occupancy and the household; the buyer becomes the primary; the old family keeps nothing', async () => {
      const hm = await home();
      const tenant = await x.resident(hm.c, [hm.unitId], 'tenant');
      const buyer = await x.resident(hm.c, [(await x.unit(hm.c)).id]);
      const view = await x.asManager(hm.c, () =>
        x.residents.transferOwnership(
          hm.unitId,
          { toAccountId: buyer.id },
          SOLD,
        ),
      );
      expect(view).toMatchObject({ isPrimary: true, occupancyType: 'owner' });
      const occupancies = await x.occupancies(hm.c, hm.unitId);
      expect(
        occupancies
          .filter((o) => o.accountId !== buyer.id)
          .map((o) => [o.status, o.endReason]),
      ).toEqual([
        ['ended', 'ownership_transferred'],
        ['ended', 'ownership_transferred'],
      ]);
      expect(
        (await mail(hm.c, 'community.occupancy_ended'))
          .map((m) => m.recipientAccountId)
          .sort(),
      ).toEqual([hm.primary.id, tenant.id].sort());
      // The old family keeps nothing: no place in the unit at all, so the
      // unit is not found (API v0: never an all-false record).
      expect(
        await codeOf(
          x.as(hm.c, { id: hm.family.accountId, type: 'family' }, () =>
            caps.mine(hm.unitId),
          ),
        ),
      ).toBe('UNIT_NOT_FOUND');
      expect(await x.openReviews(hm.c, hm.unitId)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  it("tenant B can neither flag A's units nor clear A's flags", async () => {
    const a = await home();
    const b = await x.compound();
    expect(
      await codeOf(
        x.asManager(b, () =>
          x.residents.markPrimaryDeceased(a.unitId, DECEASED),
        ),
      ),
    ).toBe('UNIT_NOT_FOUND');
    const { flagId } = await x.asManager(a.c, () =>
      x.residents.tagSeparation(a.unitId, SEPARATED),
    );
    expect(
      await codeOf(
        x.asManager(b, () => x.residents.clearReviewFlag(flagId, 'resolved')),
      ),
    ).toBe('REVIEW_FLAG_NOT_FOUND');
    expect(
      await codeOf(
        x.asManager(b, () => x.residents.endHousehold(a.unitId, SOLD)),
      ),
    ).toBe('UNIT_NOT_FOUND');
  });
});
