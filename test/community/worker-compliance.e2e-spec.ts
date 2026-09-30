import { RolesService } from '../../src/core/access/roles.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import {
  WorkersService,
  type NewWorker,
} from '../../src/community/workers/workers.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo, codeOf, nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

const REPORT = { code: 'report_received', text: 'The school says she is 16' };

/** A worker found to be under 18 after registration (ADR 0022, 11 §7). */
describe('Worker compliance', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let workers: WorkersService;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    workers = h.moduleRef.get(WorkersService);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  const worker = (over: Partial<NewWorker> = {}): NewWorker => ({
    fullName: 'Compliance Worker',
    idDocumentType: 'national_id',
    idDocumentNumber: nationalIdFor(bornYearsAgo(25)),
    phone: uniquePhone(),
    capacity: 'hourly',
    schedule: { days: [1], windows: [{ from: '08:00', to: '12:00' }] },
    ...over,
  });

  /** The same worker active in two units of one compound. */
  async function twoUnits() {
    const c = await x.compound('Compliance Court');
    const input = worker();
    const out: {
      unitId: string;
      residentId: string;
      engagementId: string;
      code: string;
    }[] = [];
    for (let i = 0; i < 2; i++) {
      const u = await x.unit(c);
      const r = await x.resident(c, [u.id]);
      const reg = await x.as(c, { id: r.id, type: 'resident' }, () =>
        workers.register(u.id, {
          ...input,
          schedule: {
            days: [i + 1],
            windows: [{ from: '08:00', to: '12:00' }],
          },
        }),
      );
      const issued = await x.asManager(c, () =>
        workers.review(reg.engagementId, 'approve'),
      );
      out.push({
        unitId: u.id,
        residentId: r.id,
        engagementId: reg.engagementId,
        code: issued!.accessCode,
      });
    }
    const workerId = (
      await x.asManager(c, () =>
        x.prisma.tenant.workerEngagement.findUniqueOrThrow({
          where: { id: out[0].engagementId },
        }),
      )
    ).workerId;
    return { c, engagements: out, workerId };
  }

  const valid = (c: Compound, code: string) =>
    x.asManager(c, () => workers.isCodeValid(code));

  it('a report stops every code at once, opens a case for compliance, and owes the wage in full', async () => {
    const { c, engagements, workerId } = await twoUnits();
    expect(
      await codeOf(
        x.asManager(c, () =>
          workers.reportUnderage(workerId, { code: 'rumour', text: 'x' }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    const caseId = await x.asManager(c, () =>
      workers.reportUnderage(workerId, REPORT),
    );

    for (const e of engagements) expect(await valid(c, e.code)).toBe(false);
    const cases = await x.asManager(c, () =>
      workers.complianceCases({ status: 'open' }),
    );
    expect(cases).toEqual([
      expect.objectContaining({
        id: caseId,
        workerId,
        kind: 'underage',
        source: 'report',
      }),
    ]);
    const obligations = await x.asManager(c, () =>
      x.prisma.tenant.workerWageObligation.findMany({ where: { workerId } }),
    );
    expect(obligations.map((o) => [o.engagementId, o.kind]).sort()).toEqual(
      engagements.map((e) => [e.engagementId, 'pay_in_full']).sort(),
    );
    // Reported to the compliance officer (here: the manager, by default).
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'community.compliance_case_opened',
      },
    });
    expect(mail).toMatchObject({
      recipientAccountId: c.managerId,
      params: expect.objectContaining({ caseId }) as object,
    });
    expect(JSON.stringify(mail.params)).not.toContain('Compliance Worker');

    // Nobody resumes while the case is open, not even the manager.
    expect(
      await codeOf(
        x.asManager(c, () => workers.resume(engagements[0].engagementId)),
      ),
    ).toBe('WORKER_COMPLIANCE_HOLD');
    // A second report keeps the one case.
    await x.asManager(c, () => workers.reportUnderage(workerId, REPORT));
    expect(await x.asManager(c, () => workers.complianceCases())).toHaveLength(
      1,
    );

    const [opened] = await auditReaders(h).tenant(c.tenantId, {
      action: 'worker.compliance_case_opened',
      targetId: workerId,
    });
    expect(opened.metadata).toMatchObject({
      caseId,
      source: 'report',
      reasonCode: 'report_received',
    });
    expect(JSON.stringify(opened)).not.toContain('school');

    expect(
      await codeOf(
        x.asManager(c, () =>
          workers.closeComplianceCase(caseId, { code: 'unfounded' }),
        ),
      ),
    ).toBe('REASON_REQUIRED');
    await x.asManager(c, () =>
      workers.closeComplianceCase(caseId, {
        code: 'unfounded',
        text: 'ID verified at the registry',
      }),
    );
    // Closed: the adult worker can be resumed; the obligations stay for payroll.
    await x.asManager(c, () => workers.resume(engagements[0].engagementId));
    expect(
      await x.asManager(c, () =>
        x.prisma.tenant.workerWageObligation.count({
          where: { workerId, settledAt: null },
        }),
      ),
    ).toBe(2);
  });

  it('a corrected passport birth date under 18 opens the case too (source birth_date_correction)', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const r = await x.resident(c, [u.id]);
    const reg = await x.as(c, { id: r.id, type: 'resident' }, () =>
      workers.register(
        u.id,
        worker({
          idDocumentType: 'passport',
          idDocumentNumber: `P${Date.now().toString().slice(-7)}`,
          nationality: 'PH',
          birthDate: bornYearsAgo(30),
        }),
      ),
    );
    await x.asManager(c, () =>
      workers.review(reg.engagementId, 'approve', { birthDateConfirmed: true }),
    );
    const { workerId } = await x.asManager(c, () =>
      x.prisma.tenant.workerEngagement.findUniqueOrThrow({
        where: { id: reg.engagementId },
      }),
    );
    await x.asManager(c, () =>
      workers.correctBirthDate(workerId, bornYearsAgo(16)),
    );
    expect(await x.asManager(c, () => workers.complianceCases())).toEqual([
      expect.objectContaining({
        workerId,
        source: 'birth_date_correction',
        status: 'open',
      }),
    ]);
    expect(
      await x.asManager(c, () =>
        x.prisma.tenant.workerWageObligation.findMany({ where: { workerId } }),
      ),
    ).toEqual([expect.objectContaining({ kind: 'pay_in_full' })]);
  });

  it('with nobody holding workers.compliance, the notice is on file as undeliverable', async () => {
    const { c, workerId } = await twoUnits();
    const roles = h.moduleRef.get(RolesService);
    await x.asManager(c, async () => {
      const manager = (await roles.list()).find((r) => r.key === 'manager')!;
      await roles.replacePermissions(
        manager.id,
        manager.permissions.filter((p) => p !== 'workers.compliance'),
      );
    });
    await x.asManager(c, () => workers.reportUnderage(workerId, REPORT));
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'community.compliance_case_opened',
      },
    });
    expect(mail).toMatchObject({
      status: 'dead',
      lastErrorCode: 'NO_RECIPIENT',
    });
  });

  it("tenant B can't report A's worker or close A's case", async () => {
    const a = await twoUnits();
    const b = await x.compound();
    expect(
      await codeOf(
        x.asManager(b, () => workers.reportUnderage(a.workerId, REPORT)),
      ),
    ).toBe('WORKER_NOT_FOUND');
    const caseId = await x.asManager(a.c, () =>
      workers.reportUnderage(a.workerId, REPORT),
    );
    expect(
      await codeOf(
        x.asManager(b, () =>
          workers.closeComplianceCase(caseId, { code: 'resolved', text: 'x' }),
        ),
      ),
    ).toBe('COMPLIANCE_CASE_NOT_FOUND');
    expect(await x.asManager(b, () => workers.complianceCases())).toEqual([]);
  });
});
