import { DelegationsService } from '../../src/community/households/delegations.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { InviteAcceptanceService } from '../../src/community/households/invite-acceptance.service';
import { MAJORITY_SWEEP } from '../../src/community/households/majority-notices';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { egyptToday } from '../../src/core/common/egyptian-national-id';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { auditReaders } from '../setup/audit';
import {
  communityHelpers,
  type Compound,
  type Person,
} from '../setup/community';
import { bornYearsAgo, codeOf, nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';

/** A minor turning 18 (ADR 0021): told, never raised automatically. */
describe('Minors reaching majority', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let households: HouseholdsService;
  let sweep: SweepRunner;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    households = h.moduleRef.get(HouseholdsService);
    sweep = h.moduleRef.get(SweepRunner);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  interface Home {
    c: Compound;
    unitId: string;
    primary: Person;
  }

  async function home(timezone?: string): Promise<Home> {
    const c = await x.compound('Majority Court');
    if (timezone) {
      await x.asManager(c, () =>
        h.moduleRef.get(TenantSettingsService).update({ timezone }),
      );
    }
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    return { c, unitId: u.id, primary };
  }

  const asPrimary = <T>(hm: Home, fn: () => Promise<T>) =>
    x.as(hm.c, { id: hm.primary.id, type: 'resident' }, fn);

  /** A minor who turns 18 in `days` days (Egypt calendar). */
  function addKid(hm: Home, days: number, name = 'Kid Majority') {
    return asPrimary(hm, () =>
      households.addMinor(hm.unitId, {
        fullName: name,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(18, -days)),
        relation: 'child',
      }),
    );
  }

  /** Time passes: the member is now exactly 18 (a test-only shortcut). */
  const ageToAdult = (hm: Home, memberId: string) =>
    x.asManager(hm.c, () =>
      x.prisma.tenant.householdMember.update({
        where: { id: memberId },
        data: { birthDate: bornYearsAgo(18) },
      }),
    );

  it('the sweep tells the primary once, on the birthday in the compound time zone; the minor’s notice is on file', async () => {
    const east = await home('Pacific/Kiritimati'); // UTC+14
    const west = await home('Pacific/Pago_Pago'); // UTC−11
    const kidEast = await addKid(east, 2, 'Kid East');
    const kidWest = await addKid(west, 2, 'Kid West');
    // The birthday (UTC date), 10:00 UTC: already the next day in
    // Kiritimati, still the day before in Pago Pago.
    const today = egyptToday();
    const now = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 2,
        10,
      ),
    );

    await sweep.run(MAJORITY_SWEEP, now);
    const row = (hm: Home, id: string) =>
      x.asManager(hm.c, () =>
        x.prisma.tenant.householdMember.findUniqueOrThrow({ where: { id } }),
      );
    expect((await row(east, kidEast.id)).majorityNotifiedAt).toBeInstanceOf(
      Date,
    );
    expect((await row(west, kidWest.id)).majorityNotifiedAt).toBeNull();
    // Nothing is raised automatically.
    expect(await row(east, kidEast.id)).toMatchObject({
      isMinor: true,
      accountId: null,
    });

    const mails = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: east.c.tenantId,
        templateKey: 'community.majority_reached',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(mails.map((m) => [m.recipientAccountId, m.lastErrorCode])).toEqual(
      expect.arrayContaining([
        [east.primary.id, null],
        [null, 'NO_RECIPIENT'],
      ]),
    );
    expect(mails.find((m) => m.recipientAccountId)?.params).toMatchObject({
      memberName: 'Kid East',
    });
    const [entry] = await auditReaders(h).tenant(east.c.tenantId, {
      action: 'household.member_majority_reached',
      targetId: kidEast.id,
    });
    expect(entry).toMatchObject({
      actorType: 'system',
      actorId: null,
      metadata: { primaryTold: true, noticeUndeliverable: true },
    });

    // Idempotent: a second run (or instance) tells nobody again.
    await sweep.run(MAJORITY_SWEEP, now);
    expect(
      await globalDb.outboxMessage.count({
        where: {
          tenantId: east.c.tenantId,
          templateKey: 'community.majority_reached',
        },
      }),
    ).toBe(2);
    // The day after, the west compound's kid is told too.
    await sweep.run(MAJORITY_SWEEP, new Date(now.getTime() + 86_400_000));
    expect((await row(west, kidWest.id)).majorityNotifiedAt).toBeInstanceOf(
      Date,
    );
  });

  it('"ready to confirm" lists minors who are 18 today; only the primary sees it', async () => {
    const hm = await home();
    const kid = await addKid(hm, 1);
    expect(
      await asPrimary(hm, () => households.minorsReadyToConfirm(hm.unitId)),
    ).toEqual([]);
    await ageToAdult(hm, kid.id);
    expect(
      (
        await asPrimary(hm, () => households.minorsReadyToConfirm(hm.unitId))
      ).map((m) => m.id),
    ).toEqual([kid.id]);
  });

  it('the primary confirms with an invite linked to the same member; acceptance keeps the history continuous', async () => {
    const hm = await home();
    const kid = await addKid(hm, 1, 'Kid Grows Up');
    const email = uniqueEmail('adult');
    const contact = { email, phone: uniquePhone() };
    expect(
      await codeOf(
        asPrimary(hm, () =>
          households.inviteMemberToAdulthood(kid.id, contact),
        ),
      ),
    ).toBe('MEMBER_NOT_YET_ADULT');
    await ageToAdult(hm, kid.id);

    // A household delegate cannot lift a minor's status.
    const family = await x.joinFamily(hm.c, hm.unitId, hm.primary);
    await asPrimary(hm, () =>
      h.moduleRef
        .get(DelegationsService)
        .create(
          hm.unitId,
          family.accountId,
          ['household'],
          new Date(Date.now() + 86_400_000),
        ),
    );
    expect(
      await codeOf(
        x.as(hm.c, { id: family.accountId, type: 'family' }, () =>
          households.inviteMemberToAdulthood(kid.id, contact),
        ),
      ),
    ).toBe('NOT_PRIMARY_RESIDENT');

    const invite = await asPrimary(hm, () =>
      households.inviteMemberToAdulthood(kid.id, contact),
    );
    expect(
      await codeOf(
        asPrimary(hm, () =>
          households.inviteMemberToAdulthood(kid.id, contact),
        ),
      ),
    ).toBe('MAJORITY_INVITE_PENDING');
    // Already counted: the invite does not take another place.
    expect(
      (await asPrimary(hm, () => x.residents.myUnits()))[0].household,
    ).toEqual({ memberCount: 2, pendingInvites: 0 });

    const acceptance = h.moduleRef.get(InviteAcceptanceService);
    const since = new Date();
    await acceptance.startAcceptance(invite.token, '10.9.9.8', 'en');
    const accepted = await acceptance.completeAcceptance(
      invite.token,
      await waitForOtp(email, since),
    );
    expect(accepted).toMatchObject({
      memberId: kid.id,
      membershipStatus: 'active',
    });

    const member = await x.asManager(hm.c, () =>
      x.prisma.tenant.householdMember.findUniqueOrThrow({
        where: { id: kid.id },
        include: { account: true },
      }),
    );
    expect(member).toMatchObject({
      isMinor: false,
      accountId: accepted.accountId,
      fullName: null,
      idDocumentNumber: null,
    });
    expect(member.account).toMatchObject({
      type: 'family',
      fullName: 'Kid Grows Up',
    });
    const perms = await x.as(
      hm.c,
      { id: accepted.accountId, type: 'family' },
      () => h.moduleRef.get(MemberPermissionsService).myPermissions(hm.unitId),
    );
    expect(perms.memberId).toBe(kid.id);
    expect(perms.grants.map((g) => g.permission).sort()).toEqual([
      'bookings',
      'tickets',
      'visitors_invite',
    ]);

    const read = auditReaders(h);
    const [came] = await read.tenant(hm.c.tenantId, {
      action: 'household.member_came_of_age',
      targetId: kid.id,
    });
    expect(came).toMatchObject({
      actorType: 'system',
      metadata: { confirmedBy: hm.primary.id, accountId: accepted.accountId },
    });
    // The earlier history still points at the same member, by the same actor.
    const [added] = await read.tenant(hm.c.tenantId, {
      action: 'household.member_added',
      targetId: kid.id,
    });
    expect(added.actorId).toBe(hm.primary.id);
    const [told] = await globalDb.outboxMessage.findMany({
      where: { tenantId: hm.c.tenantId, templateKey: 'community.came_of_age' },
    });
    expect(told.recipientAccountId).toBe(accepted.accountId);
  });

  it("tenant B can't invite A's minor", async () => {
    const a = await home();
    const b = await home();
    const kid = await addKid(a, 1);
    await ageToAdult(a, kid.id);
    expect(
      await codeOf(
        asPrimary(b, () =>
          households.inviteMemberToAdulthood(kid.id, {
            email: uniqueEmail('x'),
            phone: uniquePhone(),
          }),
        ),
      ),
    ).toBe('HOUSEHOLD_MEMBER_NOT_FOUND');
  });
});
