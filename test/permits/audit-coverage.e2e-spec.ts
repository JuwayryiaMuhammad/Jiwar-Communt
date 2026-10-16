import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FACILITIES_COVERAGE,
  FILES_COVERAGE,
  FINANCE_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  NEIGHBOURS_COVERAGE,
  PARCELS_COVERAGE,
  PERMITS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type PermitSetUp, type Who } from '../setup/permits';

/**
 * One scenario per permits catalog entry (ADR 0014, 0049): actor, target,
 * changes and metadata — ids, kinds, statuses, codes, dates and counts by
 * value; never a name, a plate, a last 4 or what anyone wrote.
 */
const covered = new Set<string>();

describe('Audit coverage — permits', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let s: PermitSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    s = await p.setUp('Permits Audit Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });

  describe('the rules', () => {
    it('changed: the days, hours and days off by value', async () => {
      await p.setRules(s.manager, {
        workDays: [0, 1, 2],
        workHours: { from: '10:00', to: '16:00' },
        daysOff: ['2027-01-07'],
      });
      const c = await single('permit_settings.changed', s.c.tenantId);
      expect(c).toMatchObject(by(s.manager, 'tenant'));
      expect(c.changes).toEqual({
        workDays: { from: [0, 1, 2, 3, 4, 6], to: [0, 1, 2] },
        workHours: {
          from: { from: '09:00', to: '17:00' },
          to: { from: '10:00', to: '16:00' },
        },
        daysOff: { from: [], to: ['2027-01-07'] },
      });
    });
  });

  describe('permits and their workers', () => {
    /** Words typed in every scenario: no audit row may hold them. */
    const WORDS = 'Audit-visible words 4471';

    it('requested, a worker added and removed, cancelled: ids, kinds, codes and counts', async () => {
      // The rules above allow Sunday to Tuesday, 10:00–16:00.
      const permit = await p.works(s.alice, s.home.id, {
        description: WORDS,
        contractorCompany: WORDS,
        dailyHours: { from: '10:00', to: '16:00' },
      });
      const r = await single('unit_permit.requested', permit.id);
      expect(r).toMatchObject(by(s.alice, 'unit_permit'));
      expect(r.metadata).toEqual({
        number: expect.any(Number) as number,
        kind: 'works',
        unitId: s.home.id,
        startsAt: permit.startsAt,
        endsAt: permit.endsAt,
        approvedAtOnce: false,
        workType: 'renovation',
        dailyFrom: '10:00',
        dailyTo: '16:00',
        contractorCompany: true,
        description: true,
      });
      const { worker } = await p.addWorker(s.alice, permit.id, {
        fullName: WORDS,
        idLast4: '9182',
      });
      const added = await single('unit_permit.worker_added', permit.id);
      expect(added).toMatchObject(by(s.alice, 'unit_permit'));
      expect(added.metadata).toEqual({
        workerId: worker.id,
        idType: 'national_id',
        workers: 1,
      });
      await p
        .http(
          'post',
          `/permits/${permit.id}/workers/${worker.id}/remove`,
          s.alice.token,
          {},
        )
        .expect(200);
      const removed = await single('unit_permit.worker_removed', permit.id);
      expect(removed.metadata).toEqual({
        workerId: worker.id,
        side: 'requester',
        reasonCode: null,
      });
      await p
        .http('post', `/permits/${permit.id}/cancel`, s.alice.token, {
          reasonCode: 'plans_changed',
        })
        .expect(200);
      const cancelled = await single('unit_permit.cancelled', permit.id);
      expect(cancelled).toMatchObject(by(s.alice, 'unit_permit'));
      expect(cancelled.metadata).toEqual({
        kind: 'works',
        unitId: s.home.id,
        from: 'pending',
        side: 'requester',
        reasonCode: 'plans_changed',
      });
      for (const row of [r, added, removed, cancelled])
        expect(JSON.stringify(row)).not.toMatch(new RegExp(`${WORDS}|9182`));
    });
  });

  describe('catalog completeness', () => {
    it('every permits entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PERMITS_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
          ...R1_COVERAGE,
          ...RESIDENT_SCREENS_COVERAGE,
          ...MANAGEMENT_COVERAGE,
          ...ENGAGEMENT_COVERAGE,
          ...NEIGHBOURS_COVERAGE,
          ...FACILITIES_COVERAGE,
          ...VEHICLES_COVERAGE,
          ...FINANCE_COVERAGE,
          ...SAFETY_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...PERMITS_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter((k) =>
            /^(permit_settings|unit_permit|material_entry)\.|^gate\.permit_lookup$/.test(
              k,
            ),
          )
          .sort(),
      ).toEqual([...PERMITS_COVERAGE].sort());
    });
  });
});
