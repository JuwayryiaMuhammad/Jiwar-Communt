import { AccountsService } from '../../src/core/accounts/accounts.service';
import { newId } from '../../src/core/common/uuid';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import type { NewInvite } from '../../src/community/households/households.types';
import { auditReaders } from '../setup/audit';
import {
  communityHelpers,
  type Compound,
  type Person,
} from '../setup/community';
import { bornYearsAgo, nationalIdFor, MOVED_OUT } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { drainOutbox } from '../setup/outbox';
import { waitForMessage } from '../setup/mailpit';

/** Primary resident → adult household member, scoped and time-boxed (ADR 0016). */
describe('Delegation', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let delegations: DelegationsService;
  let households: HouseholdsService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    delegations = h.moduleRef.get(DelegationsService);
    households = h.moduleRef.get(HouseholdsService);
  });

  afterAll(() => h.close());

  interface Home {
    c: Compound;
    unitId: string;
    primary: Person;
    member: { id: string; email: string; memberId: string };
  }

  async function home(): Promise<Home> {
    const c = await x.compound('Delegation Court');
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const member = await x.joinFamily(c, u.id, primary);
    return { c, unitId: u.id, primary, member };
  }

  const asPrimary = <T>(hm: Home, fn: () => Promise<T>) =>
    x.as(hm.c, { id: hm.primary.id, type: 'resident' }, fn);
  const asFamily = <T>(hm: Home, id: string, fn: () => Promise<T>) =>
    x.as(hm.c, { id, type: 'family' }, fn);

  const inMonths = (months: number) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + months);
    return d;
  };

  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'resolved',
      (e: { response?: { code?: string }; message?: string }) =>
        e.response?.code ?? e.message ?? 'rejected',
    );

  const adult = (): NewInvite => ({
    fullName: 'Invited By Delegate',
    phone: uniquePhone(),
    email: uniqueEmail('by-delegate'),
    idDocumentType: 'national_id' as const,
    idDocumentNumber: nationalIdFor(bornYearsAgo(40)),
    relation: 'parent',
  });

  const delegate = (
    hm: Home,
    scopes: ('household' | 'workers')[] = ['household'],
    to = hm.member.id,
  ) =>
    asPrimary(hm, () => delegations.create(hm.unitId, to, scopes, inMonths(6)));

  // --------------------------------------------------------------------------
  describe('who may delegate, and to whom', () => {
    it('only the primary; a co-occupant gets NOT_PRIMARY_RESIDENT and a delegate DELEGATION_NOT_ALLOWED', async () => {
      const hm = await home();
      const coOccupant = await x.resident(hm.c, [hm.unitId], 'tenant');
      expect(
        await code(
          x.as(hm.c, { id: coOccupant.id, type: 'resident' }, () =>
            delegations.create(
              hm.unitId,
              hm.member.id,
              ['household'],
              inMonths(1),
            ),
          ),
        ),
      ).toBe('NOT_PRIMARY_RESIDENT');

      await delegate(hm);
      const other = await x.joinFamily(hm.c, hm.unitId, hm.primary);
      expect(
        await code(
          asFamily(hm, hm.member.id, () =>
            delegations.create(hm.unitId, other.id, ['workers'], inMonths(1)),
          ),
        ),
      ).toBe('DELEGATION_NOT_ALLOWED');
    });

    it('a minor, a pending member or another unit’s member is not eligible', async () => {
      const hm = await home();

      // An account under 18 (the membership says adult, the ID says minor).
      const young = await x.asManager(hm.c, () =>
        h.moduleRef.get(AccountsService).create({
          type: 'family',
          fullName: 'Too Young',
          idDocumentType: 'national_id' as const,
          idDocumentNumber: nationalIdFor(bornYearsAgo(16)),
          phone: uniquePhone(),
          email: uniqueEmail('young'),
        }),
      );
      await x.asManager(hm.c, () =>
        x.prisma.tenant.householdMember.create({
          data: {
            id: newId(),
            tenantId: hm.c.tenantId,
            unitId: hm.unitId,
            accountId: young.id,
            relation: 'child',
            isMinor: false,
            birthDate: bornYearsAgo(16),
            status: 'active',
            addedById: hm.primary.id,
          },
        }),
      );
      expect(await code(delegate(hm, ['household'], young.id))).toBe(
        'DELEGATE_NOT_ELIGIBLE',
      );

      await x.asManager(hm.c, () =>
        h.moduleRef
          .get(TenantSettingsService)
          .update({ familyJoinRequiresApproval: true }),
      );
      const pending = await x.joinFamily(hm.c, hm.unitId, hm.primary);
      expect(await code(delegate(hm, ['household'], pending.id))).toBe(
        'DELEGATE_NOT_ELIGIBLE',
      );

      const elsewhere = await x.unit(hm.c);
      const otherPrimary = await x.resident(hm.c, [elsewhere.id]);
      await x.asManager(hm.c, () =>
        h.moduleRef
          .get(TenantSettingsService)
          .update({ familyJoinRequiresApproval: false }),
      );
      const outsider = await x.joinFamily(hm.c, elsewhere.id, otherPrimary);
      expect(await code(delegate(hm, ['household'], outsider.id))).toBe(
        'DELEGATE_NOT_ELIGIBLE',
      );
    });

    it('expiresAt is required, in the future and at most a year away', async () => {
      const hm = await home();
      for (const expiresAt of [
        undefined as unknown as Date,
        new Date(Date.now() - 1000),
        inMonths(13),
      ]) {
        expect(
          await asPrimary(hm, () =>
            delegations.create(
              hm.unitId,
              hm.member.id,
              ['household'],
              expiresAt,
            ),
          ).catch((e: { response: unknown }) => e.response),
        ).toMatchObject({
          code: 'VALIDATION_FAILED',
          fields: [{ field: 'expiresAt', code: 'INVALID_VALUE' }],
        });
      }
      expect(
        await code(
          asPrimary(hm, () =>
            delegations.create(hm.unitId, hm.member.id, [], inMonths(1)),
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      const ok = await asPrimary(hm, () =>
        delegations.create(
          hm.unitId,
          hm.member.id,
          ['household'],
          inMonths(11),
        ),
      );
      expect(ok.scopes).toEqual(['household']);
      // One live delegation per member and unit.
      expect(await code(delegate(hm))).toBe('DUPLICATE_RESOURCE');
    });
  });

  // --------------------------------------------------------------------------
  describe('what a delegate may do', () => {
    it('a household delegate invites and removes others on behalf of the primary, but never themselves', async () => {
      const hm = await home();
      await delegate(hm, ['household']);
      const invite = await asFamily(hm, hm.member.id, () =>
        households.createInvite(hm.unitId, adult()),
      );
      const [created] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'household.invite_created',
        targetId: invite.inviteId,
      });
      expect(created).toMatchObject({
        actorId: hm.member.id,
        metadata: { onBehalfOf: hm.primary.id },
      });

      const kid = await asFamily(hm, hm.member.id, () =>
        households.addMinor(hm.unitId, {
          fullName: 'Kid',
          idDocumentType: 'national_id' as const,
          idDocumentNumber: nationalIdFor(bornYearsAgo(6)),
          relation: 'child',
        }),
      );
      await asFamily(hm, hm.member.id, () =>
        households.removeMember(kid.id, {
          code: 'other',
          text: 'moved to grandparents',
        }),
      );
      const [removed] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'household.member_removed',
        targetId: kid.id,
      });
      expect(removed.metadata).toMatchObject({ onBehalfOf: hm.primary.id });

      expect(
        await code(
          asFamily(hm, hm.member.id, () =>
            households.removeMember(hm.member.memberId, {
              code: 'other',
              text: 'leaving',
            }),
          ),
        ),
      ).toBe('DELEGATION_NOT_ALLOWED');
      const own = await x.asManager(hm.c, () =>
        x.prisma.tenant.householdDelegation.findFirstOrThrow({
          where: { unitId: hm.unitId },
        }),
      );
      expect(
        await code(
          asFamily(hm, hm.member.id, () => delegations.revoke(own.id)),
        ),
      ).toBe('DELEGATION_NOT_ALLOWED');
    });

    it('a workers delegate cannot touch the household', async () => {
      const hm = await home();
      await delegate(hm, ['workers']);
      expect(
        await code(
          asFamily(hm, hm.member.id, () =>
            households.createInvite(hm.unitId, adult()),
          ),
        ),
      ).toBe('NOT_PRIMARY_RESIDENT');
    });

    it('an expired delegation is refused at use time (no job ends it), and can be replaced', async () => {
      const hm = await home();
      const d = await delegate(hm);
      await x.asManager(hm.c, () =>
        x.prisma.tenant.householdDelegation.update({
          where: { id: d.id },
          data: {
            createdAt: new Date(Date.now() - 2 * 86_400_000),
            expiresAt: new Date(Date.now() - 1000),
          },
        }),
      );
      expect(
        await code(
          asFamily(hm, hm.member.id, () =>
            households.createInvite(hm.unitId, adult()),
          ),
        ),
      ).toBe('DELEGATION_EXPIRED');

      const renewed = await delegate(hm);
      const old = await x.asManager(hm.c, () =>
        x.prisma.tenant.householdDelegation.findUniqueOrThrow({
          where: { id: d.id },
        }),
      );
      expect(old.endReason).toBe('expired');
      expect(renewed.id).not.toBe(d.id);
    });
  });

  // --------------------------------------------------------------------------
  describe('my delegations', () => {
    it("lists live ones on both sides, by the other side's name, never expired or revoked", async () => {
      const hm = await home();
      const d = await delegate(hm, ['workers']);

      const held = await asFamily(hm, hm.member.id, () => delegations.mine());
      expect(held).toEqual([
        {
          id: d.id,
          unitId: hm.unitId,
          unitCode: expect.any(String) as string,
          role: 'delegate',
          counterpart: {
            id: hm.primary.id,
            fullName: hm.primary.fullName,
            status: 'active',
          },
          scopes: ['workers'],
          expiresAt: d.expiresAt,
        },
      ]);
      const given = await asPrimary(hm, () => delegations.mine());
      expect(given.map((g) => [g.id, g.role, g.counterpart.id])).toEqual([
        [d.id, 'delegator', hm.member.id],
      ]);

      // Expired: gone from the list at once, although not ended yet.
      await x.asManager(hm.c, () =>
        x.prisma.tenant.householdDelegation.update({
          where: { id: d.id },
          data: {
            createdAt: new Date(Date.now() - 2 * 86_400_000),
            expiresAt: new Date(Date.now() - 1000),
          },
        }),
      );
      expect(await asPrimary(hm, () => delegations.mine())).toEqual([]);

      const renewed = await delegate(hm);
      await asPrimary(hm, () => delegations.revoke(renewed.id));
      expect(
        await asFamily(hm, hm.member.id, () => delegations.mine()),
      ).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  describe('ends — never silently', () => {
    async function endReason(hm: Home, id: string) {
      return (
        await x.asManager(hm.c, () =>
          x.prisma.tenant.householdDelegation.findUniqueOrThrow({
            where: { id },
          }),
        )
      ).endReason;
    }

    it('both sides are emailed on create and revoke', async () => {
      const hm = await home();
      let since = new Date();
      const d = await delegate(hm, ['household', 'workers']);
      for (const to of [hm.primary.email, hm.member.email]) {
        await drainOutbox(h);
        const m = await waitForMessage(to, since);
        expect(m.Subject).toMatch(
          /New delegation on Jiwar|تفويض جديد على جوار/,
        );
      }
      since = new Date();
      await asPrimary(hm, () => delegations.revoke(d.id));
      expect(await endReason(hm, d.id)).toBe('revoked');
      for (const to of [hm.primary.email, hm.member.email]) {
        await drainOutbox(h);
        const m = await waitForMessage(to, since);
        expect(m.Subject).toMatch(/revoked|تم إلغاء تفويض/);
      }
    });

    it('when the delegate leaves the household', async () => {
      const hm = await home();
      const d = await delegate(hm);
      await drainOutbox(h); // the "created" emails, out of the way
      const since = new Date();
      await asPrimary(hm, () =>
        households.removeMember(hm.member.memberId, {
          code: 'other',
          text: 'moved out',
        }),
      );
      expect(await endReason(hm, d.id)).toBe('member_removed');
      await drainOutbox(h);
      const m = await waitForMessage(hm.primary.email, since);
      expect(m.Subject).toMatch(/ended|انتهى تفويض/);
    });

    it('when the primary changes', async () => {
      const hm = await home();
      const d = await delegate(hm);
      const next = await x.resident(hm.c, [hm.unitId], 'tenant');
      await x.asManager(hm.c, () => x.residents.setPrimary(hm.unitId, next.id));
      expect(await endReason(hm, d.id)).toBe('primary_changed');
    });

    it('when the primary leaves the unit', async () => {
      const hm = await home();
      const d = await delegate(hm);
      const occupancy = (await x.occupancies(hm.c, hm.unitId))[0];
      await x.asManager(hm.c, () =>
        x.residents.endOccupancy(occupancy.id, MOVED_OUT),
      );
      expect(await endReason(hm, d.id)).toBe('primary_changed');
    });

    it("when the delegate's account is deactivated (core hook)", async () => {
      const hm = await home();
      const d = await delegate(hm);
      await drainOutbox(h); // the "created" emails, out of the way
      const since = new Date();
      await x.asManager(hm.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(hm.member.id, { status: 'inactive' }),
      );
      expect(await endReason(hm, d.id)).toBe('account_deactivated');
      await drainOutbox(h);
      const m = await waitForMessage(hm.member.email, since);
      expect(m.Subject).toMatch(/ended|انتهى تفويض/);
    });
  });
});
