import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  asSuperuser,
  partnersHelpers,
  shiftWindow,
  type PartnersSetUp,
  type RequestBody,
  type Who,
} from '../setup/partners';

/**
 * Ratings and complaints (ADR 0060): a request done is rated once, a
 * partner's average shows once three have rated it, and a complaint is a
 * management request on the system topic, decided once by the management.
 */
describe('Partners: ratings and complaints (ADR 0060)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;
  let partnerId: string;
  let token: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
    partnerId = await p.partner(s.c, s.keeper);
    token = await p.deskLink(s.keeper, partnerId);
    await p.consent(s.alice);
    await p.consent(s.bob);
    await p
      .http('patch', '/staff/partner-settings', s.manager.token, {
        maxLiveRequests: 20,
      })
      .expect(200);
  }, 180_000);

  afterAll(() => h.close());

  const err = (res: { body: unknown }) =>
    res.body as { code: string; params?: Record<string, unknown> };
  const homeOf = (who: Who) => (who === s.alice ? s.homeA.id : s.homeB.id);

  /** A request done: accepted on the desk, its window started, said done. */
  async function done(who: Who = s.alice, partner = partnerId) {
    const id = (await p.request(who, homeOf(who), partner)).id;
    await p.desk(token, `/requests/${id}/accept`).expect(200);
    await shiftWindow(id, 'started');
    await p.http('post', `/partner-requests/${id}/done`, who.token).expect(200);
    return id;
  }
  const rate = (who: Who, id: string, stars: number, comment?: string) =>
    p.http('post', `/partner-requests/${id}/rating`, who.token, {
      stars,
      ...(comment ? { comment } : {}),
    });

  describe('ratings', () => {
    it('a request done is rated once, by its requester', async () => {
      const id = await done();
      const res = await rate(s.alice, id, 4, '  Quick and clean  ').expect(200);
      expect((res.body as RequestBody).rating).toMatchObject({
        stars: 4,
        comment: 'Quick and clean',
      });
      const again = await rate(s.alice, id, 5);
      expect([again.status, err(again).code]).toEqual([
        409,
        'PARTNER_REQUEST_ALREADY_RATED',
      ]);
      const other = await rate(s.bob, id, 1);
      expect([other.status, err(other).code]).toEqual([
        404,
        'PARTNER_REQUEST_NOT_FOUND',
      ]);
    });

    it('only a request done; within the compound’s rating days', async () => {
      const pending = (await p.request(s.alice, s.homeA.id, partnerId)).id;
      const res = await rate(s.alice, pending, 3);
      expect(err(res)).toMatchObject({
        code: 'PARTNER_REQUEST_NOT_CLOSED',
        params: { status: 'pending' },
      });
      const old = await done();
      await asSuperuser(
        `UPDATE partner_requests SET closed_at = closed_at - interval '15 days' WHERE id = $1`,
        [old],
      );
      const late = await rate(s.alice, old, 3);
      expect(err(late)).toMatchObject({
        code: 'PARTNER_REQUEST_WINDOW_CLOSED',
        params: { days: 14 },
      });
    });

    it('two ratings at once: one stands', async () => {
      const id = await done();
      const [x, y] = await Promise.all([
        rate(s.alice, id, 2),
        rate(s.alice, id, 5),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
    });

    it('residents see an average once three rated; the staff see every rating, never who rated', async () => {
      const fresh = await p.partner(s.c, s.keeper);
      token = await p.deskLink(s.keeper, fresh);
      const shown = async () =>
        (
          (await p.get(s.alice, fresh).expect(200)).body as {
            rating: { average: string; count: number } | null;
          }
        ).rating;
      await rate(s.alice, await done(s.alice, fresh), 5).expect(200);
      await rate(s.bob, await done(s.bob, fresh), 4).expect(200);
      expect(await shown()).toBeNull();
      await rate(s.alice, await done(s.alice, fresh), 3).expect(200);
      expect(await shown()).toEqual({ average: '4.0', count: 3 });
      const staff = (
        await p
          .http(
            'get',
            `/staff/partner-ratings?partnerId=${fresh}`,
            s.keeper.token,
          )
          .expect(200)
      ).body as { data: Record<string, unknown>[] };
      expect(staff.data).toHaveLength(3);
      for (const row of staff.data) {
        expect(row.requestNumber).toMatch(/^SR-/);
        expect(JSON.stringify(row)).not.toContain(s.alice.id);
        expect(JSON.stringify(row)).not.toContain(s.bob.id);
      }
      token = await p.deskLink(s.keeper, partnerId);
    });
  });

  describe('complaints', () => {
    const complain = (id: string, over: Record<string, unknown> = {}) =>
      p.http('post', `/partner-requests/${id}/complaint`, s.alice.token, {
        reason: 'late',
        compensationAsk: 'none',
        message: 'They came two hours late.',
        ...over,
      });

    it('is a management request on the system topic, the requester its author, the words its first message', async () => {
      const id = await done();
      const res = await complain(id, {
        compensationAsk: 'refund',
        requestedAmount: '150.5',
      }).expect(201);
      const body = res.body as {
        managementRequestId: string;
        managementRequestNumber: string;
        requestedAmount: string;
        outcome: string | null;
      };
      expect(body).toMatchObject({
        requestedAmount: '150.50',
        outcome: null,
      });
      expect(body.managementRequestNumber).toMatch(/^MR-\d{6}$/);
      const mr = await p.inTx(s.c, (tx) =>
        tx.managementRequest.findUniqueOrThrow({
          where: { id: body.managementRequestId },
          include: { topic: true },
        }),
      );
      expect(mr).toMatchObject({ authorId: s.alice.id, unitId: s.homeA.id });
      expect(mr.topic.key).toBe('partner_service');
      // The author reads it as any of their management requests.
      await p
        .http(
          'get',
          `/management-requests/${body.managementRequestId}`,
          s.alice.token,
        )
        .expect(200);
      const mine = (
        await p
          .http('get', `/partner-requests/${id}`, s.alice.token)
          .expect(200)
      ).body as RequestBody;
      expect(mine.complaint).toMatchObject({
        managementRequestId: body.managementRequestId,
        reason: 'late',
      });
    });

    it('the system topic is never offered to residents nor picked by them', async () => {
      const offered = (
        (
          await p
            .http('get', '/management-request-topics', s.alice.token)
            .expect(200)
        ).body as { data: { id: string; key: string }[] }
      ).data;
      expect(offered.map((t) => t.key)).not.toContain('partner_service');
      const topic = await p.inTx(s.c, (tx) =>
        tx.managementRequestTopic.findFirstOrThrow({
          where: { key: 'partner_service' },
        }),
      );
      const res = await p.http('post', '/management-requests', s.alice.token, {
        type: 'general',
        topicId: topic.id,
        body: 'About a partner',
      });
      expect(res.status).toBe(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        expect.objectContaining({
          field: 'topicId',
          code: 'TOPIC_NOT_AVAILABLE',
        }),
      ]);
    });

    it('once per request; only about a request done, not come, lapsed or cancelled by the partner; an amount only with a refund or damages', async () => {
      const id = await done();
      await complain(id).expect(201);
      const twice = await complain(id);
      expect(err(twice).code).toBe('PARTNER_COMPLAINT_EXISTS');
      const mine = (await p.request(s.alice, s.homeA.id, partnerId)).id;
      await p
        .http('post', `/partner-requests/${mine}/cancel`, s.alice.token, {
          reasonCode: 'no_longer_needed',
        })
        .expect(200);
      expect(err(await complain(mine))).toMatchObject({
        code: 'PARTNER_REQUEST_NOT_CLOSED',
        params: { status: 'cancelled' },
      });
      const theirs = (await p.request(s.alice, s.homeA.id, partnerId)).id;
      await p.desk(token, `/requests/${theirs}/accept`).expect(200);
      await p
        .desk(token, `/requests/${theirs}/cancel`, { reasonCode: 'emergency' })
        .expect(200);
      await complain(theirs).expect(201);
      const amount = await complain(await done(), {
        compensationAsk: 'redo',
        requestedAmount: '10',
      });
      expect((amount.body as { fields: unknown[] }).fields).toEqual([
        { field: 'requestedAmount', code: 'PARTNER_AMOUNT_NOT_ASKED' },
      ]);
    });

    it('two complaints at once about one request: one management request, one complaint', async () => {
      const id = await done();
      const before = await p.inTx(s.c, (tx) => tx.managementRequest.count());
      const [x, y] = await Promise.all([complain(id), complain(id)]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      expect(await p.inTx(s.c, (tx) => tx.managementRequest.count())).toBe(
        before + 1,
      );
    });

    it('is decided once; not upheld arranges nothing; the complainant is told by codes', async () => {
      const id = await done();
      const complaintId = (
        (await complain(id).expect(201)).body as { id: string }
      ).id;
      const wrong = await p.http(
        'post',
        `/staff/partner-complaints/${complaintId}/decide`,
        s.keeper.token,
        { outcome: 'not_upheld', compensation: 'credit_note' },
      );
      expect((wrong.body as { fields: unknown[] }).fields).toEqual([
        { field: 'compensation', code: 'PARTNER_COMPENSATION_NOT_UPHELD' },
      ]);
      const decided = await p
        .http(
          'post',
          `/staff/partner-complaints/${complaintId}/decide`,
          s.keeper.token,
          {
            outcome: 'upheld',
            compensation: 'credit_note',
          },
        )
        .expect(200);
      expect(decided.body).toMatchObject({
        outcome: 'upheld',
        compensation: 'credit_note',
      });
      const again = await p.http(
        'post',
        `/staff/partner-complaints/${complaintId}/decide`,
        s.keeper.token,
        { outcome: 'not_upheld', compensation: 'none' },
      );
      expect(err(again).code).toBe('PARTNER_COMPLAINT_DECIDED');
      const told = await p.notifications(
        s.c,
        s.alice.id,
        'partner_complaint.decided',
      );
      expect(told.find((n) => n.targetId === complaintId)?.params).toEqual({
        outcome: 'upheld',
        compensation: 'credit_note',
      });
      // No money moved: no credit note was issued here.
      expect(
        await p.inTx(s.c, (tx) => tx.creditNote.count({ where: {} })),
      ).toBe(0);
    });
  });
});
