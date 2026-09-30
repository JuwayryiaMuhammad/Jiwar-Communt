import { Client } from 'pg';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { WorkersService } from '../../src/community/workers/workers.service';
import { auditReaders } from '../setup/audit';
import {
  communityHelpers,
  type Compound,
  type Person,
} from '../setup/community';
import { bornYearsAgo, codeOf, nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';

/** Lost and confiscated cards (ADR 0022, 11 §7). */
describe('Card incidents', () => {
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

  interface Setup {
    c: Compound;
    unitId: string;
    resident: Person;
    engagementId: string;
    code: string;
  }

  async function active(): Promise<Setup> {
    const c = await x.compound('Cards Court');
    const u = await x.unit(c);
    const resident = await x.resident(c, [u.id]);
    const reg = await x.as(c, { id: resident.id, type: 'resident' }, () =>
      workers.register(u.id, {
        fullName: 'Card Worker',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
        phone: uniquePhone(),
        capacity: 'live_in',
      }),
    );
    const issued = await x.asManager(c, () =>
      workers.review(reg.engagementId, 'approve'),
    );
    return {
      c,
      unitId: u.id,
      resident,
      engagementId: reg.engagementId,
      code: issued!.accessCode,
    };
  }

  const valid = (s: Setup, code: string) =>
    x.asManager(s.c, () => workers.isCodeValid(code));
  const mails = (s: Setup, templateKey: string) =>
    globalDb.outboxMessage.findMany({
      where: { tenantId: s.c.tenantId, templateKey },
    });
  const asResident = <T>(s: Setup, fn: () => Promise<T>) =>
    x.as(s.c, { id: s.resident.id, type: 'resident' }, fn);

  it('a lost card: the old code dies in the same transaction, the new one works, the resident is told only that it was reissued', async () => {
    const s = await active();
    const out = await x.asManager(s.c, () =>
      workers.reportCardIncident(s.engagementId, 'lost', 'Lost on the bus'),
    );
    expect(await valid(s, s.code)).toBe(false);
    expect(await valid(s, out.accessCode)).toBe(true);
    const notices = await x.asManager(s.c, () =>
      x.prisma.tenant.workerNotice.findMany({
        where: { engagementId: s.engagementId },
      }),
    );
    expect(notices.map((n) => n.noticeKey)).toContain('code_reissued');
    const [toResident] = await mails(s, 'community.worker_code_reissued');
    expect(toResident.recipientAccountId).toBe(s.resident.id);
    expect(Object.keys(toResident.params as object).sort()).toEqual([
      'compoundName',
      'unitCode',
      'workerName',
    ]);
    expect(await mails(s, 'community.card_confiscated')).toEqual([]);
  });

  it('a confiscation reaches management and security, never the resident', async () => {
    const s = await active();
    const out = await x.asManager(s.c, () =>
      workers.reportCardIncident(
        s.engagementId,
        'confiscated',
        'Kept by the employer',
      ),
    );
    const [staff] = await mails(s, 'community.card_confiscated');
    expect(staff).toMatchObject({
      recipientAccountId: s.c.managerId,
      params: expect.objectContaining({ incidentId: out.incidentId }) as object,
    });
    const [toResident] = await mails(s, 'community.worker_code_reissued');
    const residentMail = JSON.stringify(toResident);
    expect(residentMail).not.toMatch(/confiscat|employer/i);
    const [incident] = await x.asManager(s.c, () =>
      workers.cardIncidents({ status: 'open' }).then((p) => p.items),
    );
    expect(incident).toMatchObject({
      id: out.incidentId,
      type: 'confiscated',
      reportedVia: 'manager',
      note: 'Kept by the employer',
    });
    const [entry] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'worker.card_incident_reported',
      targetId: s.engagementId,
    });
    expect(entry.metadata).toMatchObject({
      type: 'confiscated',
      reportedVia: 'manager',
    });
    expect(JSON.stringify(entry)).not.toContain('employer');

    await x.asManager(s.c, () => workers.closeCardIncident(out.incidentId));
    expect(
      await codeOf(
        x.asManager(s.c, () => workers.closeCardIncident(out.incidentId)),
      ),
    ).toBe('CARD_INCIDENT_NOT_FOUND');
  });

  it("a resident's reissue takes a reason code; only `lost` files an incident; a resident never files a confiscation", async () => {
    const s = await active();
    expect(
      await codeOf(
        asResident(s, () => workers.reissueCode(s.engagementId, 'confiscated')),
      ),
    ).toBe('VALIDATION_FAILED');
    await asResident(s, () =>
      workers.reissueCode(s.engagementId, 'compromised'),
    );
    expect(
      await x.asManager(s.c, () =>
        workers.cardIncidents().then((p) => p.items),
      ),
    ).toEqual([]);
    await asResident(s, () => workers.reissueCode(s.engagementId, 'lost'));
    expect(
      await x.asManager(s.c, () =>
        workers.cardIncidents().then((p) => p.items),
      ),
    ).toEqual([
      expect.objectContaining({ type: 'lost', reportedVia: 'resident' }),
    ]);
    // The resident acted: they are not emailed about their own reissue.
    expect(await mails(s, 'community.worker_code_reissued')).toEqual([]);

    const db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      const { rows } = await db.query<{ worker_id: string }>(
        'SELECT worker_id FROM worker_engagements WHERE id = $1',
        [s.engagementId],
      );
      await expect(
        db.query(
          `INSERT INTO worker_card_incidents
             (id, tenant_id, engagement_id, worker_id, type, reported_via, reported_by)
           VALUES (gen_random_uuid(), $1, $2, $3, 'confiscated', 'resident', $4)`,
          [s.c.tenantId, s.engagementId, rows[0].worker_id, s.resident.id],
        ),
      ).rejects.toThrow(/worker_card_incidents_confiscation_by_manager/);
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });

  it("tenant B can't file or read A's incidents", async () => {
    const a = await active();
    const b = await x.compound();
    expect(
      await codeOf(
        x.asManager(b, () =>
          workers.reportCardIncident(a.engagementId, 'lost'),
        ),
      ),
    ).toBe('ENGAGEMENT_NOT_FOUND');
    await x.asManager(a.c, () =>
      workers.reportCardIncident(a.engagementId, 'lost'),
    );
    expect(
      await x.asManager(b, () => workers.cardIncidents().then((p) => p.items)),
    ).toEqual([]);
  });
});
