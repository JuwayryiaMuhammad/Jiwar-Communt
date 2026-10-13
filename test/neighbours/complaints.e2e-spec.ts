import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: filing a complaint against a unit, who sees it (its author
 * alone on the resident side, the staff always with the author's name),
 * its status and its history, and what only the staff see: a unit's past
 * and an author's habits.
 */
describe('Neighbour complaints — filing, reading and moving', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let audit: ReturnType<typeof auditReaders>;
  let family: Who;
  let carol: Who;
  let homeC: { id: string; code: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    audit = auditReaders(h);
    family = await n.family(s.c, s.homeA.id, s.alice);
    homeC = await n.unit(s.c, 'C');
    carol = await n.owner(s.c, homeC.id);
    // Not this suite's subject: the limit has its own (complaint-limit).
    await n.settings(s.c, s.manager, { maxOpenComplaints: 50 });
  }, 180_000);

  afterAll(() => h.close());

  type Body = Record<string, unknown> & {
    id: string;
    number: string;
    status: string;
  };
  const mine = (who: Who, id: string) =>
    n.http('get', `/neighbour-complaints/${id}`, who.token);
  const forStaff = (id: string, who: Who = s.handler) =>
    n.http('get', `/neighbours/complaints/${id}`, who.token);
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;

  describe('filing', () => {
    it('a resident complains about a unit by its code; it starts submitted, numbered from 1', async () => {
      const first = await n.complain(s.c, s.alice, `  ${s.homeB.code}  `, {
        body: '  Loud music every night  ',
      });
      expect(first).toEqual({
        id: expect.any(String) as string,
        number: 'NC-000001',
        status: 'submitted',
        createdAt: expect.any(String) as string,
      });
      expect((await n.complain(s.c, carol, s.homeB.code)).number).toBe(
        'NC-000002',
      );
      const res = await mine(s.alice, first.id).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        id: first.id,
        number: 'NC-000001',
        status: 'submitted',
        open: true,
        category: { key: 'noise', nameEn: 'Noise' },
        targetUnitCode: s.homeB.code,
        // Her only unit: named without her naming it.
        unitCode: s.homeA.code,
        closeReason: null,
        closedAt: null,
        history: [{ status: 'submitted', reasonCode: null }],
      });
      // Its words are its first message, trimmed.
      const thread = await n.list<{ body: string; senderSide: string }>(
        `/neighbour-complaints/${first.id}/messages`,
        s.alice,
      );
      expect(thread).toMatchObject([
        { body: 'Loud music every night', senderSide: 'resident' },
      ]);
    });

    it('the author’s view names nobody: not who lives there, not who handles it', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      const text = JSON.stringify((await mine(s.alice, id).expect(200)).body);
      for (const secret of [s.bob.id, s.homeB.id, s.handler.id, s.manager.id])
        expect(text).not.toContain(secret);
      for (const key of [
        'author',
        'targetUnit',
        'againstUnit',
        'unitHistory',
        'authorPattern',
        'notice',
      ])
        expect((await mine(s.alice, id)).body).not.toHaveProperty(key);
    });

    it('never about their own unit: every unit they have a place in is refused the same way', async () => {
      const own = await n.complainRaw(s.c, s.alice, s.homeA.code).expect(400);
      expect(fields(own)).toEqual([
        { field: 'targetUnitCode', code: 'OWN_UNIT' },
      ]);
      // A family member of that home, too.
      expect(
        fields(await n.complainRaw(s.c, family, s.homeA.code).expect(400)),
      ).toEqual([{ field: 'targetUnitCode', code: 'OWN_UNIT' }]);
      // And a landlord about the unit they rent out.
      const rented = await n.unit(s.c, 'D');
      const landlord = await n.landlord(s.c, rented.id);
      await n.tenant(s.c, rented.id);
      expect(
        fields(await n.complainRaw(s.c, landlord, rented.code).expect(400)),
      ).toEqual([{ field: 'targetUnitCode', code: 'OWN_UNIT' }]);
    });

    it('an empty unit and an occupied one answer alike: the author learns nothing of who lives there', async () => {
      const empty = await n.unit(s.c, 'E');
      const about = async (code: string) => {
        const created = await n.complain(s.c, carol, code);
        const body = (await mine(carol, created.id).expect(200)).body as Body;
        return Object.keys({ ...created, ...body }).sort();
      };
      expect(await about(empty.code)).toEqual(await about(s.homeB.code));
    });

    it('an unknown code, another compound’s code, a retired or foreign category and someone else’s unit are refused', async () => {
      const other = await n.setUp();
      for (const code of ['NO-SUCH-UNIT', other.homeA.code])
        expect(
          fields(await n.complainRaw(s.c, s.alice, code).expect(400)),
        ).toEqual([{ field: 'targetUnitCode', code: 'UNIT_CODE_UNKNOWN' }]);
      expect(
        fields(
          await n
            .complainRaw(s.c, s.alice, s.homeB.code, {
              categoryId: await n.categoryId(other.c),
            })
            .expect(400),
        ),
      ).toEqual([{ field: 'categoryId', code: 'CATEGORY_NOT_AVAILABLE' }]);
      const notHers = await n
        .complainRaw(s.c, s.alice, s.homeB.code, { unitId: homeC.id })
        .expect(404);
      expect(notHers.body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    });

    it('a family member files their own; the staff and the manager do not file at all', async () => {
      const created = await n.complain(s.c, family, s.homeB.code);
      expect(created.status).toBe('submitted');
      for (const who of [s.handler, s.manager])
        await n.complainRaw(s.c, who, s.homeB.code).expect(403);
    });

    it('the same Idempotency-Key files once', async () => {
      const key = { 'Idempotency-Key': `complaint-${Date.now()}` };
      const first = await n
        .complainRaw(s.c, carol, s.homeA.code, {}, key)
        .expect(201);
      const again = await n
        .complainRaw(s.c, carol, s.homeA.code, {}, key)
        .expect(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
    });

    it('is audited by codes and ids: never its words', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code, {
        body: 'AUDIT-FREE-TEXT in the complaint',
      });
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_complaint.created',
        targetId: id,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({
        complaintNumber: expect.any(Number) as number,
        categoryKey: 'noise',
        targetUnitId: s.homeB.id,
        withUnit: true,
      });
      expect(JSON.stringify(rows[0])).not.toContain('AUDIT-FREE-TEXT');
    });
  });

  describe('who sees it', () => {
    let id: string;
    beforeAll(async () => {
      id = (await n.complain(s.c, s.alice, s.homeB.code)).id;
    });

    it('its author alone on the resident side: not the family, not the unit complained about, not a neighbour', async () => {
      await mine(s.alice, id).expect(200);
      for (const who of [family, s.bob, carol]) {
        const res = await mine(who, id).expect(404);
        expect(res.body).toMatchObject({
          code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
        });
        await n
          .http('get', `/neighbour-complaints/${id}/messages`, who.token)
          .expect(404);
        await n
          .http('post', `/neighbour-complaints/${id}/messages`, who.token, {
            body: 'Me too',
          })
          .expect(404);
        await n
          .http('post', `/neighbour-complaints/${id}/withdraw`, who.token)
          .expect(404);
        expect(
          (await n.list<Body>('/neighbour-complaints', who)).map((c) => c.id),
        ).not.toContain(id);
      }
    });

    it('the primary does not see a family member’s complaint, nor the member the primary’s', async () => {
      const theirs = (await n.complain(s.c, family, s.homeB.code)).id;
      await mine(s.alice, theirs).expect(404);
      await mine(family, id).expect(404);
      expect(
        (await n.list<Body>('/neighbour-complaints', family)).map((c) => c.id),
      ).toContain(theirs);
    });

    it('the staff always see who complained, about which unit, and what there is against it', async () => {
      for (const who of [s.handler, s.manager]) {
        const body = (await forStaff(id, who).expect(200)).body as Body;
        expect(body).toMatchObject({
          id,
          author: { id: s.alice.id, fullName: expect.any(String) as string },
          authorUnit: { id: s.homeA.id, code: s.homeA.code, building: 'A' },
          targetUnit: { id: s.homeB.id, code: s.homeB.code, building: 'B' },
          notice: null,
        });
        expect((body.history as { actor: { id: string } }[])[0].actor.id).toBe(
          s.alice.id,
        );
      }
    });

    it('a resident has no way into the staff’s side', async () => {
      for (const path of [
        '/neighbours/complaints',
        `/neighbours/complaints/${id}`,
        `/neighbours/complaints/${id}/messages`,
        `/neighbours/complaints/${id}/unit-messages`,
        `/neighbours/complaints/${id}/notes`,
        `/neighbours/units/${s.homeB.id}/complaint-history`,
      ])
        for (const who of [s.alice, s.bob, family])
          await n.http('get', path, who.token).expect(403);
    });
  });

  describe('status', () => {
    const act = (id: string, action: string, body?: object, who = s.handler) =>
      n.onComplaint(who, id, action, body);
    const status = async (id: string) =>
      ((await forStaff(id).expect(200)).body as Body).status;

    it('submitted → under review → mediation → resolved, each step in its history and told to the author', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      await act(id, 'review').expect(204);
      expect(await status(id)).toBe('under_review');
      await act(id, 'mediation').expect(204);
      await act(id, 'resolve', { reasonCode: 'mediated' }).expect(204);
      const body = (await mine(s.alice, id).expect(200)).body as Body;
      expect(body).toMatchObject({
        status: 'resolved',
        open: false,
        closeReason: 'mediated',
      });
      expect(
        (body.history as { status: string; reasonCode: string | null }[]).map(
          (x) => [x.status, x.reasonCode],
        ),
      ).toEqual([
        ['submitted', null],
        ['under_review', null],
        ['mediation', null],
        ['resolved', 'mediated'],
      ]);
      // The author's view of the history names no staff member.
      expect(JSON.stringify(body.history)).not.toContain(s.handler.id);
      const kinds = (await n.notifications(s.c, s.alice.id))
        .filter((x) => x.targetId === id)
        .map((x) => x.kind);
      expect(kinds).toEqual([
        'neighbour_complaint.under_review',
        'neighbour_complaint.in_mediation',
        'neighbour_complaint.resolved',
      ]);
      for (const action of [
        'neighbour_complaint.review_started',
        'neighbour_complaint.mediation_started',
        'neighbour_complaint.resolved',
      ])
        expect(
          await audit.tenant(s.c.tenantId, { action, targetId: id }),
        ).toHaveLength(1);
    });

    it('the staff dismiss as unfounded, with a code from the list and nothing else', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      expect((await act(id, 'dismiss', {}).expect(400)).body).toMatchObject({
        fields: [{ field: 'reasonCode' }],
      });
      const wrong = await act(id, 'dismiss', { reasonCode: 'complied' }).expect(
        400,
      );
      expect(fields(wrong)).toEqual([
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: {
            allowed: [
              'unfounded',
              'duplicate',
              'insufficient_evidence',
              'out_of_scope',
            ],
          },
        },
      ]);
      // `withdrawn` is the author's alone.
      await act(id, 'dismiss', { reasonCode: 'withdrawn' }).expect(400);
      await act(id, 'dismiss', { reasonCode: 'unfounded' }).expect(204);
      expect((await mine(s.alice, id).expect(200)).body).toMatchObject({
        status: 'dismissed',
        closeReason: 'unfounded',
      });
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_complaint.dismissed',
        targetId: id,
      });
      expect(rows[0].metadata).toMatchObject({
        from: 'submitted',
        to: 'dismissed',
        reasonCode: 'unfounded',
      });
    });

    it('a move the status does not take is a 409 carrying the status found', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      for (const [action, body] of [
        ['mediation', undefined],
        ['resolve', { reasonCode: 'complied' }],
        ['notice', { body: 'Please stop.' }],
      ] as const)
        expect((await act(id, action, body).expect(409)).body).toMatchObject({
          code: 'NEIGHBOUR_COMPLAINT_INVALID_TRANSITION',
          params: { status: 'submitted' },
        });
      await act(id, 'review').expect(204);
      await act(id, 'review').expect(409);
      await act(id, 'resolve', { reasonCode: 'no_further_action' }).expect(204);
      for (const action of ['review', 'mediation'])
        expect((await act(id, action).expect(409)).body).toMatchObject({
          params: { status: 'resolved' },
        });
      await n
        .http('post', `/neighbour-complaints/${id}/messages`, s.alice.token, {
          body: 'One more thing',
        })
        .expect(409);
    });

    it('the author withdraws before the unit is told, and never after', async () => {
      const early = (await n.complain(s.c, s.alice, s.homeB.code)).id;
      await n
        .http('post', `/neighbour-complaints/${early}/withdraw`, s.alice.token)
        .expect(204);
      expect((await mine(s.alice, early).expect(200)).body).toMatchObject({
        status: 'dismissed',
        closeReason: 'withdrawn',
      });
      // The staff are told; the author is not told of their own act.
      expect(
        (await n.notifications(s.c, s.handler.id)).filter(
          (x) => x.targetId === early,
        ),
      ).toMatchObject([
        { kind: 'neighbour_complaint.submitted' },
        { kind: 'neighbour_complaint.withdrawn' },
      ]);
      expect(
        (await n.notifications(s.c, s.alice.id)).filter(
          (x) => x.targetId === early,
        ),
      ).toEqual([]);

      const late = (await n.complain(s.c, s.alice, s.homeB.code)).id;
      await n.noticed(s.handler, late);
      expect(
        (
          await n
            .http(
              'post',
              `/neighbour-complaints/${late}/withdraw`,
              s.alice.token,
            )
            .expect(409)
        ).body,
      ).toMatchObject({
        code: 'NEIGHBOUR_COMPLAINT_INVALID_TRANSITION',
        params: { status: 'notice_sent' },
      });
    });
  });

  describe('the staff inbox, a unit’s history and an author’s habits', () => {
    let c2: NeighboursSetUp;
    let ids: string[];

    beforeAll(async () => {
      c2 = await n.setUp();
      ids = [];
      for (let i = 0; i < 3; i++)
        ids.push((await n.complain(c2.c, c2.alice, c2.homeB.code)).id);
      await n
        .onComplaint(c2.handler, ids[0], 'dismiss', { reasonCode: 'unfounded' })
        .expect(204);
      await n.onComplaint(c2.handler, ids[1], 'review').expect(204);
      await n
        .onComplaint(c2.handler, ids[1], 'resolve', { reasonCode: 'complied' })
        .expect(204);
    });

    const inbox = (query = '') =>
      n.list<Body>(`/neighbours/complaints${query}`, c2.handler);

    it('lists every complaint, the most recently active first, with the count against each unit', async () => {
      const all = await inbox();
      expect(all.map((c) => c.id)).toEqual([ids[1], ids[0], ids[2]]);
      for (const c of all) expect(c.againstUnit).toEqual({ total: 3, open: 1 });
    });

    it('filters by status, by open, by unit, by author and by category', async () => {
      expect((await inbox('?open=true')).map((c) => c.id)).toEqual([ids[2]]);
      expect((await inbox('?open=false')).map((c) => c.id)).toEqual([
        ids[1],
        ids[0],
      ]);
      expect((await inbox('?status=dismissed')).map((c) => c.id)).toEqual([
        ids[0],
      ]);
      expect(await inbox(`?targetUnitId=${c2.homeA.id}`)).toEqual([]);
      expect(await inbox(`?targetUnitId=${c2.homeB.id}`)).toHaveLength(3);
      expect(await inbox(`?authorId=${c2.bob.id}`)).toEqual([]);
      expect(await inbox(`?authorId=${c2.alice.id}`)).toHaveLength(3);
      expect(
        await inbox(`?categoryId=${await n.categoryId(c2.c, 'pets')}`),
      ).toEqual([]);
    });

    it('a unit’s history and its author’s habits are on the staff’s detail', async () => {
      const body = (
        await n
          .http('get', `/neighbours/complaints/${ids[2]}`, c2.handler.token)
          .expect(200)
      ).body as Body;
      expect(body.unitHistory).toEqual({
        total: 3,
        open: 1,
        resolved: 1,
        dismissed: 1,
        unfounded: 1,
      });
      expect(body.authorPattern).toEqual({
        total: 3,
        open: 1,
        dismissedUnfounded: 1,
        againstSameUnit: 3,
      });
      const history = await n
        .http(
          'get',
          `/neighbours/units/${c2.homeB.id}/complaint-history`,
          c2.handler.token,
        )
        .expect(200);
      expect(history.body).toEqual({
        unit: { id: c2.homeB.id, code: c2.homeB.code, building: 'B' },
        history: { total: 3, open: 1, resolved: 1, dismissed: 1, unfounded: 1 },
      });
    });

    it('none of it reaches a resident: not the author, not the unit', async () => {
      for (const who of [c2.alice, c2.bob]) {
        const lists = JSON.stringify(
          await n.list('/neighbour-complaints', who),
        );
        for (const word of ['againstUnit', 'unitHistory', 'authorPattern'])
          expect(lists).not.toContain(word);
      }
      const own = JSON.stringify(
        (
          await n
            .http('get', `/neighbour-complaints/${ids[2]}`, c2.alice.token)
            .expect(200)
        ).body,
      );
      for (const word of ['againstUnit', 'unitHistory', 'authorPattern'])
        expect(own).not.toContain(word);
    });

    it('another compound’s complaint and unit are not found', async () => {
      for (const path of [
        `/neighbours/complaints/${ids[0]}`,
        `/neighbours/complaints/${ids[0]}/messages`,
      ])
        expect(
          (await n.http('get', path, s.handler.token).expect(404)).body,
        ).toMatchObject({ code: 'NEIGHBOUR_COMPLAINT_NOT_FOUND' });
      expect(
        (
          await n
            .http(
              'get',
              `/neighbours/units/${c2.homeB.id}/complaint-history`,
              s.handler.token,
            )
            .expect(404)
        ).body,
      ).toMatchObject({ code: 'UNIT_NOT_FOUND' });
    });
  });
});
