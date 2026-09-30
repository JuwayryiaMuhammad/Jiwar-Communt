import { JwtService } from '@nestjs/jwt';
import { AccountSelfService } from '../../src/core/accounts/account-self.service';
import type { AccessTokenClaims } from '../../src/core/common/guards/access-token';
import type { Locale } from '../../src/core/common/i18n/locale';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { HouseholdsService } from '../../src/community/households/households.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { loginViaOtp, type Tokens } from '../setup/login';

/** What a resident or family member manages for themselves (Part C). */
describe('Self-service', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let self: AccountSelfService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    self = h.moduleRef.get(AccountSelfService);
  });

  afterAll(() => h.close());

  const sid = (tokens: Tokens) =>
    h.moduleRef.get(JwtService).decode<AccessTokenClaims>(tokens.accessToken)
      .sid;

  const asHolder = <T>(
    c: Compound,
    who: { id: string; type: 'resident' | 'family' },
    tokens: Tokens,
    fn: () => Promise<T>,
  ) => x.as(c, { ...who, sessionId: sid(tokens) }, fn);

  const me = (tokens: Tokens) =>
    h
      .http()
      .get(`${API}/accounts/me`)
      .set('Authorization', `Bearer ${tokens.accessToken}`);

  it('the preferred language changes and is audited; an unknown one is refused', async () => {
    const c = await x.compound();
    const r = await x.resident(c, [(await x.unit(c)).id]);
    const who = { id: r.id, type: 'resident' as const };
    expect(await x.as(c, who, () => self.updatePreferredLocale('en'))).toBe(
      'en',
    );
    const [entry] = await auditReaders(h).tenant(c.tenantId, {
      action: 'account.locale_changed',
      targetId: r.id,
    });
    expect(entry.changes).toEqual({
      preferredLocale: { from: 'ar', to: 'en' },
    });
    await expect(
      x.as(c, who, () => self.updatePreferredLocale('fr' as Locale)),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_FAILED',
        fields: [{ field: 'preferredLocale', code: 'INVALID_VALUE' }],
      },
    });
  });

  it('lists only my live sessions, marks the current one, and never shows the IP', async () => {
    const c = await x.compound();
    const r = await x.resident(c, [(await x.unit(c)).id]);
    const other = await x.resident(c, [(await x.unit(c)).id]);
    const first = await loginViaOtp(h, r.email, r.id);
    const second = await loginViaOtp(h, r.email, r.id);
    await loginViaOtp(h, other.email, other.id);

    const sessions = await asHolder(
      c,
      { id: r.id, type: 'resident' },
      second,
      () => self.listMySessions(),
    );
    expect(sessions.map((s) => s.id).sort()).toEqual(
      [sid(first), sid(second)].sort(),
    );
    expect(sessions.find((s) => s.isCurrent)?.id).toBe(sid(second));
    for (const s of sessions) {
      expect(Object.keys(s).sort()).toEqual([
        'createdAt',
        'id',
        'isCurrent',
        'lastUsedAt',
        'userAgent',
      ]);
    }
  });

  it("revoking another account's session is SESSION_NOT_FOUND; my other session stops at once", async () => {
    const c = await x.compound();
    const r = await x.resident(c, [(await x.unit(c)).id]);
    const other = await x.resident(c, [(await x.unit(c)).id]);
    const mine = await loginViaOtp(h, r.email, r.id);
    const phone = await loginViaOtp(h, r.email, r.id);
    const theirs = await loginViaOtp(h, other.email, other.id);
    const who = { id: r.id, type: 'resident' as const };

    await expect(
      asHolder(c, who, mine, () => self.revokeSession(sid(theirs))),
    ).rejects.toMatchObject({ response: { code: 'SESSION_NOT_FOUND' } });
    await me(theirs).expect(200);

    await asHolder(c, who, mine, () => self.revokeSession(sid(phone)));
    await me(phone).expect(401);
    await me(mine).expect(200);
  });

  it('"that wasn\'t me" ends every session, the current one too, and says so', async () => {
    const c = await x.compound();
    const r = await x.resident(c, [(await x.unit(c)).id]);
    const a = await loginViaOtp(h, r.email, r.id);
    const b = await loginViaOtp(h, r.email, r.id);
    const count = await asHolder(c, { id: r.id, type: 'resident' }, a, () =>
      self.revokeAllMySessions(),
    );
    expect(count).toBe(2);
    await me(a).expect(401);
    await me(b).expect(401);
    const [event] = await auditReaders(h).security({
      event: 'session.revoked',
      accountId: r.id,
    });
    expect(event.metadata).toEqual({ reason: 'self', scope: 'all', count: 2 });
  });

  it('works the same for a family account', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const member = await x.joinFamily(c, u.id, primary);
    const tokens = await loginViaOtp(h, member.email, member.id);
    const who = { id: member.id, type: 'family' as const };
    expect(
      (await asHolder(c, who, tokens, () => self.listMySessions())).map(
        (s) => s.isCurrent,
      ),
    ).toEqual([true]);
    await asHolder(c, who, tokens, () => self.updatePreferredLocale('en'));
    await asHolder(c, who, tokens, () => self.revokeAllMySessions());
    await me(tokens).expect(401);
  });

  it('my units say whether I am the primary; the primary gets the household counts', async () => {
    const c = await x.compound();
    const u1 = await x.unit(c);
    const u2 = await x.unit(c);
    const primary = await x.resident(c, [u1.id]);
    await x.resident(c, [u2.id]);
    const coOccupant = await x.resident(c, [u1.id, u2.id], 'tenant');
    const asPrimary = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: primary.id, type: 'resident' }, fn);
    await asPrimary(() =>
      h.moduleRef.get(HouseholdsService).addMinor(u1.id, {
        fullName: 'Kid',
        idDocumentType: 'national_id' as const,
        idDocumentNumber: nationalIdFor(bornYearsAgo(4)),
        relation: 'child',
      }),
    );
    await x.joinFamily(c, u1.id, primary);
    await asPrimary(() =>
      h.moduleRef.get(HouseholdsService).createInvite(u1.id, {
        fullName: 'Pending Invite',
        phone: '+201011112222',
        email: 'pending-invite@example.test',
        idDocumentType: 'national_id' as const,
        idDocumentNumber: nationalIdFor(bornYearsAgo(50)),
        relation: 'parent',
      }),
    );

    const mine = await asPrimary(() => x.residents.myUnits());
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      unitId: u1.id,
      isPrimary: true,
      household: { memberCount: 2, pendingInvites: 1 },
    });

    const theirs = await x.as(c, { id: coOccupant.id, type: 'resident' }, () =>
      x.residents.myUnits(),
    );
    expect(theirs.map((m) => [m.unitId, m.isPrimary]).sort()).toEqual(
      [
        [u1.id, false],
        [u2.id, false],
      ].sort(),
    );
    for (const m of theirs) expect(m).not.toHaveProperty('household');
  });
});
