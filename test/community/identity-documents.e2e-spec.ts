import { AccountsService } from '../../src/core/accounts/accounts.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import {
  WorkersService,
  type NewWorker,
} from '../../src/community/workers/workers.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/** National ID or passport, with a stored birth date (ADR 0018). */
describe('Identity documents', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let workers: WorkersService;
  let households: HouseholdsService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    workers = h.moduleRef.get(WorkersService);
    households = h.moduleRef.get(HouseholdsService);
  });

  afterAll(() => h.close());

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  let seq = 0;
  /** A unique passport number per call. */
  const passportNo = () =>
    `P${Date.now().toString(36).toUpperCase()}${(seq++).toString(36).toUpperCase()}`;

  const passport = (years: number, nationality = 'SD', days = 0) => ({
    idDocumentType: 'passport' as const,
    idDocumentNumber: passportNo(),
    nationality,
    birthDate: iso(bornYearsAgo(years, days)),
  });

  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'resolved',
      (e: { response?: { code?: string }; message?: string }) =>
        e.response?.code ?? e.message ?? 'rejected',
    );

  async function managerToken(c: Compound) {
    return h.tokenFor({ sub: c.managerId, tid: c.tenantId, typ: 'manager' });
  }

  // --------------------------------------------------------------------------
  describe('accounts', () => {
    it('POST /accounts takes a passport with a foreign phone number, and stores the birth date', async () => {
      const c = await x.compound();
      const doc = passport(40, 'GB');
      const res = await h
        .http()
        .post(`${API}/accounts`)
        .set('Authorization', `Bearer ${await managerToken(c)}`)
        .send({
          type: 'resident',
          fullName: 'British Owner',
          ...doc,
          idDocumentNumber: ` ${doc.idDocumentNumber.toLowerCase()} `,
          nationality: 'gb',
          phone: '+44 7911 123456',
          email: uniqueEmail('uk'),
        })
        .expect(201);
      expect(res.body).toMatchObject({
        idDocumentType: 'passport',
        idDocumentNumber: doc.idDocumentNumber,
        nationality: 'GB',
        birthDate: doc.birthDate,
        phone: '+447911123456',
      });
    });

    it('invalid passports are refused with a code per field', async () => {
      const c = await x.compound();
      const res = await h
        .http()
        .post(`${API}/accounts`)
        .set('Authorization', `Bearer ${await managerToken(c)}`)
        .send({
          type: 'resident',
          fullName: 'Nobody',
          idDocumentType: 'passport',
          idDocumentNumber: 'AB',
          nationality: 'ZZ',
          birthDate: '2999-01-01',
          phone: '+249912345678',
          email: uniqueEmail('bad-passport'),
        })
        .expect(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [
          { field: 'idDocumentNumber', code: 'INVALID_PASSPORT_NUMBER' },
          { field: 'nationality', code: 'INVALID_NATIONALITY' },
          { field: 'birthDate', code: 'INVALID_BIRTH_DATE' },
        ],
      });
      const missing = await h
        .http()
        .post(`${API}/accounts`)
        .set('Authorization', `Bearer ${await managerToken(c)}`)
        .send({
          type: 'resident',
          fullName: 'Nobody',
          idDocumentType: 'passport',
          idDocumentNumber: 'A1234567',
          nationality: 'SD',
          phone: '+249912345678',
          email: uniqueEmail('no-birth'),
        })
        .expect(400);
      expect((missing.body as { fields: unknown }).fields).toEqual([
        { field: 'birthDate', code: 'BIRTH_DATE_REQUIRED' },
      ]);
    });
  });

  // --------------------------------------------------------------------------
  describe('household', () => {
    it('a minor with a passport is added; an adult with a passport is invited, joins and can be delegated to', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const primary = await x.resident(c, [u.id]);
      const asPrimary = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: primary.id, type: 'resident' }, fn);

      const kid = await asPrimary(() =>
        households.addMinor(u.id, {
          fullName: 'Foreign Kid',
          relation: 'child',
          ...passport(7, 'JO'),
        }),
      );
      expect(kid).toMatchObject({ isMinor: true, accountId: null });

      // A passport says 17: that is a minor, so no invite.
      expect(
        await code(
          asPrimary(() =>
            households.createInvite(u.id, {
              fullName: 'Too Young',
              phone: '+962791234567',
              email: uniqueEmail('young'),
              relation: 'child',
              ...passport(17, 'JO', -1),
            }),
          ),
        ),
      ).toBe('INVITE_MINOR_NOT_ALLOWED');

      const doc = passport(35, 'JO');
      const member = await x.joinFamily(c, u.id, primary, doc);
      const account = await x.asManager(c, () =>
        x.prisma.tenant.account.findUniqueOrThrow({ where: { id: member.id } }),
      );
      expect(account).toMatchObject({
        idDocumentType: 'passport',
        idDocumentNumber: doc.idDocumentNumber,
        nationality: 'JO',
      });
      expect(iso(account.birthDate!)).toBe(doc.birthDate);

      const delegation = await asPrimary(() =>
        h.moduleRef
          .get(DelegationsService)
          .create(
            u.id,
            member.id,
            ['household'],
            new Date(Date.now() + 86_400_000),
          ),
      );
      expect(delegation.delegateAccountId).toBe(member.id);
    });

    it('a legacy account with no birth date is not eligible as a delegate', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const primary = await x.resident(c, [u.id]);
      const member = await x.joinFamily(c, u.id, primary);
      await x.asManager(c, () =>
        x.prisma.tenant.account.update({
          where: { id: member.id },
          data: { birthDate: null },
        }),
      );
      expect(
        await code(
          x.as(c, { id: primary.id, type: 'resident' }, () =>
            h.moduleRef
              .get(DelegationsService)
              .create(
                u.id,
                member.id,
                ['household'],
                new Date(Date.now() + 86_400_000),
              ),
          ),
        ),
      ).toBe('DELEGATE_NOT_ELIGIBLE');
    });
  });

  // --------------------------------------------------------------------------
  describe('workers with a passport', () => {
    async function home(c?: Compound) {
      const compound = c ?? (await x.compound());
      const u = await x.unit(compound);
      const r = await x.resident(compound, [u.id]);
      const asResident = <T>(fn: () => Promise<T>) =>
        x.as(compound, { id: r.id, type: 'resident' }, fn);
      return { c: compound, unitId: u.id, asResident };
    }

    const worker = (
      doc: ReturnType<typeof passport>,
      days = [1],
    ): NewWorker => ({
      fullName: 'Passport Worker',
      phone: '+639171234567',
      capacity: 'hourly',
      schedule: { days, windows: [{ from: '08:00', to: '12:00' }] },
      ...doc,
    });

    const workerRow = (c: Compound, engagementId: string) =>
      x.asManager(c, async () =>
        x.prisma.tenant.domesticWorker.findFirstOrThrow({
          where: { engagements: { some: { id: engagementId } } },
        }),
      );

    it('under 18 on the entered date is refused at registration', async () => {
      const hm = await home();
      expect(
        await code(
          hm.asResident(() =>
            workers.register(hm.unitId, worker(passport(17, 'PH', -1))),
          ),
        ),
      ).toBe('WORKER_UNDERAGE');
    });

    it('approval needs the birth date attested, once per worker', async () => {
      const c = await x.compound();
      const a = await home(c);
      const b = await home(c);
      const doc = passport(30, 'PH');
      const first = await a.asResident(() =>
        workers.register(a.unitId, worker(doc)),
      );
      expect(
        await code(
          x.asManager(c, () => workers.review(first.engagementId, 'approve')),
        ),
      ).toBe('BIRTH_DATE_CONFIRMATION_REQUIRED');
      const issued = await x.asManager(c, () =>
        workers.review(first.engagementId, 'approve', {
          birthDateConfirmed: true,
        }),
      );
      expect(issued?.accessCode).toMatch(/^\d{8}$/);
      const verified = await workerRow(c, first.engagementId);
      expect(verified.birthDateVerifiedById).toBe(c.managerId);
      expect(verified.birthDateVerifiedAt).not.toBeNull();

      // Another unit, same passport: one worker, already attested.
      const second = await b.asResident(() =>
        workers.register(b.unitId, worker(doc, [3])),
      );
      expect((await workerRow(c, second.engagementId)).id).toBe(verified.id);
      expect(
        await x.asManager(c, () =>
          workers.review(second.engagementId, 'approve'),
        ),
      ).toHaveProperty('accessCode');
    });

    it('a corrected date under 18 rejects the review and suspends every other active engagement, with notices', async () => {
      const c = await x.compound();
      const a = await home(c);
      const b = await home(c);
      const doc = passport(25, 'PH');
      const first = await a.asResident(() =>
        workers.register(a.unitId, worker(doc)),
      );
      const code1 = await x.asManager(c, () =>
        workers.review(first.engagementId, 'approve', {
          birthDateConfirmed: true,
        }),
      );
      const second = await b.asResident(() =>
        workers.register(b.unitId, worker(doc, [4])),
      );

      // The manager checks the passport again and finds the worker is 16.
      expect(
        await code(
          x.asManager(c, () =>
            workers.review(second.engagementId, 'approve', {
              birthDateConfirmed: true,
              birthDate: iso(bornYearsAgo(16)),
            }),
          ),
        ),
      ).toBe('WORKER_UNDERAGE');

      const rows = await x.asManager(c, () =>
        x.prisma.tenant.workerEngagement.findMany({
          where: { id: { in: [first.engagementId, second.engagementId] } },
        }),
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(second.engagementId)).toMatchObject({
        status: 'rejected',
        statusReason: 'underage',
      });
      expect(byId.get(first.engagementId)).toMatchObject({
        status: 'suspended',
        suspendedByManagement: true,
        statusReason: 'underage',
      });
      expect(
        await a.asResident(() => workers.isCodeValid(code1!.accessCode)),
      ).toBe(false);
      const notices = await x.asManager(c, () =>
        x.prisma.tenant.workerNotice.findMany({
          where: { engagementId: first.engagementId },
        }),
      );
      expect(notices.map((n) => [n.noticeKey, n.params])).toEqual([
        ['engagement_suspended_by_management', { reason: 'underage' }],
      ]);
      const [suspended] = await auditReaders(h).tenant(c.tenantId, {
        action: 'worker.engagement_suspended',
        targetId: first.engagementId,
      });
      expect(suspended.metadata).toMatchObject({ reason: 'underage' });

      // No way back while under 18.
      expect(
        await code(a.asResident(() => workers.resume(first.engagementId))),
      ).toBe('WORKER_UNDERAGE');
    });

    it('a later correction clears the attestation; the next approval needs it again', async () => {
      const c = await x.compound();
      const a = await home(c);
      const b = await home(c);
      const doc = passport(40, 'IN');
      const first = await a.asResident(() =>
        workers.register(a.unitId, worker(doc)),
      );
      await x.asManager(c, () =>
        workers.review(first.engagementId, 'approve', {
          birthDateConfirmed: true,
        }),
      );
      const w = await workerRow(c, first.engagementId);
      await x.asManager(c, () =>
        workers.correctBirthDate(w.id, iso(bornYearsAgo(41))),
      );
      expect(
        (await workerRow(c, first.engagementId)).birthDateVerifiedAt,
      ).toBeNull();

      const second = await b.asResident(() =>
        workers.register(b.unitId, worker(doc, [5])),
      );
      expect(
        await code(
          x.asManager(c, () => workers.review(second.engagementId, 'approve')),
        ),
      ).toBe('BIRTH_DATE_CONFIRMATION_REQUIRED');
    });

    it('the same passport is one worker; the same number from another country is another', async () => {
      const c = await x.compound();
      const a = await home(c);
      const b = await home(c);
      const doc = passport(30, 'PH');
      const one = await a.asResident(() =>
        workers.register(a.unitId, worker(doc)),
      );
      const same = await b.asResident(() =>
        workers.register(b.unitId, worker(doc, [2])),
      );
      const other = await b
        .asResident(() =>
          workers.register(
            b.unitId,
            worker({ ...doc, nationality: 'ID' }, [6]),
          ),
        )
        .catch(async () => {
          // One open engagement per worker and unit: use a third unit.
          const d = await home(c);
          return d.asResident(() =>
            workers.register(
              d.unitId,
              worker({ ...doc, nationality: 'ID' }, [6]),
            ),
          );
        });
      const ids = await Promise.all(
        [one, same, other].map(
          async (r) => (await workerRow(c, r.engagementId)).id,
        ),
      );
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
    });

    it('a national-ID worker needs no attestation, and its date cannot be corrected', async () => {
      const hm = await home();
      const reg = await hm.asResident(() =>
        workers.register(hm.unitId, {
          fullName: 'Egyptian Worker',
          phone: uniquePhone(),
          capacity: 'live_in',
          idDocumentType: 'national_id',
          idDocumentNumber: '29001010100011',
        }),
      );
      expect(
        await x.asManager(hm.c, () =>
          workers.review(reg.engagementId, 'approve'),
        ),
      ).toHaveProperty('accessCode');
      const w = await workerRow(hm.c, reg.engagementId);
      await expect(
        x.asManager(hm.c, () => workers.correctBirthDate(w.id, '1991-01-01')),
      ).rejects.toMatchObject({
        response: {
          fields: [{ field: 'birthDate', code: 'FIELD_NOT_ALLOWED' }],
        },
      });
    });
  });

  // --------------------------------------------------------------------------
  it('no document number or birth date appears in any audit entry', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const r = await x.resident(c, [u.id]);
    const accountDoc = passport(50, 'SA');
    const created = await x.asManager(c, () =>
      h.moduleRef.get(AccountsService).create({
        type: 'resident',
        fullName: 'Saudi Owner',
        phone: '+966501234567',
        email: uniqueEmail('sa'),
        ...accountDoc,
      }),
    );
    const workerDoc = passport(33, 'LK');
    const reg = await x.as(c, { id: r.id, type: 'resident' }, () =>
      workers.register(u.id, {
        fullName: 'Lanka Worker',
        phone: '+94771234567',
        capacity: 'live_in',
        ...workerDoc,
      }),
    );
    const corrected = iso(bornYearsAgo(34));
    await x.asManager(c, () =>
      workers.review(reg.engagementId, 'approve', {
        birthDateConfirmed: true,
        birthDate: corrected,
      }),
    );
    const text = JSON.stringify(await auditReaders(h).tenant(c.tenantId));
    expect(created.id).toBeTruthy();
    for (const secret of [
      accountDoc.idDocumentNumber,
      accountDoc.birthDate,
      workerDoc.idDocumentNumber,
      workerDoc.birthDate,
      corrected,
      'SA',
      'LK',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
