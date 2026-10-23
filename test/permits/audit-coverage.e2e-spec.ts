import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { PEOPLE_DATA_SWEEP } from '../../src/gate/permits/permit-sweeps';
import { auditReaders } from '../setup/audit';
import { eraseNow } from '../setup/erasure';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FACILITIES_COVERAGE,
  FILES_COVERAGE,
  FINANCE_COVERAGE,
  GUARD_DUTY_COVERAGE,
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
import {
  day,
  permitHelpers,
  type PermitSetUp,
  type Who,
} from '../setup/permits';
import { leakText } from '../setup/leak-text';

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
      const dayOff = day(80);
      await p.setRules(s.manager, {
        workDays: [0, 1, 2],
        workHours: { from: '10:00', to: '16:00' },
        daysOff: [dayOff],
      });
      const c = await single('permit_settings.changed', s.c.tenantId);
      expect(c).toMatchObject(by(s.manager, 'tenant'));
      expect(c.changes).toEqual({
        workDays: { from: [0, 1, 2, 3, 4, 6], to: [0, 1, 2] },
        workHours: {
          from: { from: '09:00', to: '17:00' },
          to: { from: '10:00', to: '16:00' },
        },
        daysOff: { from: [], to: [dayOff] },
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
        expect(leakText(row)).not.toMatch(new RegExp(`${WORDS}|9182`));
    });

    it('approved, rejected and revoked by the management: codes and whether there was a note', async () => {
      const a = await p.works(s.alice, s.home.id, {
        dailyHours: { from: '10:00', to: '16:00' },
      });
      await p.decide(s.manager, a.id, 'approve', { note: WORDS }).expect(200);
      const approved = await single('unit_permit.approved', a.id);
      expect(approved).toMatchObject(by(s.manager, 'unit_permit'));
      expect(approved.metadata).toEqual({
        kind: 'works',
        unitId: s.home.id,
        note: true,
      });
      await p
        .decide(s.manager, a.id, 'revoke', {
          reasonCode: 'complaint',
          note: WORDS,
        })
        .expect(200);
      const revoked = await single('unit_permit.revoked', a.id);
      expect(revoked.metadata).toEqual({
        kind: 'works',
        unitId: s.home.id,
        reasonCode: 'complaint',
        note: true,
      });
      const b = await p.works(s.alice, s.home.id, {
        dailyHours: { from: '10:00', to: '16:00' },
      });
      await p
        .decide(s.manager, b.id, 'reject', { reasonCode: 'missing_details' })
        .expect(200);
      const rejected = await single('unit_permit.rejected', b.id);
      expect(rejected.metadata).toEqual({
        kind: 'works',
        unitId: s.home.id,
        reasonCode: 'missing_details',
        note: false,
      });
      for (const row of [approved, revoked, rejected])
        expect(JSON.stringify(row)).not.toContain(WORDS);
    });

    it('the gate’s lookups on the shift; a lockout cleared, by ids', async () => {
      await p.anyTime(s.manager);
      const guard = await p.guardOnDuty(s.c);
      const permit = await p.works(s.alice, s.home.id, {
        startsOn: day(0),
        endsOn: day(1),
        dailyHours: { from: '00:00', to: '23:59' },
      });
      const { worker } = await p.addWorker(s.alice, permit.id, {
        fullName: WORDS,
      });
      await p.approve(s.manager, permit.id);
      await p
        .http('get', `/gate/unit-permits/${permit.id}`, guard.token)
        .expect(200);
      const lookup = await single('gate.permit_lookup', guard.shiftId);
      expect(lookup).toMatchObject(by(guard, 'guard_shift'));
      expect(lookup.metadata).toEqual({
        by: 'id',
        permitIds: [permit.id],
        matches: 1,
      });
      await p
        .http(
          'post',
          `/staff/unit-permits/${permit.id}/workers/${worker.id}/unlock`,
          s.manager.token,
          {},
        )
        .expect(200);
      await p
        .http(
          'post',
          `/staff/unit-permits/${permit.id}/guards/${guard.id}/unlock`,
          s.manager.token,
          {},
        )
        .expect(200);
      const cleared = await read.tenant(s.c.tenantId, {
        action: 'unit_permit.lockout_cleared',
        targetId: permit.id,
      });
      covered.add('unit_permit.lockout_cleared');
      expect(cleared.map((c) => c.metadata)).toEqual([
        { workerId: worker.id },
        { guardId: guard.id },
      ]);
      expect(cleared[0]).toMatchObject(by(s.manager, 'unit_permit'));
      expect(JSON.stringify([lookup, ...cleared])).not.toContain(WORDS);
    });

    it('goods let out once and materials logged in: ids only, never the guard’s words', async () => {
      const guard = await p.guardOnDuty(s.c);
      const exit = await p.exit(s.alice, s.home.id, {
        validFrom: day(0),
        validUntil: day(0),
        items: [{ name: WORDS, quantity: 1 }],
      });
      await p.approve(s.manager, exit.id);
      await p
        .http('post', `/gate/unit-permits/${exit.id}/use`, guard.token, {})
        .expect(200);
      const used = await single('unit_permit.used', exit.id);
      expect(used).toMatchObject(by(guard, 'unit_permit'));
      expect(used.metadata).toEqual({
        kind: 'material_exit',
        unitId: s.home.id,
        gateId: guard.gateId,
      });
      const logged = (
        await p
          .http('post', '/gate/material-entries', guard.token, {
            unitCode: s.home.code,
            description: WORDS,
          })
          .expect(201)
      ).body as { id: string };
      const entry = await single('material_entry.logged', logged.id);
      expect(entry).toMatchObject(by(guard, 'material_entry'));
      expect(entry.metadata).toEqual({
        unitId: s.home.id,
        permitId: null,
        gateId: guard.gateId,
      });
      expect(JSON.stringify([used, entry])).not.toContain(WORDS);
    });

    it('an event: requested at once, its guests changed by counts', async () => {
      const event = await p.event(s.alice, s.home.id, 2, {
        title: WORDS,
        guests: [
          { fullName: WORDS, vehiclePlate: 'AUD 1' },
          { fullName: 'Second Guest' },
        ],
      });
      const r = await single('unit_permit.requested', event.id);
      expect(r.metadata).toMatchObject({
        kind: 'event',
        approvedAtOnce: true,
        title: true,
        guests: 2,
      });
      await p
        .http('post', `/permits/${event.id}/guests`, s.alice.token, {
          guests: [{ fullName: WORDS }],
        })
        .expect(201);
      await p
        .http(
          'post',
          `/permits/${event.id}/guests/${event.event!.guests[0].id}/remove`,
          s.alice.token,
          {},
        )
        .expect(200);
      const found = await read.tenant(s.c.tenantId, {
        action: 'unit_permit.guests_changed',
        targetId: event.id,
      });
      covered.add('unit_permit.guests_changed');
      expect(found.map((f) => f.metadata)).toEqual([
        { added: 1, removed: 0, guests: 3 },
        { added: 0, removed: 1, guests: 2 },
      ]);
      expect(found[0]).toMatchObject(by(s.alice, 'unit_permit'));
      expect(JSON.stringify([r, ...found])).not.toMatch(
        new RegExp(`${WORDS}|AUD 1`),
      );
    });
  });

  describe('privacy', () => {
    it('text_cleared at the requester’s erasure (booleans), data_purged by the system 30 days on (counts)', async () => {
      const c = await p.setUp('Permits Audit Privacy Court');
      const joined = await p.v.x.joinFamily(c.c, c.home.id, c.alice);
      const member = await p.who(c.c, joined.accountId, 'family');
      await p.v.x.as(c.c, { id: c.alice.id, type: 'resident' }, () =>
        h.moduleRef
          .get(MemberPermissionsService)
          .grant(joined.memberId, 'visitors_invite'),
      );
      const event = await p.event(member, c.home.id, 1, {
        title: 'Audit privacy words',
      });
      await eraseNow(h, c.c, member.id);
      const cleared = (
        await read.tenant(c.c.tenantId, {
          action: 'unit_permit.text_cleared',
          targetId: event.id,
        })
      )[0];
      covered.add('unit_permit.text_cleared');
      // Done by whoever ran the erasure, on the account's behalf.
      expect(cleared.targetType).toBe('unit_permit');
      expect(cleared.metadata).toEqual({
        kind: 'event',
        contractorCompany: false,
        description: false,
        itemsDescription: false,
        items: false,
        title: true,
        photo: false,
      });
      // eslint-disable-next-line no-restricted-syntax -- a real 40 × 24 h: people data is purged 30 × 24 h after the end, in ms
      await p.sweep(PEOPLE_DATA_SWEEP, new Date(Date.now() + 40 * 86_400_000));
      const purged = (
        await read.tenant(c.c.tenantId, {
          action: 'unit_permit.data_purged',
          targetId: event.id,
        })
      )[0];
      covered.add('unit_permit.data_purged');
      expect(purged).toMatchObject({
        actorType: 'system',
        targetType: 'unit_permit',
      });
      expect(purged.metadata).toEqual({
        kind: 'event',
        workers: 0,
        guests: 1,
        truckPlate: false,
        photo: false,
      });
      expect(JSON.stringify([cleared, purged])).not.toContain('Guest Number');
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
          ...GUARD_DUTY_COVERAGE,
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
