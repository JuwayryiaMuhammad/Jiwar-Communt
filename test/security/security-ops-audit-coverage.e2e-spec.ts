import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { BLOCKLIST_SWEEP } from '../../src/gate/blocklist/blocklist.service';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FACILITIES_COVERAGE,
  FILES_COVERAGE,
  FINANCE_COVERAGE,
  GOVERNANCE_COVERAGE,
  GUARD_DUTY_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  NEIGHBOURS_COVERAGE,
  PARCELS_COVERAGE,
  PATROL_COVERAGE,
  PERMITS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  SECURITY_OPS_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { day, permitHelpers } from '../setup/permits';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

/**
 * One scenario per security catalog entry of ADR 0053 (ADR 0014): actor,
 * target and metadata — ids, codes and counts by value; never a name, a
 * plate, an ID number or its hash, or what someone wrote.
 */
const covered = new Set<string>();

/** Words typed in every scenario: no audit row may hold them. */
const WORDS = 'Audit-visible security words 5521';

describe('Audit coverage — security (ADR 0053)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Security Audit Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) expect(leakText(row)).not.toContain(WORDS);
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
  const system = (targetType: string) => ({
    actorType: 'system',
    actorId: null,
    targetType,
  });
  const DAY = 86_400_000;

  describe('the lockdown', () => {
    it('started, overridden and ended: scope, codes, shift and counts; the end’s note only as whether there was one', async () => {
      const gate = await x.g.gate(s.c);
      const guard = await x.guardAt(s.c, gate.id);
      const l = await x.lockdown(guard, {
        scope: 'gate',
        gateId: gate.id,
        reasonCode: 'drill',
      });
      const started = await single('gate_lockdown.started', l.id);
      expect(started).toMatchObject(by(guard, 'gate_lockdown'));
      expect(started.metadata).toEqual({
        scope: 'gate',
        gateId: gate.id,
        reasonCode: 'drill',
        shiftId: guard.shiftId,
        recipients: 1,
        residents: 1,
      });
      const o = (
        await x
          .http('post', `/gate/lockdowns/${l.id}/overrides`, guard.token, {
            reasonCode: 'fire_truck',
          })
          .expect(201)
      ).body as { id: string };
      const override = await single('gate_lockdown.override', l.id);
      expect(override).toMatchObject(by(guard, 'gate_lockdown'));
      expect(override.metadata).toEqual({
        overrideId: o.id,
        gateId: gate.id,
        shiftId: guard.shiftId,
        kind: 'fire_truck',
        emergencyId: null,
        gateServiceRequestId: null,
      });
      await x
        .endLockdownRaw(s.manager, l.id, {
          reasonCode: 'drill_over',
          note: WORDS,
        })
        .expect(200);
      const ended = await single('gate_lockdown.ended', l.id);
      expect(ended).toMatchObject(by(s.manager, 'gate_lockdown'));
      expect(ended.metadata).toEqual({
        scope: 'gate',
        gateId: gate.id,
        reasonCode: 'drill_over',
        note: true,
        recipients: 1,
        residents: 1,
      });
    });
  });

  describe('the blocklist', () => {
    it('created, updated, lifted: codes and booleans; never the plate, the name, the ID or its hash, nor the note', async () => {
      const e = await x.block(s.manager, {
        kind: 'watch',
        subject: 'person',
        fullName: `${WORDS} Name`,
        idNumber: 'AUD55210',
        photoFileId: await x.photo(s.manager),
        note: WORDS,
        reasonCode: 'fraud',
      });
      const created = await single('blocklist_entry.created', e.id);
      expect(created).toMatchObject(by(s.manager, 'blocklist_entry'));
      expect(created.metadata).toEqual({
        kind: 'watch',
        subject: 'person',
        reasonCode: 'fraud',
        expiresAt: null,
        photo: true,
        note: true,
      });
      const hash = (
        await x.inTx(s.c, (tx) =>
          tx.blocklistEntry.findUniqueOrThrow({ where: { id: e.id } }),
        )
      ).idHash!;
      await x
        .http('patch', `/staff/security/blocklist/${e.id}`, s.manager.token, {
          kind: 'ban',
          note: `${WORDS} again`,
        })
        .expect(200);
      const updated = await single('blocklist_entry.updated', e.id);
      expect(updated).toMatchObject(by(s.manager, 'blocklist_entry'));
      expect(updated.metadata).toEqual({
        changed: ['kind', 'note'],
        kind: 'ban',
        reasonCode: 'fraud',
        expiresAt: null,
      });
      await x
        .http(
          'post',
          `/staff/security/blocklist/${e.id}/lift`,
          s.manager.token,
          {
            reasonCode: 'resolved',
          },
        )
        .expect(200);
      const lifted = await single('blocklist_entry.lifted', e.id);
      expect(lifted).toMatchObject(by(s.manager, 'blocklist_entry'));
      expect(lifted.metadata).toEqual({ reasonCode: 'resolved' });
      for (const row of [created, updated, lifted])
        expect(leakText(row)).not.toMatch(new RegExp(`AUD55210|${hash}`));
      // 30 days on, the system purges the person's data.
      await x.sweep(BLOCKLIST_SWEEP, new Date(Date.now() + 31 * DAY));
      const purged = await single('blocklist_entry.purged', e.id);
      expect(purged).toMatchObject(system('blocklist_entry'));
      expect(purged.metadata).toEqual({ photo: true });
    });

    it('the guard’s ID lookup: on the shift, the entries’ ids and how many; never the number', async () => {
      const guard = await x.guardOnDuty(s.c);
      const e = await x.block(s.manager, {
        subject: 'person',
        fullName: 'Looked Up',
        idNumber: 'AUD77001',
      });
      await x
        .http('post', '/gate/id-lookup', guard.token, { idNumber: 'aud 77001' })
        .expect(200);
      const looked = await single('gate.id_lookup', guard.shiftId);
      expect(looked).toMatchObject(by(guard, 'guard_shift'));
      expect(looked.metadata).toEqual({ entryIds: [e.id], matches: 1 });
      expect(leakText(looked)).not.toContain('77001');
    });

    it('expired: lifted by the system, no metadata', async () => {
      const e = await x.block(s.manager, {
        subject: 'plate',
        plate: 'AUD 5521',
        expiresAt: new Date(Date.now() + DAY).toISOString(),
      });
      await x.sweep(BLOCKLIST_SWEEP, new Date(Date.now() + 2 * DAY));
      const expired = await single('blocklist_entry.expired', e.id);
      expect(expired).toMatchObject(system('blocklist_entry'));
      expect(expired.metadata).toBeNull();
      expect(leakText(expired)).not.toMatch(/5521|AUD/);
    });
  });

  describe('stop work', () => {
    it('stopped by a guard and resumed by the management: the code, the side, the shift, how many were told', async () => {
      const p = permitHelpers(h);
      const c = await p.setUp('Security Audit Permits Court');
      await p.anyTime(c.manager);
      const guard = await p.guardOnDuty(c.c);
      const permit = await p.works(c.alice, c.home.id, {
        startsOn: day(0),
        endsOn: day(1),
        dailyHours: { from: '00:00', to: '23:59' },
      });
      await p.approve(c.manager, permit.id);
      await p
        .http(
          'post',
          `/gate/unit-permits/${permit.id}/stop-work`,
          guard.token,
          {
            reasonCode: 'damage',
          },
        )
        .expect(200);
      const read = (action: string) =>
        auditReaders(h).tenant(c.c.tenantId, { action, targetId: permit.id });
      const [stopped] = await read('permit_work.stopped');
      covered.add('permit_work.stopped');
      expect(stopped).toMatchObject({
        actorId: guard.id,
        targetType: 'unit_permit',
      });
      expect(stopped.metadata).toEqual({
        reasonCode: 'damage',
        side: 'guard',
        shiftId: guard.shiftId,
        recipients: 2,
      });
      const stop = await p.inTx(c.c, (tx) =>
        tx.permitWorkStop.findFirstOrThrow({ where: { permitId: permit.id } }),
      );
      await p
        .http(
          'post',
          `/staff/unit-permits/${permit.id}/resume-work`,
          c.manager.token,
          {},
        )
        .expect(200);
      const [resumed] = await read('permit_work.resumed');
      covered.add('permit_work.resumed');
      expect(resumed).toMatchObject({
        actorId: c.manager.id,
        targetType: 'unit_permit',
      });
      expect(resumed.metadata).toEqual({ stopId: stop.id, recipients: 1 });
    });
  });

  describe('incidents', () => {
    it('reported, assigned, noted, acknowledged and closed: ids, codes and counts; never the words', async () => {
      const guard = await x.guardOnDuty(s.c);
      const supervisor = await x.supervisor(s.c);
      const res = await x
        .http('post', '/gate/incidents', guard.token, {
          type: 'injury',
          severity: 'high',
          unitCode: s.home.code,
          occurredAt: new Date().toISOString(),
          description: WORDS,
        })
        .expect(201);
      const id = (res.body as { id: string }).id;
      const reported = await single('incident.reported', id);
      expect(reported).toMatchObject(by(guard, 'incident'));
      expect(reported.metadata).toEqual({
        number: expect.any(Number) as number,
        type: 'injury',
        severity: 'high',
        placeId: null,
        unitId: s.home.id,
        shiftId: guard.shiftId,
        photos: 0,
        emergencyId: null,
        gateServiceRequestId: null,
        patrolNoteId: null,
      });
      const staff = (path: string, body: object) =>
        x
          .http(
            'post',
            `/staff/security/incidents/${id}/${path}`,
            s.manager.token,
            body,
          )
          .expect(200);
      await staff('assign', { investigatorId: supervisor.id });
      expect((await single('incident.assigned', id)).metadata).toEqual({
        investigatorId: supervisor.id,
        from: null,
      });
      await staff('notes', { body: WORDS });
      const noted = await single('incident.note_added', id);
      expect(noted).toMatchObject(by(s.manager, 'incident'));
      expect(noted.metadata).toEqual({
        noteId: expect.any(String) as string,
      });
      await staff('acknowledge', { role: 'reviewer' });
      expect((await single('incident.acknowledged', id)).metadata).toEqual({
        role: 'reviewer',
      });
      await staff('close', { reasonCode: 'referred_to_police', note: WORDS });
      expect((await single('incident.closed', id)).metadata).toEqual({
        outcome: 'referred_to_police',
        from: 'investigating',
      });
    });
  });

  describe('catalog completeness', () => {
    it('every security entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of SECURITY_OPS_COVERAGE) {
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
          ...PERMITS_COVERAGE,
          ...GUARD_DUTY_COVERAGE,
          ...GOVERNANCE_COVERAGE,
          ...PATROL_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...SECURITY_OPS_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter(
            (k) =>
              /^(gate_lockdown|blocklist|incident|violation|unit_violation|permit_work)[a-z_]*\./.test(
                k,
              ) || k === 'gate.id_lookup',
          )
          .sort(),
      ).toEqual([...SECURITY_OPS_COVERAGE].sort());
    });
  });
});
