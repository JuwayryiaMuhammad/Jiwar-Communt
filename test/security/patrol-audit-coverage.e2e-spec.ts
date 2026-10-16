import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
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
  PATROL_COVERAGE,
  PERMITS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type Who } from '../setup/patrols';

/**
 * One scenario per patrols catalog entry (ADR 0014, 0052): actor, target
 * and metadata — ids, codes and counts by value; names and positions as
 * changed; never a token, a hash or what someone wrote.
 */
const covered = new Set<string>();

/** Words typed in every scenario: no audit row may hold them. */
const WORDS = 'Audit-visible patrol words 7741';

describe('Audit coverage — patrols', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Patrol Audit Court');
    read = auditReaders(h);
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
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

  describe('checkpoints', () => {
    it('created, updated, reissued and retired: the post by value, names and position as changed, never the token', async () => {
      const made = await x.checkpoint(
        supervisor,
        { gateId },
        { nameEn: `${WORDS} en`, position: { lat: 30.5, lng: 31.5 } },
      );
      const token = made.qrPayload.split('.')[2];
      const created = await single('patrol_checkpoint.created', made.id);
      expect(created).toMatchObject(by(supervisor, 'patrol_checkpoint'));
      expect(created.changes).toEqual({
        gateId: { from: null, to: gateId },
        nameEn: { changed: true },
        nameAr: { changed: true },
        lat: { changed: true },
        lng: { changed: true },
        radiusM: { from: null, to: 30 },
      });
      const path = `/staff/security/patrols/checkpoints/${made.id}`;
      await x
        .http('patch', path, supervisor.token, {
          nameAr: `${WORDS} ar`,
          position: null,
        })
        .expect(200);
      const updated = await single('patrol_checkpoint.updated', made.id);
      expect(updated.changes).toEqual({
        nameAr: { changed: true },
        lat: { changed: true },
        lng: { changed: true },
        radiusM: { from: 30, to: null },
      });
      const again = (
        await x.http('post', `${path}/reissue`, supervisor.token).expect(200)
      ).body as { qrPayload: string };
      const reissued = await single(
        'patrol_checkpoint.token_reissued',
        made.id,
      );
      expect(reissued).toMatchObject(by(supervisor, 'patrol_checkpoint'));
      await x.http('post', `${path}/retire`, supervisor.token).expect(200);
      const retired = await single('patrol_checkpoint.retired', made.id);
      expect(retired).toMatchObject(by(supervisor, 'patrol_checkpoint'));
      for (const row of await read.tenant(s.c.tenantId, { targetId: made.id }))
        for (const secret of [token, again.qrPayload.split('.')[2]])
          expect(JSON.stringify(row)).not.toContain(secret);
    });
  });

  describe('catalog completeness', () => {
    it('every patrols entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PATROL_COVERAGE) {
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
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...PATROL_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(all.filter((k) => /^patrol_[a-z_]+\./.test(k)).sort()).toEqual(
        [...PATROL_COVERAGE].sort(),
      );
    });
  });
});
