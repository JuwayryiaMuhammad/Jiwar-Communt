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
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type Who } from '../setup/safety';

/**
 * One scenario per emergencies and gate services catalog entry (ADR 0014,
 * 0047): actor, target, changes and metadata — ids, codes, statuses and
 * numbers by value; a place's names only as changed, never what a resident
 * wrote.
 */
const covered = new Set<string>();

/** Words typed in every scenario: no audit row may hold them. */
const WORDS = 'Audit-visible words 7731';

describe('Audit coverage — emergencies and gate services', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Safety Audit Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) expect(JSON.stringify(row)).not.toContain(WORDS);
    return found;
  }
  async function single(action: string, targetId: string) {
    const found = await rows(action, targetId);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });

  describe('places', () => {
    it('created and updated: key, position and state by value, names as changed', async () => {
      const created = (
        await x
          .http('post', '/places', s.manager.token, {
            nameEn: WORDS,
            nameAr: 'مكان المراجعة',
            position: 7,
          })
          .expect(201)
      ).body as { id: string };
      const c = await single('place.created', created.id);
      expect(c).toMatchObject(by(s.manager, 'place'));
      expect(c.changes).toEqual({
        nameEn: { changed: true },
        nameAr: { changed: true },
        position: { from: null, to: 7 },
        active: { from: null, to: true },
      });
      await x
        .http('patch', `/places/${created.id}`, s.manager.token, {
          nameEn: `${WORDS} B`,
          active: false,
        })
        .expect(200);
      const u = await single('place.updated', created.id);
      expect(u).toMatchObject(by(s.manager, 'place'));
      expect(u.changes).toEqual({
        nameEn: { changed: true },
        active: { from: true, to: false },
      });
    });
  });

  describe('emergencies, the household', () => {
    it('reported, escalated (nobody to tell), on my way and cancelled: ids, codes and counts', async () => {
      const home = await x.unit(s.c);
      const owner = await x.owner(s.c, home.id);
      const member = await x.family(s.c, home.id, owner);
      // Nobody on shift and no responder in this compound: escalated at once.
      const e = await x.report(owner, home.id, 'fire');
      const r = await single('emergency.reported', e.id);
      expect(r).toMatchObject(by(owner, 'emergency'));
      expect(r.metadata).toEqual({
        number: Number(e.reference.slice(2)),
        type: 'fire',
        unitId: home.id,
        respondersNotified: 0,
        familyNotified: 1,
      });
      const esc = await single('emergency.escalated', e.id);
      expect(esc).toMatchObject(by(owner, 'emergency'));
      expect(esc.metadata).toEqual({ reason: 'no_responders', recipients: 1 });
      await x
        .http('post', `/emergencies/${e.id}/on-my-way`, member.token)
        .expect(200);
      const omw = await single('emergency.family_on_my_way', e.id);
      expect(omw).toMatchObject(by(member, 'emergency'));
      expect(omw.metadata ?? null).toBeNull();
      await x
        .http('post', `/emergencies/${e.id}/cancel`, owner.token, {
          reasonCode: 'resolved_ourselves',
        })
        .expect(200);
      const c = await single('emergency.cancelled', e.id);
      expect(c).toMatchObject(by(owner, 'emergency'));
      expect(c.metadata).toEqual({
        from: 'reported',
        reasonCode: 'resolved_ourselves',
      });
    });
  });

  describe('emergencies, the responders', () => {
    it('accepted, arrived and resolved: minutes, gate, codes; the note as a boolean', async () => {
      const guard = await x.guardOnDuty(s.c);
      const home = await x.unit(s.c);
      const owner = await x.owner(s.c, home.id);
      const e = await x.report(owner, home.id, 'medical');
      await x
        .http('post', `/gate/emergencies/${e.id}/accept`, guard.token, {
          etaMinutes: 15,
        })
        .expect(200);
      const a = await single('emergency.accepted', e.id);
      expect(a).toMatchObject(by(guard, 'emergency'));
      expect(a.metadata).toEqual({ etaMinutes: 15, gateId: guard.gateId });
      await x
        .http('post', `/gate/emergencies/${e.id}/arrived`, guard.token)
        .expect(200);
      const ar = await single('emergency.arrived', e.id);
      expect(ar).toMatchObject(by(guard, 'emergency'));
      expect(ar.metadata ?? null).toBeNull();
      await x
        .http('post', `/gate/emergencies/${e.id}/resolve`, guard.token, {
          reasonCode: 'handled',
          note: WORDS,
        })
        .expect(200);
      const r = await single('emergency.resolved', e.id);
      expect(r).toMatchObject(by(guard, 'emergency'));
      expect(r.metadata).toEqual({
        from: 'arrived',
        reasonCode: 'handled',
        side: 'responder',
        note: true,
      });
      // The guard's shift ends: the rest of this suite has nobody on duty.
      await x
        .http('post', '/gate/shifts/end', guard.token)
        .expect((res) => expect(res.status).toBeLessThan(300));
    });
  });

  describe('catalog completeness', () => {
    it('every emergencies and gate services entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of SAFETY_COVERAGE) {
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
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...SAFETY_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all.filter((k) => /^(place|emergency|gate_service)\./.test(k)).sort(),
      ).toEqual([...SAFETY_COVERAGE].sort());
    });
  });
});
