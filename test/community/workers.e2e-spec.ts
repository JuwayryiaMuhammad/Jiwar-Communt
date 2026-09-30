import { PlatformModule } from '../../src/core/platform/platform.module';
import { DelegationsService } from '../../src/community/households/delegations.service';
import {
  WorkersService,
  type NewWorker,
} from '../../src/community/workers/workers.service';
import { auditReaders } from '../setup/audit';
import {
  communityHelpers,
  type Compound,
  type Person,
} from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/** Domestic workers: registration, review, codes, suspension, ban (ADR 0017). */
describe('Domestic workers', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let workers: WorkersService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    workers = h.moduleRef.get(WorkersService);
  });

  afterAll(() => h.close());

  interface Home {
    c: Compound;
    unitId: string;
    resident: Person;
  }

  async function home(c?: Compound): Promise<Home> {
    const compound = c ?? (await x.compound('Workers Court'));
    const u = await x.unit(compound);
    const resident = await x.resident(compound, [u.id]);
    return { c: compound, unitId: u.id, resident };
  }

  const asResident = <T>(hm: Home, fn: () => Promise<T>) =>
    x.as(hm.c, { id: hm.resident.id, type: 'resident' }, fn);

  const nanny = (over: Partial<NewWorker> = {}): NewWorker => ({
    fullName: 'Nanny Worker',
    idDocumentType: 'national_id' as const,
    idDocumentNumber: nationalIdFor(bornYearsAgo(35)),
    phone: uniquePhone(),
    capacity: 'hourly',
    schedule: { days: [0, 1, 2], windows: [{ from: '08:00', to: '14:00' }] },
    ...over,
  });

  /** Register as the resident, approve as the manager: an active code. */
  async function active(hm: Home, input = nanny()) {
    const reg = await asResident(hm, () => workers.register(hm.unitId, input));
    const issued = await x.asManager(hm.c, () =>
      workers.review(reg.engagementId, 'approve'),
    );
    return { ...reg, code: issued!.accessCode, input };
  }

  const valid = (hm: Home, code: string) =>
    asResident(hm, () => workers.isCodeValid(code));

  const row = (hm: Home, id: string) =>
    x.asManager(hm.c, () =>
      x.prisma.tenant.workerEngagement.findUniqueOrThrow({ where: { id } }),
    );

  const notices = (hm: Home, engagementId: string) =>
    x.asManager(hm.c, () =>
      x.prisma.tenant.workerNotice.findMany({
        where: { engagementId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'resolved',
      (e: { response?: { code?: string }; message?: string }) =>
        e.response?.code ?? e.message ?? 'rejected',
    );

  // --------------------------------------------------------------------------
  describe('registration', () => {
    it('an underage worker is refused, with no way around it', async () => {
      const hm = await home();
      expect(
        await code(
          asResident(hm, () =>
            workers.register(
              hm.unitId,
              nanny({ idDocumentNumber: nationalIdFor(bornYearsAgo(17, -1)) }),
            ),
          ),
        ),
      ).toBe('WORKER_UNDERAGE');
      expect(
        await x.asManager(hm.c, () => x.prisma.tenant.domesticWorker.count()),
      ).toBe(0);
    });

    it('the same person across units is one record, reused without revealing anything', async () => {
      const c = await x.compound('Workers Court');
      const a = await home(c);
      const b = await home(c);
      const nationalId = nationalIdFor(bornYearsAgo(40));
      const first = await asResident(a, () =>
        workers.register(a.unitId, nanny({ idDocumentNumber: nationalId })),
      );
      const second = await asResident(b, () =>
        workers.register(
          b.unitId,
          nanny({
            idDocumentType: 'national_id' as const,
            idDocumentNumber: nationalId,
            fullName: 'Typed Differently',
            phone: uniquePhone(),
          }),
        ),
      );
      expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
      expect(second).toEqual({
        engagementId: expect.any(String) as unknown,
        status: 'pending_review',
        warnings: [],
      });
      const people = await x.asManager(c, () =>
        x.prisma.tenant.domesticWorker.findMany(),
      );
      expect(people).toHaveLength(1);
      expect(people[0].fullName).toBe('Nanny Worker'); // kept as first stored
    });

    it('a banned worker cannot be registered anywhere in the compound', async () => {
      const hm = await home();
      const w = await active(hm);
      const workerId = (await row(hm, w.engagementId)).workerId;
      await x.asManager(hm.c, () =>
        workers.ban(workerId, { code: 'other', text: 'Theft report' }),
      );
      const other = await home(hm.c);
      expect(
        await code(
          asResident(other, () =>
            workers.register(
              other.unitId,
              nanny({ idDocumentNumber: w.input.idDocumentNumber }),
            ),
          ),
        ),
      ).toBe('WORKER_BLOCKED_BY_MANAGEMENT');
    });

    it('a schedule clash with another unit only warns — no unit, no count — and still registers', async () => {
      const c = await x.compound('Workers Court');
      const a = await home(c);
      const b = await home(c);
      const nationalId = nationalIdFor(bornYearsAgo(30));
      await active(a, nanny({ idDocumentNumber: nationalId }));
      const clash = await asResident(b, () =>
        workers.register(
          b.unitId,
          nanny({
            idDocumentType: 'national_id' as const,
            idDocumentNumber: nationalId,
            schedule: { days: [1], windows: [{ from: '12:00', to: '16:00' }] },
          }),
        ),
      );
      expect(clash).toEqual({
        engagementId: expect.any(String) as unknown,
        status: 'pending_review',
        warnings: [{ code: 'WORKER_SCHEDULE_CONFLICT' }],
      });
      // No clash on another day.
      const c2 = await home(c);
      const fine = await asResident(c2, () =>
        workers.register(
          c2.unitId,
          nanny({
            idDocumentType: 'national_id' as const,
            idDocumentNumber: nationalId,
            schedule: { days: [5], windows: [{ from: '12:00', to: '16:00' }] },
          }),
        ),
      );
      expect(fine.warnings).toEqual([]);
    });

    it('an overnight window clashes with the next morning in another unit', async () => {
      const c = await x.compound('Workers Court');
      const a = await home(c);
      const b = await home(c);
      const idDocumentNumber = nationalIdFor(bornYearsAgo(31));
      await active(
        a,
        nanny({
          idDocumentNumber,
          capacity: 'driver',
          schedule: { days: [4], windows: [{ from: '22:00', to: '06:00' }] },
        }),
      );
      const clash = await asResident(b, () =>
        workers.register(
          b.unitId,
          nanny({
            idDocumentNumber,
            schedule: { days: [5], windows: [{ from: '05:00', to: '07:00' }] },
          }),
        ),
      );
      expect(clash.warnings).toEqual([{ code: 'WORKER_SCHEDULE_CONFLICT' }]);
    });

    it('a plain family member cannot register; a workers delegate can, on behalf of the primary', async () => {
      const hm = await home();
      const member = await x.joinFamily(hm.c, hm.unitId, hm.resident);
      const asMember = <T>(fn: () => Promise<T>) =>
        x.as(hm.c, { id: member.id, type: 'family' }, fn);
      expect(
        await code(asMember(() => workers.register(hm.unitId, nanny()))),
      ).toBe('FORBIDDEN');

      await asResident(hm, () =>
        h.moduleRef
          .get(DelegationsService)
          .create(
            hm.unitId,
            member.id,
            ['workers'],
            new Date(Date.now() + 30 * 86_400_000),
          ),
      );
      const reg = await asMember(() => workers.register(hm.unitId, nanny()));
      const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'worker.registered',
        targetId: reg.engagementId,
      });
      expect(entry).toMatchObject({
        actorId: member.id,
        metadata: { onBehalfOf: hm.resident.id },
      });

      await x.asManager(hm.c, () =>
        workers.review(reg.engagementId, 'approve'),
      );
      await asMember(() =>
        workers.suspend(reg.engagementId, { code: 'other', text: 'On leave' }),
      );
      expect((await row(hm, reg.engagementId)).status).toBe('suspended');
    });
  });

  // --------------------------------------------------------------------------
  describe("the manager's review", () => {
    it('a paged list by status, and one engagement with its worker', async () => {
      const hm = await home();
      const input = nanny();
      const first = await asResident(hm, () =>
        workers.register(hm.unitId, input),
      );
      const second = await asResident(hm, () =>
        workers.register(
          hm.unitId,
          nanny({ capacity: 'live_in', schedule: undefined }),
        ),
      );
      const page = await x.asManager(hm.c, () =>
        workers.engagementsForReview({ status: 'pending_review', limit: 1 }),
      );
      expect(page.items).toEqual([
        {
          id: second.engagementId,
          unitId: hm.unitId,
          unitCode: expect.any(String) as string,
          workerId: expect.any(String) as string,
          workerName: 'Nanny Worker',
          capacity: 'live_in',
          status: 'pending_review',
          idDocumentType: 'national_id',
          birthDateVerified: false,
          createdAt: expect.any(Date) as Date,
        },
      ]);
      const rest = await x.asManager(hm.c, () =>
        workers.engagementsForReview({
          status: 'pending_review',
          limit: 1,
          cursor: page.nextCursor!,
        }),
      );
      expect(rest.items.map((e) => e.id)).toEqual([first.engagementId]);
      expect(
        (
          await x.asManager(hm.c, () =>
            workers.engagementsForReview({ status: 'active' }),
          )
        ).items,
      ).toEqual([]);

      const detail = await x.asManager(hm.c, () =>
        workers.engagementDetail(first.engagementId),
      );
      expect(detail).toMatchObject({
        id: first.engagementId,
        requestedBy: { id: hm.resident.id },
        worker: {
          fullName: input.fullName,
          phone: input.phone,
          idDocumentNumber: input.idDocumentNumber,
          banned: false,
        },
      });
      const other = await x.compound();
      expect(
        await code(
          x.asManager(other, () =>
            workers.engagementDetail(first.engagementId),
          ),
        ),
      ).toBe('ENGAGEMENT_NOT_FOUND');
    });

    it("a unit's list pages newest first", async () => {
      const hm = await home();
      const a = await asResident(hm, () =>
        workers.register(hm.unitId, nanny()),
      );
      const b = await asResident(hm, () =>
        workers.register(hm.unitId, nanny()),
      );
      const page = await asResident(hm, () =>
        workers.listForUnit(hm.unitId, { limit: 1 }),
      );
      expect(page.items.map((e) => e.id)).toEqual([b.engagementId]);
      const rest = await asResident(hm, () =>
        workers.listForUnit(hm.unitId, { limit: 1, cursor: page.nextCursor! }),
      );
      expect(rest.items.map((e) => e.id)).toEqual([a.engagementId]);
    });
  });

  // --------------------------------------------------------------------------
  describe('codes', () => {
    it('approval returns the code once and stores only its hash; it has no expiry of its own', async () => {
      const hm = await home();
      const w = await active(hm);
      expect(w.code).toMatch(/^\d{8}$/);
      const stored = await row(hm, w.engagementId);
      expect(stored.accessCodeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(w.code);
      expect(await valid(hm, w.code)).toBe(true);

      // Issued two years ago and still valid while active.
      await x.asManager(hm.c, () =>
        x.prisma.tenant.workerEngagement.update({
          where: { id: w.engagementId },
          data: { codeIssuedAt: new Date(Date.now() - 2 * 365 * 86_400_000) },
        }),
      );
      expect(await valid(hm, w.code)).toBe(true);
    });

    it('rejection needs a reason and issues nothing', async () => {
      const hm = await home();
      const reg = await asResident(hm, () =>
        workers.register(hm.unitId, nanny()),
      );
      expect(
        await code(
          x.asManager(hm.c, () => workers.review(reg.engagementId, 'reject')),
        ),
      ).toBe('REASON_REQUIRED');
      expect(
        await x.asManager(hm.c, () =>
          workers.review(reg.engagementId, 'reject', {
            reason: { code: 'other', text: 'Missing documents' },
          }),
        ),
      ).toBeNull();
      expect(await row(hm, reg.engagementId)).toMatchObject({
        status: 'rejected',
        accessCodeHash: null,
      });
    });

    it('reissue kills the old code at once', async () => {
      const hm = await home();
      const w = await active(hm);
      const fresh = await asResident(hm, () =>
        workers.reissueCode(w.engagementId, 'lost'),
      );
      expect(fresh.accessCode).not.toBe(w.code);
      expect(await valid(hm, w.code)).toBe(false);
      expect(await valid(hm, fresh.accessCode)).toBe(true);
    });

    it('suspend disables the code (kept), resume brings the same code back; each writes a notice', async () => {
      const hm = await home();
      const w = await active(hm);
      const hashBefore = (await row(hm, w.engagementId)).accessCodeHash;

      expect(
        await code(
          asResident(hm, () =>
            workers.suspend(w.engagementId, { code: 'other', text: '' }),
          ),
        ),
      ).toBe('REASON_REQUIRED');
      await asResident(hm, () =>
        workers.suspend(w.engagementId, { code: 'other', text: 'Travelling' }),
      );
      expect(await valid(hm, w.code)).toBe(false);
      expect((await row(hm, w.engagementId)).accessCodeHash).toBe(hashBefore);

      expect(
        await asResident(hm, () => workers.resume(w.engagementId)),
      ).toBeNull();
      expect(await valid(hm, w.code)).toBe(true);

      await asResident(hm, () =>
        workers.end(w.engagementId, { code: 'other', text: 'Contract over' }),
      );
      expect(await valid(hm, w.code)).toBe(false);
      expect((await row(hm, w.engagementId)).accessCodeHash).toBeNull();

      expect(
        (await notices(hm, w.engagementId)).map((n) => [n.noticeKey, n.params]),
      ).toEqual([
        ['engagement_suspended', { reason: 'Travelling' }],
        ['engagement_resumed', {}],
        ['engagement_ended', { reason: 'Contract over' }],
      ]);
      for (const n of await notices(hm, w.engagementId)) {
        expect(JSON.stringify(n)).not.toContain(w.code);
      }
    });

    it('resume issues a new code (once) only if another active engagement took the same one', async () => {
      const hm = await home();
      const first = await active(hm);
      const second = await active(
        hm,
        nanny({ idDocumentNumber: nationalIdFor(bornYearsAgo(28)) }),
      );
      await asResident(hm, () =>
        workers.suspend(first.engagementId, { code: 'other', text: 'Break' }),
      );
      // While `first` is suspended, `second` ends up with the same code (a
      // collision the unique index allows, since it covers active ones only).
      const firstHash = (await row(hm, first.engagementId)).accessCodeHash;
      await x.asManager(hm.c, () =>
        x.prisma.tenant.workerEngagement.update({
          where: { id: second.engagementId },
          data: { accessCodeHash: firstHash },
        }),
      );

      const replaced = await asResident(hm, () =>
        workers.resume(first.engagementId),
      );
      expect(replaced?.accessCode).toMatch(/^\d{8}$/);
      expect(replaced?.accessCode).not.toBe(first.code);
      expect(await valid(hm, replaced!.accessCode)).toBe(true);
      const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'worker.engagement_resumed',
        targetId: first.engagementId,
      });
      expect(entry.metadata).toMatchObject({ codeReplaced: true });
    });
  });

  // --------------------------------------------------------------------------
  describe('management ban', () => {
    it('suspends every active engagement with a notice each; residents see the flag, not the reason; unban leaves them suspended', async () => {
      const c = await x.compound('Workers Court');
      const a = await home(c);
      const b = await home(c);
      const nationalId = nationalIdFor(bornYearsAgo(33));
      const wa = await active(a, nanny({ idDocumentNumber: nationalId }));
      const wb = await active(
        b,
        nanny({
          idDocumentType: 'national_id' as const,
          idDocumentNumber: nationalId,
          schedule: { days: [4], windows: [{ from: '15:00', to: '18:00' }] },
        }),
      );
      const workerId = (await row(a, wa.engagementId)).workerId;

      await x.asManager(c, () =>
        workers.ban(workerId, { code: 'other', text: 'Secret reason XYZ' }),
      );
      for (const [hm, w] of [
        [a, wa],
        [b, wb],
      ] as const) {
        expect(await valid(hm, w.code)).toBe(false);
        expect(await row(hm, w.engagementId)).toMatchObject({
          status: 'suspended',
          suspendedByManagement: true,
        });
        expect(
          (await notices(hm, w.engagementId)).map((n) => n.noticeKey),
        ).toEqual(['engagement_suspended_by_management']);
      }

      const seen = await asResident(a, () =>
        workers.listForUnit(a.unitId).then((p) => p.items),
      );
      expect(seen).toEqual([
        {
          id: wa.engagementId,
          unitId: a.unitId,
          workerName: 'Nanny Worker',
          capacity: 'hourly',
          schedule: wa.input.schedule,
          status: 'suspended',
          validUntil: null,
          suspendedByManagement: true,
        },
      ]);
      expect(JSON.stringify(seen)).not.toContain('Secret reason');

      expect(
        await code(asResident(a, () => workers.resume(wa.engagementId))),
      ).toBe('WORKER_BLOCKED_BY_MANAGEMENT');

      await x.asManager(c, () => workers.unban(workerId));
      expect((await row(a, wa.engagementId)).status).toBe('suspended');
      await asResident(a, () => workers.resume(wa.engagementId));
      expect(await valid(a, wa.code)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  describe('temporary work ends by itself', () => {
    it('reads as ended past valid_until; the first write persists it, with a notice, as system', async () => {
      const hm = await home();
      const w = await active(
        hm,
        nanny({
          capacity: 'temporary',
          validUntil: new Date(Date.now() + 86_400_000),
        }),
      );
      await x.asManager(hm.c, () =>
        x.prisma.tenant.workerEngagement.update({
          where: { id: w.engagementId },
          data: { validUntil: new Date(Date.now() - 1000) },
        }),
      );
      expect(await valid(hm, w.code)).toBe(false);
      expect(
        (
          await asResident(hm, () =>
            workers.listForUnit(hm.unitId).then((p) => p.items),
          )
        )[0].status,
      ).toBe('ended');
      expect((await row(hm, w.engagementId)).status).toBe('active'); // computed

      expect(
        await code(
          asResident(hm, () =>
            workers.suspend(w.engagementId, { code: 'other', text: 'x' }),
          ),
        ),
      ).toBe('ENGAGEMENT_NOT_FOUND');
      expect(await row(hm, w.engagementId)).toMatchObject({
        status: 'ended',
        statusReason: 'expired',
        accessCodeHash: null,
      });
      expect(
        (await notices(hm, w.engagementId)).map((n) => [n.noticeKey, n.params]),
      ).toEqual([['engagement_ended', { reason: 'expired' }]]);
      const [entry] = await auditReaders(h).tenant(hm.c.tenantId, {
        action: 'worker.engagement_ended',
        targetId: w.engagementId,
      });
      expect(entry).toMatchObject({
        actorType: 'system',
        actorId: null,
        metadata: { reason: 'expired' },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('privacy', () => {
    it("a resident sees only their own units' engagements, and nothing identifying", async () => {
      const c = await x.compound('Workers Court');
      const a = await home(c);
      const b = await home(c);
      const nationalId = nationalIdFor(bornYearsAgo(29));
      await active(a, nanny({ idDocumentNumber: nationalId }));
      await active(
        b,
        nanny({
          idDocumentType: 'national_id' as const,
          idDocumentNumber: nationalId,
          schedule: { days: [6], windows: [{ from: '09:00', to: '10:00' }] },
        }),
      );
      const mine = await asResident(a, () =>
        workers.listForUnit(a.unitId).then((p) => p.items),
      );
      expect(mine).toHaveLength(1);
      expect(JSON.stringify(mine)).not.toContain(nationalId);
      expect(JSON.stringify(mine)).not.toContain(b.unitId);
      expect(
        await code(
          asResident(a, () =>
            workers.listForUnit(b.unitId).then((p) => p.items),
          ),
        ),
      ).toBe('UNIT_NOT_FOUND');
    });
  });
});
