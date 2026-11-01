import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { BOARD_WORK_COVERAGE } from '../setup/audit-coverage-split';
import { day, today } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { financeHelpers } from '../setup/finance';
import { governanceHelpers } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-board-work-secret';

/**
 * One scenario per entry of the board's work (ADR 0014, 0075): actor,
 * target and what changed — ids, codes, dates and counts; never a
 * meeting's words, an action's, a minute's or a handover's notes.
 */
const covered = new Set<string>();

describe('Audit coverage — the board’s work', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    read = auditReaders(h);
    s = await g.setUp(4);
    await g.appoint(s.manager, s.owners.slice(0, 3));
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  describe('ownership shares', () => {
    it('governance_unit_share.changed — the unit, the share before and after', async () => {
      const unitId = s.owners[3].unitId;
      await g
        .http('put', '/staff/governance/unit-shares', s.manager.token, {
          shares: [{ unitId, share: '12.5' }],
        })
        .expect(200);
      expect(
        await single('governance_unit_share.changed', unitId),
      ).toMatchObject({
        actorId: s.manager.id,
        targetType: 'unit',
        changes: { share: { from: null, to: '12.5000' } },
      });
    });
  });

  describe('the rules', () => {
    it('governance_rules.changed — on the compound, the rules by value', async () => {
      await g
        .http('patch', '/staff/governance/rules', s.manager.token, {
          candidacyNotStaff: true,
        })
        .expect(200);
      expect(
        await single('governance_rules.changed', s.c.tenantId),
      ).toMatchObject({
        actorId: s.manager.id,
        targetType: 'tenant',
        changes: { candidacyNotStaff: { from: false, to: true } },
      });
    });
  });

  describe('meetings', () => {
    const o = (i: number) => s.owners[i];
    const post = (path: string, body: object, as = o(0)) =>
      g.http('post', path, as.token, body);
    const schedule = async () =>
      (
        (
          await post('/board/meetings', {
            kind: 'regular',
            title: `${MARKER} title`,
            location: `${MARKER} place`,
            scheduledAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
          }).expect(201)
        ).body as { id: string }
      ).id;

    it('board_meeting.scheduled, .changed, .held, .cancelled and .minutes_linked — terms by value, the words as changed', async () => {
      const id = await schedule();
      expect(await single('board_meeting.scheduled', id)).toMatchObject({
        actorId: o(0).id,
        targetType: 'board_meeting',
        changes: {
          kind: { from: null, to: 'regular' },
          agenda: { from: null, to: 0 },
          title: { changed: true },
          location: { changed: true },
        },
        metadata: { side: 'board' },
      });
      await g
        .http('patch', `/board/meetings/${id}`, o(1).token, {
          kind: 'extraordinary',
          title: `${MARKER} new`,
        })
        .expect(200);
      expect((await single('board_meeting.changed', id)).changes).toEqual({
        kind: { from: 'regular', to: 'extraordinary' },
        title: { changed: true },
      });
      await post(`/board/meetings/${id}/hold`, { presentMemberIds: [] }).expect(
        200,
      );
      expect((await single('board_meeting.held', id)).metadata).toEqual({
        seated: 3,
        present: 0,
        quorate: false,
        side: 'board',
      });
      const publicationId = (
        (
          await post('/governance/publications', {
            kind: 'minutes',
            decidedOn: today(),
            titleEn: `${MARKER} minutes`,
            bodyEn: MARKER,
          }).expect(201)
        ).body as { id: string }
      ).id;
      await post(`/board/meetings/${id}/minutes`, { publicationId }).expect(
        200,
      );
      expect(
        (await single('board_meeting.minutes_linked', id)).metadata,
      ).toEqual({ publicationId });
      const other = await schedule();
      await post(`/board/meetings/${other}/cancel`, {
        reasonCode: 'superseded',
      }).expect(200);
      expect((await single('board_meeting.cancelled', other)).metadata).toEqual(
        { reasonCode: 'superseded', side: 'board' },
      );
    });

    it('board_meeting_action.created, .done and .cancelled — owner, day and codes; never the words', async () => {
      const id = await schedule();
      await post(`/board/meetings/${id}/hold`, { presentMemberIds: [] }).expect(
        200,
      );
      const add = async () =>
        (
          (
            await post(`/board/meetings/${id}/actions`, {
              title: `${MARKER} item`,
              ownerAccountId: o(1).id,
              dueOn: day(5),
            }).expect(201)
          ).body as { id: string }
        ).id;
      const first = await add();
      expect(await single('board_meeting_action.created', first)).toMatchObject(
        {
          changes: {
            meetingId: { from: null, to: id },
            ownerId: { from: null, to: o(1).id },
            dueOn: { from: null, to: day(5) },
            title: { changed: true },
          },
        },
      );
      await post(
        `/board/meeting-actions/${first}/done`,
        { note: `${MARKER} note` },
        o(1),
      ).expect(200);
      expect(
        (await single('board_meeting_action.done', first)).metadata,
      ).toEqual({ note: true, byOwner: true });
      const second = await add();
      await post(`/board/meeting-actions/${second}/cancel`, {
        reasonCode: 'other',
      }).expect(200);
      expect(
        (await single('board_meeting_action.cancelled', second)).metadata,
      ).toEqual({ reasonCode: 'other' });
    });
  });

  describe('handovers', () => {
    it('board_handover_pack.generated — the term and the one before, when the board started to sit', async () => {
      const pack = (
        await g.http('get', '/board/handover-pack', s.manager.token).expect(200)
      ).body as { id: string; termId: string };
      expect(
        (await single('board_handover_pack.generated', pack.id)).metadata,
      ).toEqual({ termId: pack.termId, previousTermId: null });
    });

    it('manager_handover.drafted, .delivered and .notes_cleared — booleans, never the notes', async () => {
      const admin = await financeHelpers(h).platformAdmin();
      const p = g.x.person('mgr-audit');
      const added = (
        await g
          .http(
            'post',
            `/platform/tenants/${s.c.tenantId}/managers`,
            admin.token,
            p,
          )
          .expect(201)
      ).body as { id: string };
      const leaving = await g.who(s.c, added.id, 'manager');
      const draft = (
        await g
          .http('put', '/staff/governance/handover', leaving.token, {
            notes: `${MARKER} notes`,
          })
          .expect(200)
      ).body as { id: string };
      expect(
        (await single('manager_handover.drafted', draft.id)).metadata,
      ).toEqual({ notes: true, created: true });
      await g
        .http('post', '/staff/governance/handover/deliver', leaving.token)
        .expect(200);
      expect(
        (await single('manager_handover.delivered', draft.id)).metadata,
      ).toEqual({ notes: true });
      await g
        .http(
          'patch',
          `/platform/tenants/${s.c.tenantId}/managers/${leaving.id}/status`,
          admin.token,
          { status: 'inactive' },
        )
        .expect(200);
      await eraseNow(h, s.c, leaving.id);
      expect(
        await single('manager_handover.notes_cleared', draft.id),
      ).toMatchObject({ targetType: 'manager_handover' });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the board’s work has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of BOARD_WORK_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...BOARD_WORK_COVERAGE].sort());
    });
  });
});
