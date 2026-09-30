import { AccountsService } from '../../src/core/accounts/accounts.service';
import { AccountWriter } from '../../src/core/accounts/account-writer';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { codeOf } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp } from '../setup/login';
import { countEmails } from '../setup/mailpit';

const REASSIGNED = {
  code: 'phone_reassigned',
  text: 'The new holder of the number called',
};

/** "Not me": a phone that moved to someone else (ADR 0023, 05 §7). */
describe('Frozen accounts', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let accounts: AccountsService;
  let globalDb: GlobalDbService;
  let hasher: IdentifierHasher;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    accounts = h.moduleRef.get(AccountsService);
    globalDb = h.moduleRef.get(GlobalDbService);
    hasher = h.moduleRef.get(IdentifierHasher);
  });

  afterAll(() => h.close());

  async function primaryWithFamily() {
    const c = await x.compound('Freeze Court');
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const family = await x.joinFamily(c, u.id, primary);
    return { c, unitId: u.id, primary, family };
  }

  const freeze = (c: Compound, id: string) =>
    x.asManager(c, () => accounts.freeze(id, REASSIGNED));
  const phoneHash = (phone: string) =>
    hasher.hashIdentifier({ type: 'phone', value: phone });

  it('freezes at once: the phone leaves the account and login, every session ends, the unit goes under review', async () => {
    const { c, unitId, primary, family } = await primaryWithFamily();
    await x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef
        .get(DelegationsService)
        .create(
          unitId,
          family.accountId,
          ['household'],
          new Date(Date.now() + 86_400_000),
        ),
    );
    const tokens = await loginViaOtp(h, primary.email, primary.id);
    await freeze(c, primary.id);

    // The access token dies on the next request.
    await h
      .http()
      .get(`${API}/accounts/me`)
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(401);
    const account = await x.asManager(c, () =>
      x.prisma.tenant.account.findUniqueOrThrow({ where: { id: primary.id } }),
    );
    expect(account).toMatchObject({ status: 'frozen', phone: null });
    const identifiers = await globalDb.loginIdentifier.findMany({
      where: { accountId: primary.id },
    });
    expect(identifiers.map((i) => [i.identifierType, i.status])).toEqual([
      ['email', 'frozen'],
    ]);
    expect(
      await globalDb.session.count({
        where: { accountId: primary.id, revokedAt: null },
      }),
    ).toBe(0);

    // The primary stays primary; the unit is flagged; delegations go on.
    expect(await x.openReviews(c, unitId)).toEqual(['primary_frozen']);
    expect(
      (await x.occupancies(c, unitId)).find((o) => o.accountId === primary.id)
        ?.isPrimary,
    ).toBe(true);
    expect(
      await x.asManager(c, () =>
        x.prisma.tenant.householdDelegation.count({
          where: { unitId, revokedAt: null },
        }),
      ),
    ).toBe(1);

    // Never silent: the holder is told; audit and security event carry no number.
    const [told] = await globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId, templateKey: 'account.frozen' },
    });
    expect(told).toMatchObject({
      recipient: primary.email,
      recipientAccountId: primary.id,
    });
    const read = auditReaders(h);
    const [entry] = await read.tenant(c.tenantId, {
      action: 'account.frozen',
      targetId: primary.id,
    });
    expect(entry).toMatchObject({
      actorId: c.managerId,
      changes: {
        status: { from: 'active', to: 'frozen' },
        phone: { changed: true },
      },
      metadata: { reasonCode: 'phone_reassigned', sessionsRevoked: 1 },
    });
    const [event] = await read.security({
      accountId: primary.id,
      event: 'account.phone_reassigned',
    });
    expect(event).toBeDefined();
    for (const row of [entry, event]) {
      expect(JSON.stringify(row)).not.toContain(primary.phone);
      expect(JSON.stringify(row)).not.toContain('holder of the number');
    }
  });

  it('no view or query returns the old number after a freeze, and the number no longer logs anyone in', async () => {
    const { c, primary } = await primaryWithFamily();
    await freeze(c, primary.id);
    const views = await x.asManager(c, () =>
      Promise.all([
        accounts.get(primary.id),
        accounts.list(),
        x.residents.get(primary.id),
        x.residents.list(),
        x.prisma.tenant.account.findMany({ where: { phone: primary.phone } }),
      ]),
    );
    expect(JSON.stringify(views)).not.toContain(primary.phone);
    expect(views[0].phone).toBeNull();
    expect(views[4]).toEqual([]);
    expect(
      await globalDb.loginIdentifier.count({
        where: { identifierHash: phoneHash(primary.phone) },
      }),
    ).toBe(0);
    // An OTP request with the old number reaches nobody.
    const since = new Date();
    await h
      .http()
      .post(`${API}/auth/otp/request`)
      .send({ identifier: primary.phone })
      .expect(202);
    expect(await countEmails(primary.email, since)).toBe(0);
  });

  it('recovery: a NEW phone, then reactivate — the old number can never come back', async () => {
    const { c, unitId, primary } = await primaryWithFamily();
    await freeze(c, primary.id);
    const writer = h.moduleRef.get(AccountWriter);
    const tenantTx = h.moduleRef.get(TenantTx);

    expect(
      await codeOf(x.asManager(c, () => accounts.reactivate(primary.id))),
    ).toBe('ACCOUNT_PHONE_MUST_CHANGE');
    expect(
      await codeOf(
        x.asManager(c, () =>
          tenantTx.withTenantTx((tx) =>
            writer.setStatus(tx, primary.id, 'active'),
          ),
        ),
      ),
    ).toBe('ACCOUNT_FROZEN');
    expect(
      await codeOf(
        x.asManager(c, () =>
          accounts.updateContact(primary.id, { phone: primary.phone }),
        ),
      ),
    ).toBe('PHONE_RELEASED');
    // Email-only changes still work on a frozen account.
    await x.asManager(c, () =>
      accounts.updateContact(primary.id, { email: `new-${primary.email}` }),
    );

    const newPhone = uniquePhone();
    await x.asManager(c, () =>
      accounts.updateContact(primary.id, { phone: newPhone }),
    );
    expect(
      await globalDb.loginIdentifier.findFirst({
        where: { accountId: primary.id, identifierType: 'phone' },
      }),
    ).toMatchObject({ identifierHash: phoneHash(newPhone), status: 'frozen' });

    const back = await x.asManager(c, () => accounts.reactivate(primary.id));
    expect(back).toMatchObject({ status: 'active', phone: newPhone });
    expect(await x.openReviews(c, unitId)).toEqual([]);
    expect(
      await globalDb.loginIdentifier.count({
        where: { accountId: primary.id, status: 'active' },
      }),
    ).toBe(2);
    expect(
      await globalDb.outboxMessage.count({
        where: { tenantId: c.tenantId, templateKey: 'account.reactivated' },
      }),
    ).toBe(1);
    // Even after reactivation the released number is refused.
    expect(
      await codeOf(
        x.asManager(c, () =>
          accounts.updateContact(primary.id, { phone: primary.phone }),
        ),
      ),
    ).toBe('PHONE_RELEASED');
    expect(
      await codeOf(x.asManager(c, () => accounts.reactivate(primary.id))),
    ).toBe('ACCOUNT_NOT_FROZEN');
  });

  it("a frozen member's primary is told", async () => {
    const { c, primary, family } = await primaryWithFamily();
    await freeze(c, family.accountId);
    const [mail] = await globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId, templateKey: 'community.member_frozen' },
    });
    expect(mail.recipientAccountId).toBe(primary.id);
  });

  it('needs the reason code and text; never one’s own account; never twice; never across compounds', async () => {
    const { c, primary } = await primaryWithFamily();
    expect(
      await codeOf(
        x.asManager(c, () =>
          accounts.freeze(primary.id, { code: 'phone_reassigned' }),
        ),
      ),
    ).toBe('REASON_REQUIRED');
    expect(
      await codeOf(
        x.asManager(c, () =>
          accounts.freeze(primary.id, { code: 'fraud', text: 'x' }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(await codeOf(freeze(c, c.managerId))).toBe(
      'CANNOT_CHANGE_OWN_STATUS',
    );
    const other = await x.compound();
    expect(await codeOf(freeze(other, primary.id))).toBe('ACCOUNT_NOT_FOUND');
    await freeze(c, primary.id);
    expect(await codeOf(freeze(c, primary.id))).toBe('ACCOUNT_FROZEN');
  });
});
