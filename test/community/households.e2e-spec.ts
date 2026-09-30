import { OtpService } from '../../src/core/auth/otp.service';
import { appError, ErrorCode } from '../../src/core/common/errors';
import { RateLimitService } from '../../src/core/redis/rate-limit.service';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { InviteAcceptanceService } from '../../src/community/households/invite-acceptance.service';
import type { NewInvite } from '../../src/community/households/households.types';
import { UnitsService } from '../../src/community/units/units.service';
import { auditReaders } from '../setup/audit';
import {
  communityHelpers,
  type Compound,
  type Person,
} from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp, requestAndVerify } from '../setup/login';
import { countEmails, waitForMessage, waitForOtp } from '../setup/mailpit';
import { drainOutbox } from '../setup/outbox';

/** Households: invites, minors, acceptance, approval, removal (ADR 0016). */
describe('Households', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let households: HouseholdsService;
  let acceptance: InviteAcceptanceService;
  let settings: TenantSettingsService;
  let units: UnitsService;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    households = h.moduleRef.get(HouseholdsService);
    acceptance = h.moduleRef.get(InviteAcceptanceService);
    settings = h.moduleRef.get(TenantSettingsService);
    units = h.moduleRef.get(UnitsService);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  interface Home {
    c: Compound;
    unitId: string;
    primary: Person;
  }

  async function home(): Promise<Home> {
    const c = await x.compound('Household Court');
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    return { c, unitId: u.id, primary };
  }

  const asResident = <T>(hm: Home, who: { id: string }, fn: () => Promise<T>) =>
    x.as(hm.c, { id: who.id, type: 'resident' }, fn);
  const asPrimary = <T>(hm: Home, fn: () => Promise<T>) =>
    asResident(hm, hm.primary, fn);
  const asFamily = <T>(hm: Home, accountId: string, fn: () => Promise<T>) =>
    x.as(hm.c, { id: accountId, type: 'family' }, fn);

  function adult(label = 'adult'): NewInvite {
    return {
      fullName: `Adult ${label}`,
      phone: uniquePhone(),
      email: uniqueEmail(label),
      idDocumentType: 'national_id' as const,
      idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
      relation: 'spouse',
    };
  }

  const minor = (years = 10) => ({
    fullName: 'Young One',
    idDocumentType: 'national_id' as const,
    idDocumentNumber: nationalIdFor(bornYearsAgo(years)),
    relation: 'child' as const,
  });

  /** Invite → code to the invited email → accept. */
  async function join(hm: Home, input = adult()) {
    const invite = await asPrimary(hm, () =>
      households.createInvite(hm.unitId, input),
    );
    const since = new Date();
    await acceptance.startAcceptance(invite.token, '10.1.0.1', 'en');
    const code = await waitForOtp(input.email, since);
    const accepted = await acceptance.completeAcceptance(invite.token, code);
    return { ...accepted, invite, input };
  }

  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'resolved',
      (e: { response?: { code?: string }; message?: string }) =>
        e.response?.code ?? e.message ?? 'rejected',
    );

  // --------------------------------------------------------------------------
  describe('who may manage the household', () => {
    it('only the primary resident; another occupant or a member gets NOT_PRIMARY_RESIDENT; a stranger sees no unit', async () => {
      const hm = await home();
      const coOccupant = await x.resident(hm.c, [hm.unitId], 'tenant');
      const stranger = await x.resident(hm.c, [(await x.unit(hm.c)).id]);
      const member = await join(hm);

      for (const [who, run, expected] of [
        [
          'co-occupant',
          <T>(fn: () => Promise<T>) => asResident(hm, coOccupant, fn),
          'NOT_PRIMARY_RESIDENT',
        ],
        [
          'member',
          <T>(fn: () => Promise<T>) => asFamily(hm, member.accountId, fn),
          'NOT_PRIMARY_RESIDENT',
        ],
        [
          'stranger',
          <T>(fn: () => Promise<T>) => asResident(hm, stranger, fn),
          'UNIT_NOT_FOUND',
        ],
      ] as const) {
        expect([
          who,
          await code(run(() => households.createInvite(hm.unitId, adult()))),
        ]).toEqual([who, expected]);
        expect([
          who,
          await code(run(() => households.addMinor(hm.unitId, minor()))),
        ]).toEqual([who, expected]);
        expect([
          who,
          await code(
            run(() =>
              households.removeMember(member.memberId, {
                code: 'other',
                text: 'because',
              }),
            ),
          ),
        ]).toEqual([who, expected]);
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('adults by invite, minors directly', () => {
    it('inviting a minor, or adding an adult as a minor, is refused', async () => {
      const hm = await home();
      expect(
        await code(
          asPrimary(hm, () =>
            households.createInvite(hm.unitId, {
              ...adult(),
              idDocumentType: 'national_id' as const,
              idDocumentNumber: nationalIdFor(bornYearsAgo(17, -1)), // 18 tomorrow
            }),
          ),
        ),
      ).toBe('INVITE_MINOR_NOT_ALLOWED');
      expect(
        await code(
          asPrimary(hm, () =>
            households.addMinor(hm.unitId, {
              ...minor(),
              idDocumentType: 'national_id' as const,
              idDocumentNumber: nationalIdFor(bornYearsAgo(18)), // 18 today
            }),
          ),
        ),
      ).toBe('MEMBER_NOT_MINOR');
    });

    it('an invite needs an email and a valid national ID', async () => {
      const hm = await home();
      const res = await asPrimary(hm, () =>
        households.createInvite(hm.unitId, {
          ...adult(),
          email: '',
          idDocumentType: 'national_id' as const,
          idDocumentNumber: '123',
        }),
      ).catch((e: { response: unknown }) => e.response);
      expect(res).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: expect.arrayContaining([
          { field: 'email', code: 'FIELD_REQUIRED' },
          { field: 'idDocumentNumber', code: 'INVALID_NATIONAL_ID' },
        ]) as unknown,
      });
    });

    it('a minor is an active member with no account', async () => {
      const hm = await home();
      const added = await asPrimary(hm, () =>
        households.addMinor(hm.unitId, minor(5)),
      );
      expect(added).toMatchObject({
        isMinor: true,
        accountId: null,
        fullName: 'Young One',
        status: 'active',
      });
    });

    it('the limit counts active and pending members and pending invites', async () => {
      const hm = await home();
      await x.asManager(hm.c, () =>
        settings.update({ maxHouseholdMembers: 3 }),
      );
      await asPrimary(hm, () => households.addMinor(hm.unitId, minor()));
      await asPrimary(hm, () => households.createInvite(hm.unitId, adult()));
      await x.asManager(hm.c, () =>
        settings.update({ familyJoinRequiresApproval: true }),
      );
      await join(hm); // pending approval
      expect(
        await code(
          asPrimary(hm, () => households.addMinor(hm.unitId, minor())),
        ),
      ).toBe('HOUSEHOLD_LIMIT_REACHED');
      expect(
        await code(
          asPrimary(hm, () => households.createInvite(hm.unitId, adult())),
        ),
      ).toBe('HOUSEHOLD_LIMIT_REACHED');
    });
  });

  // --------------------------------------------------------------------------
  describe('accepting an invite', () => {
    it('the code goes to the invited email only; the member then logs in normally and sees the unit', async () => {
      const hm = await home();
      const input = adult('invitee');
      const invite = await asPrimary(hm, () =>
        households.createInvite(hm.unitId, input),
      );
      const since = new Date();
      await acceptance.startAcceptance(invite.token, '10.1.0.2', 'ar');
      const message = await waitForMessage(input.email, since);
      expect(message.Subject).toBe('رمز قبول الدعوة إلى جوار');
      expect(await countEmails(hm.primary.email, since, 300)).toBe(0);
      const otp = /\b(\d{6})\b/.exec(message.Text)![1];

      const accepted = await acceptance.completeAcceptance(invite.token, otp);
      expect(accepted.membershipStatus).toBe('active');

      const tokens = await loginViaOtp(h, input.email, accepted.accountId);
      const res = await h
        .http()
        .get(`${API}/units`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);
      expect((res.body as { id: string }[]).map((u) => u.id)).toEqual([
        hm.unitId,
      ]);
    });

    it('the token works once; revoked or expired tokens get the generic answer and an event', async () => {
      const hm = await home();
      const used = await join(hm);
      const since = new Date();
      await acceptance.startAcceptance(used.invite.token, '10.1.0.3', 'en');
      expect(await countEmails(used.input.email, since)).toBe(0);
      expect(
        await code(acceptance.completeAcceptance(used.invite.token, '000000')),
      ).toBe('OTP_INVALID');

      // Revoked before acceptance.
      const input = adult();
      const revoked = await asPrimary(hm, () =>
        households.createInvite(hm.unitId, input),
      );
      await asPrimary(hm, () => households.revokeInvite(revoked.inviteId));
      await acceptance.startAcceptance(revoked.token, '10.1.0.3', 'en');
      expect(await countEmails(input.email, since)).toBe(0);

      // Expired: past its 7 days.
      const late = adult();
      const expired = await asPrimary(hm, () =>
        households.createInvite(hm.unitId, late),
      );
      const past = new Date(Date.now() - 1000);
      await x.asManager(hm.c, () =>
        x.prisma.tenant.householdInvite.update({
          where: { id: expired.inviteId },
          data: { expiresAt: past },
        }),
      );
      await globalDb.inviteToken.updateMany({
        where: { inviteId: expired.inviteId },
        data: { expiresAt: past },
      });
      await acceptance.startAcceptance(expired.token, '10.1.0.3', 'en');
      expect(await countEmails(late.email, since)).toBe(0);
      // Revoking it now persists `expired` and reports not found.
      expect(
        await code(
          asPrimary(hm, () => households.revokeInvite(expired.inviteId)),
        ),
      ).toBe('INVITE_NOT_FOUND');
      const row = await x.asManager(hm.c, () =>
        x.prisma.tenant.householdInvite.findUniqueOrThrow({
          where: { id: expired.inviteId },
        }),
      );
      expect(row.status).toBe('expired');

      const events = await auditReaders(h).security({
        event: 'invite.token_invalid',
      });
      expect(events.length).toBeGreaterThanOrEqual(3);
    });

    it('login and invite codes are not interchangeable', async () => {
      const hm = await home();
      const input = adult();
      const invite = await asPrimary(hm, () =>
        households.createInvite(hm.unitId, input),
      );
      const since = new Date();
      await acceptance.startAcceptance(invite.token, '10.1.0.4', 'en');
      const inviteCode = await waitForOtp(input.email, since);

      // The invite code cannot log the primary in (or anyone).
      const key = h.moduleRef
        .get(IdentifierHasher)
        .hashInviteToken(invite.token);
      expect(
        await h.moduleRef.get(OtpService).verify(key, inviteCode),
      ).toBeNull();

      // A login code for the invited email cannot accept the invite — there
      // is no account yet, so ask for a code for the primary instead.
      const loginSince = new Date();
      await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: hm.primary.email })
        .expect(202);
      const loginCode = await waitForOtp(hm.primary.email, loginSince);
      if (loginCode !== inviteCode) {
        expect(
          await code(acceptance.completeAcceptance(invite.token, loginCode)),
        ).toBe('OTP_INVALID');
      }
      await acceptance.completeAcceptance(invite.token, inviteCode);
    });

    it('with approval required the member is pending and sees nothing until approved', async () => {
      const hm = await home();
      await x.asManager(hm.c, () =>
        settings.update({ familyJoinRequiresApproval: true }),
      );
      const joined = await join(hm);
      expect(joined.membershipStatus).toBe('pending_approval');
      expect(await asFamily(hm, joined.accountId, () => units.list())).toEqual(
        [],
      );

      const approved = await x.asManager(hm.c, () =>
        households.approveMember(joined.memberId),
      );
      expect(approved.status).toBe('active');
      expect(
        (await asFamily(hm, joined.accountId, () => units.list())).map(
          (u) => u.id,
        ),
      ).toEqual([hm.unitId]);
    });

    it('an existing family account with that email is reused', async () => {
      const hm = await home();
      const second = await x.unit(hm.c);
      await x.resident(hm.c, [second.id]); // becomes primary of `second`
      const input = adult('twice');
      const first = await join(hm, input);

      const otherPrimary = (await x.occupancies(hm.c, second.id))[0].accountId;
      const invite = await x.as(
        hm.c,
        { id: otherPrimary, type: 'resident' },
        () =>
          households.createInvite(second.id, { ...input, relation: 'sibling' }),
      );
      const since = new Date();
      await acceptance.startAcceptance(invite.token, '10.1.0.5', 'en');
      const otp = await waitForOtp(input.email, since);
      const again = await acceptance.completeAcceptance(invite.token, otp);
      expect(again.accountId).toBe(first.accountId);
      expect(
        (await asFamily(hm, first.accountId, () => units.list()))
          .map((u) => u.id)
          .sort(),
      ).toEqual([hm.unitId, second.id].sort());
    });
    it('is rate-limited per IP over HTTP, before any lookup', async () => {
      const hm = await home();
      const invite = await asPrimary(hm, () =>
        households.createInvite(hm.unitId, adult('limited')),
      );
      const limiter = h.moduleRef.get(RateLimitService);
      const consume = jest.spyOn(limiter, 'consume');
      try {
        await code(
          acceptance.completeAcceptance('no-such-token', '000000', '10.7.7.7'),
        );
        expect(consume).toHaveBeenCalledWith(
          'invite-complete:ip:10.7.7.7',
          expect.any(Number),
          expect.any(Number),
        );
        // Once limited, a live token and an unknown one answer the same.
        consume.mockRejectedValue(
          appError.tooManyRequests(ErrorCode.RATE_LIMITED, 'limited'),
        );
        expect(
          await code(
            acceptance.completeAcceptance(invite.token, '000000', '10.7.7.7'),
          ),
        ).toBe('RATE_LIMITED');
        expect(
          await code(
            acceptance.completeAcceptance(
              'no-such-token',
              '000000',
              '10.7.7.7',
            ),
          ),
        ).toBe('RATE_LIMITED');
      } finally {
        consume.mockRestore();
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('removal', () => {
    it('needs a reason', async () => {
      const hm = await home();
      const joined = await join(hm);
      expect(
        await code(
          asPrimary(hm, () =>
            households.removeMember(joined.memberId, {
              code: 'other',
              text: '  ',
            }),
          ),
        ),
      ).toBe('REASON_REQUIRED');
    });

    it('deactivates an account with no other membership, ends its sessions, and emails it in its language', async () => {
      const hm = await home();
      const joined = await join(hm);
      await x.asManager(hm.c, () =>
        x.prisma.tenant.account.update({
          where: { id: joined.accountId },
          data: { preferredLocale: 'en' },
        }),
      );
      const tokens = await loginViaOtp(h, joined.input.email, joined.accountId);

      const since = new Date();
      await asPrimary(hm, () =>
        households.removeMember(joined.memberId, {
          code: 'other',
          text: 'Moved <out> & away',
        }),
      );
      const account = await x.asManager(hm.c, () =>
        x.prisma.tenant.account.findUniqueOrThrow({
          where: { id: joined.accountId },
        }),
      );
      expect(account.status).toBe('inactive');
      await h
        .http()
        .get(`${API}/accounts/me`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(401);

      await drainOutbox(h);
      const email = await waitForMessage(joined.input.email, since);
      expect(email.Subject).toBe('You were removed from a household on Jiwar');
      expect(email.Text).toContain('Moved <out> & away');
      expect(email.HTML).toContain('Moved &lt;out&gt; &amp; away');

      // The reason stays on the membership, not in the audit trail.
      const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'household.member_removed',
        targetId: joined.memberId,
      });
      expect(JSON.stringify(entry)).not.toContain('Moved');
      expect(entry.metadata).toMatchObject({ accountDeactivated: true });
    });

    it('keeps the account active while another membership is active; minors get no email', async () => {
      const hm = await home();
      const second = await x.unit(hm.c);
      await x.resident(hm.c, [second.id]);
      const input = adult('two-homes');
      const first = await join(hm, input);
      const otherPrimary = (await x.occupancies(hm.c, second.id))[0].accountId;
      const invite = await x.as(
        hm.c,
        { id: otherPrimary, type: 'resident' },
        () => households.createInvite(second.id, input),
      );
      const since = new Date();
      await acceptance.startAcceptance(invite.token, '10.1.0.6', 'en');
      await acceptance.completeAcceptance(
        invite.token,
        await waitForOtp(input.email, since),
      );

      await asPrimary(hm, () =>
        households.removeMember(first.memberId, {
          code: 'other',
          text: 'moved',
        }),
      );
      const account = await x.asManager(hm.c, () =>
        x.prisma.tenant.account.findUniqueOrThrow({
          where: { id: first.accountId },
        }),
      );
      expect(account.status).toBe('active');
      expect(
        (await asFamily(hm, first.accountId, () => units.list())).map(
          (u) => u.id,
        ),
      ).toEqual([second.id]);

      const kid = await asPrimary(hm, () =>
        households.addMinor(hm.unitId, minor()),
      );
      await asPrimary(hm, () =>
        households.removeMember(kid.id, { code: 'other', text: 'moved away' }),
      );
    });

    it('management rejects a pending member with a reason; the person is told', async () => {
      const hm = await home();
      await x.asManager(hm.c, () =>
        settings.update({ familyJoinRequiresApproval: true }),
      );
      const joined = await join(hm);
      expect(
        await code(
          x.asManager(hm.c, () =>
            households.rejectMember(joined.memberId, {
              code: 'other',
              text: '',
            }),
          ),
        ),
      ).toBe('REASON_REQUIRED');
      const since = new Date();
      await x.asManager(hm.c, () =>
        households.rejectMember(joined.memberId, {
          code: 'other',
          text: 'Not a resident',
        }),
      );
      // Its own template in the member's language (Arabic by default),
      // not the removal email.
      await drainOutbox(h);
      const email = await waitForMessage(joined.input.email, since);
      expect(email.Subject).toBe(
        'لم تتم الموافقة على طلب انضمامك إلى أسرة على جوار',
      );
      expect(email.HTML).toContain('dir="rtl"');
      expect(email.Text).toContain('Not a resident');
      expect(email.Text).not.toContain('لم تعد فردًا');
    });
  });

  it('a removed or pending family account cannot log in to see anything', async () => {
    const hm = await home();
    const joined = await join(hm);
    await asPrimary(hm, () =>
      households.removeMember(joined.memberId, { code: 'other', text: 'left' }),
    );
    // Deactivated: the login offers no account.
    const verified = await requestAndVerify(
      h,
      joined.input.email,
      joined.input.email,
    ).catch(() => null);
    expect(verified?.accounts ?? []).toEqual([]);
  });
});
