import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { GOVERNANCE_VOICE_COVERAGE } from '../setup/audit-coverage-split';
import { boardAppealHelpers } from '../setup/board-appeals';
import { today } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
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

  describe('agenda proposals', () => {
    it('proposed, decided, withdrawn, its words cleared: codes only', async () => {
      const propose = async (as: { token: string }) =>
        (
          (
            await a
              .http('post', '/governance/agenda-proposals', as.token, {
                title: `${MARKER} title`,
                body: `${MARKER} body`,
              })
              .expect(201)
          ).body as { id: string }
        ).id;
      const first = await propose(o(3));
      const proposed = await single(
        'governance_agenda_proposal.proposed',
        first,
      );
      expect(proposed).toMatchObject({
        actorId: o(3).id,
        targetType: 'governance_agenda_proposal',
        changes: { title: { changed: true }, body: { changed: true } },
      });
      await a
        .http('post', `/board/agenda-proposals/${first}/decide`, o(0).token, {
          outcome: 'declined',
          reasonCode: 'duplicate',
          note: `${MARKER} note`,
        })
        .expect(200);
      expect(
        (await single('governance_agenda_proposal.decided', first)).metadata,
      ).toEqual({ outcome: 'declined', reasonCode: 'duplicate', note: true });
      const second = await propose(o(3));
      await a
        .http(
          'post',
          `/governance/agenda-proposals/${second}/withdraw`,
          o(3).token,
        )
        .expect(200);
      expect(
        await single('governance_agenda_proposal.withdrawn', second),
      ).toMatchObject({ actorId: o(3).id });
      // The proposer's erasure: each proposal's words, once. A co-owner of
      // o(5)'s unit, not its primary, so their account may go.
      const leaver = await a.owner(s.c, o(5).unitId);
      const third = await propose(leaver);
      await eraseNow(h, s.c, leaver.id);
      await single('governance_agenda_proposal.text_cleared', third);
    });
  });

  describe('objections', () => {
    it('lodged without the unit, answered with a count, the grounds cleared at the erasure', async () => {
      const publicationId = (
        (
          await a
            .http('post', '/governance/publications', o(0).token, {
              kind: 'decision',
              decidedOn: today(),
              titleEn: 'A decision',
              bodyEn: 'Its words.',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      // A co-owner of o(4)'s unit, not its primary: erased below.
      const objector = await a.owner(s.c, o(4).unitId);
      const objected = (
        (
          await a
            .http(
              'post',
              `/governance/publications/${publicationId}/objections`,
              objector.token,
              { unitId: o(4).unitId, grounds: `${MARKER} grounds` },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      const lodged = await single('governance_objection.lodged', objected);
      expect(lodged).toMatchObject({
        actorId: objector.id,
        targetType: 'governance_objection',
        changes: {
          publicationId: { to: publicationId },
          grounds: { changed: true },
        },
      });
      expect(JSON.stringify(lodged)).not.toContain(o(4).unitId);
      await a
        .http(
          'post',
          `/board/publications/${publicationId}/objections/answer`,
          o(1).token,
          { body: `${MARKER} answer` },
        )
        .expect(201);
      expect(
        (await single('governance_objection.answered', publicationId)).metadata,
      ).toEqual({ objections: 1 });
      await eraseNow(h, s.c, objector.id);
      await single('governance_objection.grounds_cleared', objected);
    });
  });

  describe('the follow-up', () => {
    it('a step recorded: its status, a note as a boolean', async () => {
      const r = await a.raise(s.manager);
      const m = await a.motion(o(0), r.id);
      await a.vote(o(0), m.id, 'for').expect(201);
      await a.vote(o(1), m.id, 'for').expect(201);
      await a
        .http(
          'post',
          `/staff/governance/approvals/${r.id}/progress`,
          s.manager.token,
          {
            status: 'in_progress',
            note: `${MARKER} quotes`,
          },
        )
        .expect(200);
      const step = await single('governance_approval_progress.recorded', r.id);
      expect(step).toMatchObject({
        actorId: s.manager.id,
        targetType: 'governance_approval',
      });
      expect(step.metadata).toEqual({ status: 'in_progress', note: true });
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
