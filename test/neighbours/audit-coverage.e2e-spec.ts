import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  NEIGHBOURS_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * One scenario per neighbours catalog entry (ADR 0014, 0042): actor,
 * target, changes and metadata — ids, keys, statuses, counts and reason
 * codes; never a complaint's words, a notice's text, a post's words or
 * place, a note, a message, or who talks to whom.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — neighbours', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    read = auditReaders(h);
    await n.settings(s.c, s.manager, { maxOpenComplaints: 50 });
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) expect(JSON.stringify(row)).not.toContain(MARKER);
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

  describe('set-up', () => {
    it('neighbours.settings_changed — the limits by value', async () => {
      // The beforeAll's change is the row.
      const row = await single('neighbours.settings_changed', s.c.tenantId);
      expect(row).toMatchObject(by(s.manager, 'tenant'));
      expect(row.changes).toEqual({ maxOpenComplaints: { from: 5, to: 50 } });
    });

    it('neighbours.welcome_template_changed — on or off by value, each text only as changed', async () => {
      await n
        .http('put', '/neighbours/welcome-template', s.manager.token, {
          enabled: false,
          rulesEn: `${MARKER} rules`,
          officeHoursEn: `${MARKER} hours`,
          emergencyEn: `${MARKER} numbers`,
        })
        .expect(200);
      const row = await single(
        'neighbours.welcome_template_changed',
        s.c.tenantId,
      );
      expect(row).toMatchObject(by(s.manager, 'tenant'));
      expect(row.changes).toEqual({
        enabled: { from: true, to: false },
        rulesEn: { changed: true },
        officeHoursEn: { changed: true },
        emergencyEn: { changed: true },
      });
    });

    it('neighbour_complaint_category.created / updated — the key and state by value, the names only as changed', async () => {
      const created = (
        await n
          .http('post', '/neighbours/complaint-categories', s.manager.token, {
            key: 'renovation',
            nameAr: 'تجديد',
            nameEn: `${MARKER} renovation`,
          })
          .expect(201)
      ).body as { id: string };
      const row = await single(
        'neighbour_complaint_category.created',
        created.id,
      );
      expect(row).toMatchObject(by(s.manager, 'neighbour_complaint_category'));
      expect(row.changes).toEqual({
        key: { from: null, to: 'renovation' },
        nameAr: { changed: true },
        nameEn: { changed: true },
        active: { from: null, to: true },
      });
      await n
        .http(
          'patch',
          `/neighbours/complaint-categories/${created.id}`,
          s.manager.token,
          { nameEn: `${MARKER} works`, active: false },
        )
        .expect(200);
      const updated = await single(
        'neighbour_complaint_category.updated',
        created.id,
      );
      expect(updated.changes).toEqual({
        nameEn: { changed: true },
        active: { from: true, to: false },
      });
    });
  });

  describe('complaints', () => {
    it('neighbour_complaint.created — its number, category and target unit; the actor is the complainant', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code, {
        body: `${MARKER} the complaint`,
      });
      const row = await single('neighbour_complaint.created', id);
      expect(row).toMatchObject(by(s.alice, 'neighbour_complaint'));
      expect(row.metadata).toEqual({
        complaintNumber: expect.any(Number) as number,
        categoryKey: 'noise',
        targetUnitId: s.homeB.id,
        withUnit: true,
      });
    });

    it('neighbour_complaint.review_started / notice_sent / mediation_started / resolved — each move, the notice without its text', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      await n.onComplaint(s.handler, id, 'review').expect(204);
      const noticeId = (
        (
          await n
            .onComplaint(s.handler, id, 'notice', { body: `${MARKER} notice` })
            .expect(201)
        ).body as { id: string }
      ).id;
      await n.onComplaint(s.handler, id, 'mediation').expect(204);
      await n
        .onComplaint(s.handler, id, 'resolve', { reasonCode: 'mediated' })
        .expect(204);
      // Messages in every thread: none is audited.
      const moves = [
        ['neighbour_complaint.review_started', 'submitted', 'under_review'],
        ['neighbour_complaint.notice_sent', 'under_review', 'notice_sent'],
        ['neighbour_complaint.mediation_started', 'notice_sent', 'mediation'],
        ['neighbour_complaint.resolved', 'mediation', 'resolved'],
      ] as const;
      for (const [action, from, to] of moves) {
        const row = await single(action, id);
        expect(row).toMatchObject(by(s.handler, 'neighbour_complaint'));
        expect(row.metadata).toMatchObject({ from, to });
      }
      expect(
        (await single('neighbour_complaint.notice_sent', id)).metadata,
      ).toEqual({
        complaintNumber: expect.any(Number) as number,
        from: 'under_review',
        to: 'notice_sent',
        noticeId,
        recipientKind: 'household',
        recipients: 1,
      });
      expect(
        (await single('neighbour_complaint.resolved', id)).metadata,
      ).toMatchObject({ reasonCode: 'mediated' });
    });

    it('neighbour_complaint.dismissed — the reason code', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      await n
        .onComplaint(s.handler, id, 'dismiss', { reasonCode: 'unfounded' })
        .expect(204);
      const row = await single('neighbour_complaint.dismissed', id);
      expect(row.metadata).toEqual({
        complaintNumber: expect.any(Number) as number,
        from: 'submitted',
        to: 'dismissed',
        reasonCode: 'unfounded',
      });
    });

    it('neighbour_complaint.withdrawn — by its author', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      await n
        .http('post', `/neighbour-complaints/${id}/withdraw`, s.alice.token)
        .expect(204);
      const row = await single('neighbour_complaint.withdrawn', id);
      expect(row).toMatchObject(by(s.alice, 'neighbour_complaint'));
      expect(row.metadata).toMatchObject({ reasonCode: 'withdrawn' });
    });
  });

  describe('the boards', () => {
    it('neighbour_post.created / closed — the kind and a count of photos', async () => {
      const id = await n.post(s.alice, {
        body: `${MARKER} keys`,
        place: `${MARKER} gate`,
        photoFileIds: [await n.file(s.alice, 'neighbour_post_photo')],
      });
      const row = await single('neighbour_post.created', id);
      expect(row).toMatchObject(by(s.alice, 'neighbour_post'));
      expect(row.metadata).toEqual({
        kind: 'found',
        side: 'resident',
        photos: 1,
      });
      await n
        .http('post', `/neighbour-posts/${id}/close`, s.alice.token, {
          reasonCode: 'resolved',
        })
        .expect(204);
      expect((await single('neighbour_post.closed', id)).metadata).toEqual({
        kind: 'found',
        reasonCode: 'resolved',
      });
    });

    it('neighbour_post.removed — by the staff, the reason code', async () => {
      const id = await n.post(s.alice, {
        kind: 'lend',
        body: `${MARKER} ladder`,
      });
      await n
        .http('post', `/neighbours/posts/${id}/remove`, s.handler.token, {
          reasonCode: 'not_allowed',
        })
        .expect(204);
      const row = await single('neighbour_post.removed', id);
      expect(row).toMatchObject(by(s.handler, 'neighbour_post'));
      expect(row.metadata).toEqual({ kind: 'lend', reasonCode: 'not_allowed' });
    });

    it('neighbour_claim.created / withdrawn / declined — the post, never the note', async () => {
      const post = await n.post(s.alice);
      const first = await n.claim(s.bob, post, `${MARKER} it is mine`);
      expect(await single('neighbour_claim.created', first)).toMatchObject({
        ...by(s.bob, 'neighbour_claim'),
        metadata: { postId: post },
      });
      await n
        .http('post', `/neighbour-claims/${first}/withdraw`, s.bob.token)
        .expect(204);
      expect(
        (await single('neighbour_claim.withdrawn', first)).metadata,
      ).toEqual({ postId: post });
      const second = await n.claim(s.bob, post);
      await n
        .http('post', `/neighbours/claims/${second}/decline`, s.handler.token, {
          reasonCode: 'insufficient_proof',
        })
        .expect(204);
      expect(await single('neighbour_claim.declined', second)).toMatchObject({
        ...by(s.handler, 'neighbour_claim'),
        metadata: { postId: post, reasonCode: 'insufficient_proof' },
      });
    });

    it('neighbour_item.handed_over — to whom and on which claim', async () => {
      const post = await n.post(s.alice);
      const claim = await n.claim(s.bob, post);
      await n
        .http('post', `/neighbours/posts/${post}/handover`, s.handler.token, {
          claimId: claim,
        })
        .expect(204);
      const row = await single('neighbour_item.handed_over', post);
      expect(row).toMatchObject(by(s.handler, 'neighbour_post'));
      expect(row.metadata).toEqual({
        kind: 'found',
        reasonCode: 'handed_over',
        claimId: claim,
        recipientAccountId: s.bob.id,
      });
    });
  });

  describe('masked contact', () => {
    it('neighbour_conversation.started / names_revealed — the post; never the other side', async () => {
      const post = await n.post(s.alice);
      const res = await n.contact(s.bob, post, `${MARKER} hello`).expect(201);
      const id = (res.body as { id: string }).id;
      const started = await single('neighbour_conversation.started', id);
      expect(started).toMatchObject(by(s.bob, 'neighbour_conversation'));
      expect(started.metadata).toEqual({ postId: post, postKind: 'found' });
      expect(JSON.stringify(started)).not.toContain(s.alice.id);
      await n
        .http(
          'post',
          `/neighbour-conversations/${id}/messages`,
          s.alice.token,
          {
            body: `${MARKER} reply`,
          },
        )
        .expect(201);
      await n
        .http('post', `/neighbour-conversations/${id}/reveal`, s.bob.token)
        .expect(200);
      // One agreement is not an audit row; the second is.
      expect(await rows('neighbour_conversation.names_revealed', id)).toEqual(
        [],
      );
      await n
        .http('post', `/neighbour-conversations/${id}/reveal`, s.alice.token)
        .expect(200);
      const revealed = await single(
        'neighbour_conversation.names_revealed',
        id,
      );
      expect(revealed.metadata).toEqual({ postId: post });
      // Its messages are not audited at all.
      expect(
        (await read.tenant(s.c.tenantId, { targetId: id })).map(
          (r) => r.action,
        ),
      ).toEqual([
        'neighbour_conversation.started',
        'neighbour_conversation.names_revealed',
      ]);
    });

    it('neighbour_conversation.blocked / unblocked — a count, never who was blocked', async () => {
      const id = await n.conversation(s.bob, await n.post(s.alice));
      await n
        .http('post', `/neighbour-conversations/${id}/block`, s.bob.token)
        .expect(204);
      const blocked = await single('neighbour_conversation.blocked', id);
      expect(blocked).toMatchObject(by(s.bob, 'neighbour_conversation'));
      expect(blocked.metadata).toEqual({ conversationsClosed: 1 });
      expect(JSON.stringify(blocked)).not.toContain(s.alice.id);
      const [mine] = await n.list<{ id: string }>('/neighbour-blocks', s.bob);
      await n
        .http('delete', `/neighbour-blocks/${mine.id}`, s.bob.token)
        .expect(204);
      const unblocked = await single('neighbour_conversation.unblocked', id);
      expect(unblocked).toMatchObject(by(s.bob, 'neighbour_conversation'));
      expect(JSON.stringify(unblocked)).not.toContain(s.alice.id);
    });

    it('neighbour_conversation.reported, neighbour_report.conversation_read / closed — the reason and the outcome, never the note', async () => {
      const carol = await n.owner(s.c, (await n.unit(s.c, 'C')).id);
      const id = await n.conversation(carol, await n.post(s.alice));
      const reportId = (
        (
          await n
            .http(
              'post',
              `/neighbour-conversations/${id}/report`,
              carol.token,
              {
                reasonCode: 'spam',
                note: `${MARKER} look at this`,
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      const reported = await single('neighbour_conversation.reported', id);
      expect(reported).toMatchObject(by(carol, 'neighbour_conversation'));
      expect(reported.metadata).toEqual({ reportId, reasonCode: 'spam' });
      await n
        .http(
          'get',
          `/neighbours/reports/${reportId}/messages`,
          s.handler.token,
        )
        .expect(200);
      const readRow = await single(
        'neighbour_report.conversation_read',
        reportId,
      );
      expect(readRow).toMatchObject(by(s.handler, 'neighbour_report'));
      expect(readRow.metadata).toEqual({ conversationId: id });
      await n
        .http(
          'post',
          `/neighbours/reports/${reportId}/close`,
          s.handler.token,
          {
            reasonCode: 'no_action',
          },
        )
        .expect(204);
      const closed = await single('neighbour_report.closed', reportId);
      expect(closed.metadata).toEqual({
        conversationId: id,
        outcome: 'no_action',
        postRemoved: 0,
      });
    });
  });

  describe('the welcome', () => {
    it('neighbour_welcome.sent — the unit, the occupancy and the account', async () => {
      await n
        .http('put', '/neighbours/welcome-template', s.manager.token, {
          enabled: true,
        })
        .expect(200);
      const home = await n.unit(s.c, 'W');
      const primary = await n.owner(s.c, home.id);
      const [welcome] = await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.neighbourWelcome.findMany({
          where: { unitId: home.id },
        }),
      );
      const row = await single('neighbour_welcome.sent', welcome.id);
      // The actor is whoever moved the household in.
      expect(row).toMatchObject(by(s.manager, 'neighbour_welcome'));
      expect(row.metadata).toEqual({
        unitId: home.id,
        occupancyId: welcome.occupancyId,
        accountId: primary.id,
      });
    });
  });

  describe('what is not audited, on purpose', () => {
    it('a message in any thread of a complaint leaves no audit row: its words are not the trail’s', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      await n.noticed(s.handler, id);
      for (const path of ['messages', 'unit-messages', 'notes'])
        await n
          .http(
            'post',
            `/neighbours/complaints/${id}/${path}`,
            s.handler.token,
            {
              body: `${MARKER} staff words`,
            },
          )
          .expect(201);
      const found = await read.tenant(s.c.tenantId, { targetId: id });
      expect(found.map((r) => r.action).sort()).toEqual([
        'neighbour_complaint.created',
        'neighbour_complaint.notice_sent',
        'neighbour_complaint.review_started',
      ]);
      for (const row of found)
        expect(JSON.stringify(row)).not.toContain(MARKER);
    });

    it('reading a board, a post or one’s own conversation leaves none', async () => {
      const post = await n.post(s.alice);
      const before = (await read.tenant(s.c.tenantId)).length;
      await n.http('get', '/neighbour-posts', s.bob.token).expect(200);
      await n.http('get', `/neighbour-posts/${post}`, s.bob.token).expect(200);
      await n.http('get', '/neighbour-conversations', s.bob.token).expect(200);
      expect((await read.tenant(s.c.tenantId)).length).toBe(before);
    });
  });

  describe('catalog completeness', () => {
    it('every neighbours entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of NEIGHBOURS_COVERAGE) {
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
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...NEIGHBOURS_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(all.filter((k) => /^neighbours?[._]/.test(k)).sort()).toEqual(
        [...NEIGHBOURS_COVERAGE].sort(),
      );
    });
  });
});
