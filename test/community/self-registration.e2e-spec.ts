import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  REGISTRATION_EXPIRY_SWEEP,
  RegistrationService,
  type RegistrationRequest,
} from '../../src/community/residents/registration.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { codeOf, nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp } from '../setup/login';
import { waitForOtp } from '../setup/mailpit';

/** Resident self-registration: a request first (ADR 0024, 02 §2). */
describe('Self-registration', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let reg: RegistrationService;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    reg = h.moduleRef.get(RegistrationService);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => h.close());

  async function compound() {
    const c = await x.compound('Registration Court');
    const { token } = await x.asManager(c, () => reg.createLink());
    return { c, linkToken: token };
  }

  function request(
    linkToken: string,
    unitCode: string,
    over: Partial<RegistrationRequest> = {},
  ): RegistrationRequest {
    return {
      linkToken,
      fullName: `Registrant ${uniqueSuffix()}`,
      unitCode,
      phone: uniquePhone(),
      email: uniqueEmail('reg'),
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(),
      occupancyType: 'owner',
      ...over,
    };
  }

  /** Start → code from Mailpit → complete, as the registrant (no session). */
  async function register(r: RegistrationRequest) {
    const since = new Date();
    const started = await reg.start(r, '10.20.30.40', 'en');
    const code = await waitForOtp(r.email, since);
    const done = await reg.complete(r, code, '10.20.30.40');
    return { started, done };
  }

  const pending = (c: Compound) => x.asManager(c, () => reg.pending());

  it('happy path: request, manager approval, then the real login', async () => {
    const { c, linkToken } = await compound();
    const u = await x.unit(c);
    const r = request(linkToken, u.code, {
      unitType: 'villa',
      areaSqm: '240.5',
    });
    const out = await register(r);
    expect(out).toEqual({
      started: { code: 'REGISTRATION_CODE_SENT' },
      done: { code: 'REGISTRATION_RECEIVED' },
    });
    const [p] = await pending(c);
    expect(p).toMatchObject({ unitId: u.id, email: r.email, conflicts: [] });

    const approved = await x.asManager(c, () => reg.approve(p.id));
    const [occupancy] = await x.occupancies(c, u.id);
    expect(occupancy).toMatchObject({
      id: approved.occupancyId,
      accountId: approved.accountId,
      isPrimary: true,
      occupancyType: 'owner',
    });
    // The request no longer holds personal data.
    const row = await x.asManager(c, () =>
      x.prisma.tenant.residentRegistration.findUniqueOrThrow({
        where: { id: p.id },
      }),
    );
    expect(row).toMatchObject({
      status: 'approved',
      fullName: null,
      email: null,
      phone: null,
      idDocumentNumber: null,
      approvedAccountId: approved.accountId,
    });
    // Activation data filled what the unit did not know.
    expect(await x.unitRow(c, u.id)).toMatchObject({ unitType: 'villa' });
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'community.registration_approved',
      },
    });
    expect(mail).toMatchObject({
      recipient: r.email,
      recipientAccountId: approved.accountId,
    });
    const tokens = await loginViaOtp(h, r.email, approved.accountId);
    expect(tokens.accountId).toBe(approved.accountId);
  });

  it('enumeration: every input gets the same body and the same work; only the manager sees the difference', async () => {
    const { c, linkToken } = await compound();
    const free = await x.unit(c);
    const withPrimary = await x.unit(c);
    await x.resident(c, [withPrimary.id]);
    const owned = await x.unit(c);
    const taken = await x.resident(c, [owned.id]);
    const inputs = {
      clean: request(linkToken, free.code),
      unknownUnit: request(linkToken, `NOPE-${uniqueSuffix()}`),
      unitHasPrimary: request(linkToken, withPrimary.code),
      phoneHasAccount: request(linkToken, free.code, { phone: taken.phone }),
      conflictingOccupancy: request(linkToken, owned.code, {
        occupancyType: 'owner',
      }),
    };

    // The models touched inside the compound, per input.
    const tenantTx = h.moduleRef.get(TenantTx);
    // Observing (not calling around) the registration path's own tenant tx.
    // eslint-disable-next-line no-restricted-properties
    const original = tenantTx.runInTenantUnsafe.bind(tenantTx);
    let touched: string[] = [];
    jest
      .spyOn(tenantTx, 'runInTenantUnsafe')
      .mockImplementation((tenantId, fn) =>
        original(tenantId, (tx) =>
          fn(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (typeof prop === 'string' && !prop.startsWith('$'))
                  touched.push(prop);
                return Reflect.get(target, prop, receiver) as unknown;
              },
            }),
          ),
        ),
      );

    const bodies: string[] = [];
    const work: string[] = [];
    for (const r of Object.values(inputs)) {
      touched = [];
      const out = await register(r);
      bodies.push(JSON.stringify(out));
      work.push(JSON.stringify([...new Set(touched)].sort()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(new Set(work).size).toBe(1);
    for (const model of [
      'unit',
      'account',
      'unitOccupancy',
      'householdMember',
    ]) {
      expect(JSON.parse(work[0])).not.toContain(model);
    }
    // Exactly one pending row and one audit entry per input.
    expect(await pending(c)).toHaveLength(5);
    expect(
      await auditReaders(h).tenant(c.tenantId, {
        action: 'resident.self_registered',
      }),
    ).toHaveLength(5);

    // The manager sees why.
    const byEmail = new Map(
      (await pending(c)).map((p) => [p.email, p.conflicts]),
    );
    expect(byEmail.get(inputs.clean.email)).toEqual([
      'duplicate_pending_for_unit',
    ]);
    expect(byEmail.get(inputs.unknownUnit.email)).toEqual(['unit_not_found']);
    expect(byEmail.get(inputs.unitHasPrimary.email)).toEqual([
      'unit_has_primary',
      'unit_has_residing_occupants',
    ]);
    expect(byEmail.get(inputs.phoneHasAccount.email)).toEqual([
      'phone_in_use',
      'duplicate_pending_for_unit',
    ]);
    expect(byEmail.get(inputs.conflictingOccupancy.email)).toEqual([
      'unit_has_primary',
      'unit_has_residing_occupants',
    ]);
  });

  it('start answers at once even with the security-event insert hung', async () => {
    const { linkToken } = await compound();
    jest
      .spyOn(globalDb, 'insertSecurityEvent')
      .mockImplementation(() => new Promise(() => undefined));
    for (const r of [request(linkToken, 'A-1'), request('not-a-link', 'B-2')]) {
      const t = Date.now();
      expect(await reg.start(r, '10.20.30.41', 'ar')).toEqual({
        code: 'REGISTRATION_CODE_SENT',
      });
      expect(Date.now() - t).toBeLessThan(1000);
    }
  });

  it('an unknown or revoked link writes nothing and still gets the same answer', async () => {
    const { c, linkToken } = await compound();
    await x.asManager(c, () => reg.revokeLinks());
    const u = await x.unit(c);
    expect((await register(request(linkToken, u.code))).done).toEqual({
      code: 'REGISTRATION_RECEIVED',
    });
    expect(await pending(c)).toEqual([]);
  });

  it('the code confirms only what was sent: a wrong code or a swapped payload is OTP_INVALID', async () => {
    const { linkToken } = await compound();
    const r = request(linkToken, 'U-1');
    const since = new Date();
    await reg.start(r, '10.20.30.42', 'en');
    const code = await waitForOtp(r.email, since);
    expect(
      await codeOf(
        reg.complete({ ...r, unitCode: 'U-2' }, code, '10.20.30.42'),
      ),
    ).toBe('OTP_INVALID');
    expect(await codeOf(reg.complete(r, '000000', '10.20.30.42'))).toBe(
      'OTP_INVALID',
    );
  });

  it('rate limits per email, like the login OTP', async () => {
    const { linkToken } = await compound();
    const r = request(linkToken, 'U-9');
    for (let i = 0; i < 5; i++) await reg.start(r, '10.20.30.43', 'en');
    expect(await codeOf(reg.start(r, '10.20.30.43', 'en'))).toBe(
      'RATE_LIMITED',
    );
  });

  it('approval re-checks: a taken phone is a conflict; the same person is linked only on request', async () => {
    const { c, linkToken } = await compound();
    const u = await x.unit(c);
    const other = await x.unit(c);
    const existing = await x.resident(c, [other.id]);
    await register(request(linkToken, u.code, { phone: existing.phone }));
    const [taken] = await pending(c);
    await expect(
      x.asManager(c, () => reg.approve(taken.id)),
    ).rejects.toMatchObject({
      response: {
        code: 'REGISTRATION_CONFLICT',
        params: { conflicts: ['phone_in_use'] },
      },
    });
    await x.asManager(c, () =>
      reg.reject(taken.id, { code: 'duplicate', text: 'Call us' }),
    );

    await register(
      request(linkToken, u.code, {
        phone: existing.phone,
        email: existing.email,
      }),
    );
    const [same] = await pending(c);
    expect(same.conflicts).toContain('same_person_existing_account');
    await expect(
      x.asManager(c, () => reg.approve(same.id)),
    ).rejects.toMatchObject({
      response: { params: { conflicts: ['same_person_existing_account'] } },
    });
    const linked = await x.asManager(c, () =>
      reg.approve(same.id, { linkToExistingAccount: true }),
    );
    expect(linked.accountId).toBe(existing.id);
  });

  it('a mistyped unit: the manager picks the right one', async () => {
    const { c, linkToken } = await compound();
    const u = await x.unit(c);
    await register(request(linkToken, 'TYPO-1'));
    const [p] = await pending(c);
    expect(await codeOf(x.asManager(c, () => reg.approve(p.id)))).toBe(
      'REGISTRATION_CONFLICT',
    );
    await x.asManager(c, () => reg.approve(p.id, { unitId: u.id }));
  });

  it('rejection tells the registrant the reason — never the conflict — and drops the personal data', async () => {
    const { c, linkToken } = await compound();
    const r = request(linkToken, `NOPE-${uniqueSuffix()}`);
    await register(r);
    const [p] = await pending(c);
    expect(
      await codeOf(
        x.asManager(c, () => reg.reject(p.id, { code: 'not_a_resident' })),
      ),
    ).toBe('REASON_REQUIRED');
    await x.asManager(c, () =>
      reg.reject(p.id, {
        code: 'not_a_resident',
        text: 'Please visit the office',
      }),
    );
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'community.registration_rejected',
      },
    });
    expect(mail).toMatchObject({ recipient: r.email });
    expect(JSON.stringify(mail.params)).toContain('Please visit the office');
    expect(JSON.stringify(mail.params)).not.toMatch(/unit_not_found|conflict/);
    const row = await x.asManager(c, () =>
      x.prisma.tenant.residentRegistration.findUniqueOrThrow({
        where: { id: p.id },
      }),
    );
    expect(row).toMatchObject({
      status: 'rejected',
      email: null,
      idDocumentNumber: null,
    });
    const [entry] = await auditReaders(h).tenant(c.tenantId, {
      action: 'resident.registration_rejected',
      targetId: p.id,
    });
    expect(entry.metadata).toEqual({ reasonCode: 'not_a_resident' });
  });

  it('an abandoned request expires after REGISTRATION_PENDING_DAYS: the registrant is told, the data goes', async () => {
    const { c, linkToken } = await compound();
    const r = request(linkToken, 'X-1');
    await register(r);
    const [p] = await pending(c);
    const sweep = h.moduleRef.get(SweepRunner);
    expect(
      await sweep.run(
        REGISTRATION_EXPIRY_SWEEP,
        new Date(Date.now() + 29 * 86_400_000),
      ),
    ).toBe(0);
    expect(
      await sweep.run(
        REGISTRATION_EXPIRY_SWEEP,
        new Date(Date.now() + 31 * 86_400_000),
      ),
    ).toBeGreaterThanOrEqual(1);
    const row = await x.asManager(c, () =>
      x.prisma.tenant.residentRegistration.findUniqueOrThrow({
        where: { id: p.id },
      }),
    );
    expect(row).toMatchObject({
      status: 'expired',
      email: null,
      idDocumentNumber: null,
      decidedById: null,
    });
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'community.registration_expired',
      },
    });
    expect(mail.recipient).toBe(r.email);
    const [entry] = await auditReaders(h).tenant(c.tenantId, {
      action: 'resident.registration_expired',
      targetId: p.id,
    });
    expect(entry).toMatchObject({ actorType: 'system', actorId: null });
  });

  it('the activation card fills only missing details; the manager’s value wins', async () => {
    const { c, linkToken } = await compound();
    const u = await x.unit(c);
    await register(request(linkToken, u.code));
    const [p] = await pending(c);
    const { accountId } = await x.asManager(c, () => reg.approve(p.id));
    const asOwner = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: accountId, type: 'resident' }, fn);
    expect(
      await asOwner(() => x.residents.missingActivationSteps(u.id)),
    ).toEqual(['unitType', 'areaSqm', 'building']);
    await asOwner(() => x.residents.submitUnitDetail(u.id, 'building', 'B7'));
    expect(
      await codeOf(
        asOwner(() => x.residents.submitUnitDetail(u.id, 'building', 'B9')),
      ),
    ).toBe('UNIT_DETAIL_ALREADY_SET');
    expect(
      await codeOf(
        asOwner(() => x.residents.submitUnitDetail(u.id, 'unitType', 'castle')),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await asOwner(() => x.residents.missingActivationSteps(u.id)),
    ).toEqual(['unitType', 'areaSqm']);
  });

  it("tenant B never sees or decides A's requests", async () => {
    const a = await compound();
    const b = await compound();
    await register(request(a.linkToken, 'Z-1'));
    const [p] = await pending(a.c);
    expect(await pending(b.c)).toEqual([]);
    expect(await codeOf(x.asManager(b.c, () => reg.approve(p.id)))).toBe(
      'REGISTRATION_NOT_FOUND',
    );
    expect(
      await codeOf(
        x.asManager(b.c, () => reg.reject(p.id, { code: 'other', text: 'x' })),
      ),
    ).toBe('REGISTRATION_NOT_FOUND');
  });
});
