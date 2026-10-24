import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { GOVERNANCE_VOICE_COVERAGE } from '../setup/audit-coverage-split';
import { boardAppealHelpers } from '../setup/board-appeals';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';

/**
 * One scenario per entry of the owners' voice in governance (ADR 0014,
 * 0059): representatives, agenda proposals, objections and the follow-up
 * of decisions — ids, codes and the building's label; never a message, a
 * proposal's words, an objection's grounds or a reply's.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — the owners’ voice in governance', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    // o(0), o(1), o(2) sit; all six own a unit each in building A.
    s = await a.setUp(6, 3);
    read = auditReaders(h);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];

  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    expect(leakText(found[0])).not.toContain(MARKER);
    return found[0];
  }

  describe('representatives', () => {
    /** Raised by `by`, carried by o(0) and o(1)'s votes: the matter's id. */
    const carried = async (body: Record<string, unknown>, by = o(0)) => {
      const matterId = (
        (
          await a
            .http('post', '/board/representatives/matters', by.token, body)
            .expect(201)
        ).body as { id: string }
      ).id;
      const motionId = (
        (
          await a
            .http(
              'post',
              `/board/representatives/matters/${matterId}/motions`,
              o(0).token,
              { outcome: 'approve', rationale: `${MARKER} reasons` },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      await a.vote(o(0), motionId, 'for').expect(201);
      await a.vote(o(1), motionId, 'for').expect(201);
      return { matterId, motionId };
    };
    const sitting = async () =>
      (
        (await a.http('get', '/board/representatives', o(0).token).expect(200))
          .body as { id: string; building: string; endedAt: string | null }[]
      ).find((r) => r.building === 'A' && !r.endedAt)!;

    it('a matter raised, withdrawn and decided: whom it names and how, by value', async () => {
      const withdrawn = (
        (
          await a
            .http('post', '/board/representatives/matters', o(1).token, {
              action: 'appoint',
              building: 'A',
              accountId: o(5).id,
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const raised = await single(
        'governance_representative_matter.raised',
        withdrawn,
      );
      expect(raised).toMatchObject({
        actorId: o(1).id,
        targetType: 'governance_representative_matter',
      });
      expect(raised.metadata).toEqual({
        action: 'appoint',
        building: 'A',
        accountId: o(5).id,
        representativeId: null,
      });
      await a
        .http(
          'post',
          `/board/representatives/matters/${withdrawn}/withdraw`,
          o(1).token,
        )
        .expect(200);
      expect(
        (await single('governance_representative_matter.withdrawn', withdrawn))
          .metadata,
      ).toEqual({ motionId: null });

      const { matterId, motionId } = await carried({
        action: 'appoint',
        building: 'A',
        accountId: o(3).id,
      });
      const decided = await single(
        'governance_representative_matter.decided',
        matterId,
      );
      expect(decided).toMatchObject({ actorId: o(1).id });
      expect(decided.metadata).toEqual({
        decision: 'approved',
        motionId,
        effect: 'applied',
        effectReason: null,
      });
    });

    it('appointed, replaced and ended by the board’s matters: the building and the unit, by value', async () => {
      const first = await sitting();
      await a
        .http('post', `/me/representatives/${first.id}/messages`, o(4).token, {
          body: `${MARKER} the lift`,
        })
        .expect(201);
      const appointed = await single(
        'governance_representative.appointed',
        first.id,
      );
      // The vote that carried it applied it.
      expect(appointed).toMatchObject({
        actorId: o(1).id,
        targetType: 'governance_representative',
      });
      expect(appointed.metadata).toEqual({
        building: 'A',
        unitId: o(3).unitId,
        replacedId: null,
        matterId: expect.any(String) as string,
      });
      const replacing = await carried({
        action: 'appoint',
        building: 'A',
        accountId: o(4).id,
      });
      expect(
        (await single('governance_representative.ended', first.id)).metadata,
      ).toEqual({
        building: 'A',
        reason: 'replaced',
        matterId: replacing.matterId,
      });
      const second = await sitting();
      const ending = await carried({
        action: 'end',
        representativeId: second.id,
      });
      const ended = await single('governance_representative.ended', second.id);
      expect(ended).toMatchObject({ actorId: o(1).id });
      expect(ended.metadata).toEqual({
        building: 'A',
        reason: 'ended',
        matterId: ending.matterId,
      });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the owners’ voice has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of GOVERNANCE_VOICE_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual(
        [...GOVERNANCE_VOICE_COVERAGE].sort(),
      );
    });
  });
});
