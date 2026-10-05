import { WorkerWagesService } from '../../src/community/workers/worker-wages.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { RESIDENT_SCREENS_COVERAGE } from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/**
 * One scenario per catalog entry of the resident's screens (ADR 0037), each
 * asserting actor, target and metadata, with no personal or money values
 * (strict in tests).
 */
const covered = new Set<string>();

describe('Audit coverage — the resident’s screens (ADR 0037)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  /** Exactly one entry for (action, target); marks the action covered. */
  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  /** A resident of a new unit with an approved worker. */
  async function engaged() {
    const c = await x.compound();
    const u = await x.unit(c);
    const r = await x.resident(c, [u.id]);
    const workers = h.moduleRef.get(WorkersService);
    const as = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: r.id, type: 'resident' }, fn);
    const reg = await as(() =>
      workers.register(u.id, {
        fullName: 'Audited Worker',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
        phone: uniquePhone(),
        capacity: 'live_in',
      }),
    );
    await x.asManager(c, () => workers.review(reg.engagementId, 'approve'));
    return { c, u, r, as, id: reg.engagementId, workers };
  }

  describe('wages', () => {
    it('worker.wage_changed — by the resident, never the amount', async () => {
      const { c, u, r, as, id } = await engaged();
      const wages = h.moduleRef.get(WorkerWagesService);
      await as(() => wages.setWage(id, '4100.00'));
      const entry = await single(c, 'worker.wage_changed', id);
      expect(entry).toMatchObject({
        actorType: 'account',
        actorId: r.id,
        targetType: 'worker_engagement',
        metadata: { unitId: u.id, set: true },
      });
      expect(JSON.stringify(entry)).not.toContain('4100');
    });

    it('worker.wage_obligation_settled — a payment after the end', async () => {
      const { c, u, r, as, id, workers } = await engaged();
      await as(() => workers.end(id, { code: 'work_finished', text: 'Done' }));
      const wages = h.moduleRef.get(WorkerWagesService);
      const month = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
      })
        .format(new Date())
        .slice(0, 7);
      const paid = await as(() =>
        wages.pay(id, { period: month, amount: 900 }),
      );
      const entry = await single(c, 'worker.wage_obligation_settled', id);
      expect(entry).toMatchObject({
        actorId: r.id,
        targetType: 'worker_engagement',
        metadata: {
          kind: 'settle_before_close',
          paymentId: paid.id,
          unitId: u.id,
        },
      });
      expect(JSON.stringify(entry)).not.toContain('900');
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the resident’s screens has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of RESIDENT_SCREENS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual(
        [...RESIDENT_SCREENS_COVERAGE].sort(),
      );
    });
  });
});
