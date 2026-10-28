import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { R11A2_COVERAGE } from '../setup/audit-coverage-split';
import { day } from '../setup/compound-clock';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { permitHelpers, type Who } from '../setup/permits';

/**
 * One scenario per R11a-2 entry (ADR 0014, 0063): actor, target and
 * metadata — ids, codes and fields; a name, a phone or an email never.
 */
const covered = new Set<string>();

describe('Audit coverage — R11a-2', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who,
    body?: object,
  ) =>
    h
      .http()
      [method](`${API}${path}`)
      .set('Authorization', `Bearer ${who.token}`)
      .send(body);

  /** Every entry for (action, target), free of the planted values. */
  async function entries(
    tenantId: string,
    action: string,
    targetId: string,
    planted: string[] = [],
  ) {
    const found = await read.tenant(tenantId, { action, targetId });
    covered.add(action);
    for (const e of found)
      for (const value of planted) expect(leakText(e)).not.toContain(value);
    return found;
  }

  describe('moves (ADR 0063)', () => {
    it('planned by the occupancy and by a notice, a step ticked, done at the handover, cancelled', async () => {
      const s = await p.setUp('R11a-2 Moves Audit');
      const moves = (
        await http('get', `/units/${s.home.id}/moves`, s.alice).expect(200)
      ).body as { id: string; direction: string; occupancyId: string }[];
      const moveIn = moves.find((m) => m.direction === 'in')!;
      expect(
        await entries(s.c.tenantId, 'unit_move.planned', moveIn.id),
      ).toEqual([
        expect.objectContaining({
          metadata: {
            unitId: s.home.id,
            occupancyId: moveIn.occupancyId,
            direction: 'in',
            side: 'system',
          },
        }),
      ]);

      await http('post', `/staff/moves/${moveIn.id}/steps`, s.manager, {
        step: 'meters_read',
      }).expect(200);
      expect(
        await entries(s.c.tenantId, 'unit_move.step_done', moveIn.id),
      ).toEqual([
        expect.objectContaining({
          actorId: s.manager.id,
          metadata: {
            unitId: s.home.id,
            step: 'meters_read',
            side: 'management',
          },
        }),
      ]);

      const out = (
        await http('post', `/units/${s.home.id}/moves/move-out`, s.alice, {
          plannedOn: day(5),
        }).expect(201)
      ).body as { id: string; occupancyId: string };
      expect(await entries(s.c.tenantId, 'unit_move.planned', out.id)).toEqual([
        expect.objectContaining({
          actorId: s.alice.id,
          metadata: expect.objectContaining({
            direction: 'out',
            side: 'resident',
          }) as unknown,
        }),
      ]);

      // The occupancy ends: its move-in is cancelled by the system.
      await http('post', `/occupancies/${out.occupancyId}/end`, s.manager, {
        reasonCode: 'moved_out',
        reason: 'Moved away',
      }).expect(200);
      expect(
        await entries(s.c.tenantId, 'unit_move.cancelled', moveIn.id),
      ).toEqual([
        expect.objectContaining({
          metadata: {
            unitId: s.home.id,
            direction: 'in',
            reasonCode: 'occupancy_ended',
            side: 'system',
          },
        }),
      ]);
      await http(
        'post',
        `/occupancies/${out.occupancyId}/handover`,
        s.manager,
        {
          reasonCode: 'dues_disputed',
        },
      ).expect(200);
      expect(await entries(s.c.tenantId, 'unit_move.done', out.id)).toEqual([
        expect.objectContaining({
          actorId: s.manager.id,
          metadata: {
            unitId: s.home.id,
            direction: 'out',
            reasonCode: 'dues_disputed',
          },
        }),
      ]);
    });
  });

  describe('catalog completeness', () => {
    it('every R11a-2 entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11A2_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11A2_COVERAGE].sort());
    });
  });
});
