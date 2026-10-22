import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PARTNER_EXPIRE_SWEEP } from '../../src/partners/requests/request-sweeps';
import { at, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  partnersHelpers,
  shiftWindow,
  type DeskRequestBody,
  type PartnersSetUp,
  type RequestBody,
} from '../setup/partners';

/**
 * A resident's requests to partners (ADR 0060): who may ask, what a request
 * asks and keeps, the partner's answers on its desk and through the relay,
 * the resident's moves, the sweeps, and what each side is told.
 */
describe('Partners: requests (ADR 0060)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;
  let partnerId: string;
  let token: string;
  let cleaning: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
    cleaning = await p.subcategory(s.c, 'cleaning');
    partnerId = await p.partner(s.c, s.keeper, {
      notifyEmail: 'desk@sparkle.example',
    });
    token = await p.deskLink(s.keeper, partnerId);
    await p.consent(s.alice);
    await p.consent(s.bob);
    // More requests than an account keeps open by default.
    await p
      .http('patch', '/staff/partner-settings', s.manager.token, {
        maxLiveRequests: 20,
      })
      .expect(200);
  }, 180_000);

  afterAll(() => h.close());

  const fields = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const err = (res: { body: unknown }) =>
    res.body as { code: string; params?: Record<string, unknown> };

  describe('who may ask', () => {
    it('a resident who may invite visitors to the unit, for a category whose consent they granted', async () => {
      const body = await p.request(s.alice, s.homeA.id, partnerId, {
        subcategoryId: cleaning,
        note: '  Second floor, the bell is broken  ',
      });
      expect(body).toMatchObject({
        status: 'pending',
        category: 'home_services',
        note: 'Second floor, the bell is broken',
        unitCode: s.homeA.code,
        gatePass: true,
        closedBy: null,
      });
      expect(body.number).toMatch(/^SR-\d{6}$/);
      expect(body.history).toEqual([
        expect.objectContaining({ kind: 'created', by: 'resident' }),
      ]);
    });

    it('without the category’s consent: 409 CONSENT_REQUIRED, naming the consent', async () => {
      const res = await p.ask(s.alice, s.homeA.id, partnerId, {
        category: 'pets',
      });
      expect(res.status).toBe(409);
      expect(err(res)).toMatchObject({
        code: 'CONSENT_REQUIRED',
        params: { code: 'partner_share_pets' },
      });
    });

    it('a member the primary has not let invite visitors is refused; with the grant, they may ask (ADR 0021)', async () => {
      const member = await p.family(s.c, s.homeA.id, s.alice);
      await p.consent(member);
      await p.canInvite(s.c, s.alice, member.memberId, false);
      const refused = await p.ask(member, s.homeA.id, partnerId);
      expect(refused.status).toBe(403);
      expect(err(refused).code).toBe('PARTNER_REQUEST_NOT_ALLOWED');
      await p.canInvite(s.c, s.alice, member.memberId, true);
      expect((await p.ask(member, s.homeA.id, partnerId)).status).toBe(201);
    });

    it('a landlord who does not live there is refused; another unit is not found', async () => {
      const landlord = await p.landlord(s.c, s.homeB.id);
      await p.consent(landlord);
      const refused = await p.ask(landlord, s.homeB.id, partnerId);
      expect([refused.status, err(refused).code]).toEqual([
        403,
        'PARTNER_REQUEST_NOT_ALLOWED',
      ]);
      const other = await p.ask(s.alice, s.homeB.id, partnerId);
      expect([other.status, err(other).code]).toEqual([404, 'UNIT_NOT_FOUND']);
    });
  });

  describe('what a request asks', () => {
    it('a category or sub-category the partner offers; a building it serves', async () => {
      const notOffered = await p.ask(s.alice, s.homeA.id, partnerId, {
        category: 'pets',
      });
      // No consent for pets is asked first; with it, the service is checked.
      expect(err(notOffered).code).toBe('CONSENT_REQUIRED');
      await p.consent(s.alice, 'pets');
      expect(
        fields(
          await p.ask(s.alice, s.homeA.id, partnerId, { category: 'pets' }),
        ),
      ).toEqual([{ field: 'category', code: 'PARTNER_SERVICE_NOT_OFFERED' }]);
      const pest = await p.subcategory(s.c, 'pest_control');
      expect(
        fields(
          await p.ask(s.alice, s.homeA.id, partnerId, { subcategoryId: pest }),
        ),
      ).toEqual([
        { field: 'subcategoryId', code: 'PARTNER_SERVICE_NOT_OFFERED' },
      ]);
      const onlyB = await p.partner(s.c, s.keeper, { serviceBuildings: ['B'] });
      const far = await p.ask(s.alice, s.homeA.id, onlyB);
      expect([far.status, err(far).code]).toEqual([409, 'PARTNER_OUT_OF_AREA']);
      expect((await p.ask(s.bob, s.homeB.id, onlyB)).status).toBe(201);
    });

    it('a window 15 minutes to 14 days ahead, 30 minutes to 8 hours long', async () => {
      const soon = await p.ask(s.alice, s.homeA.id, partnerId, {
        windowStartsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        windowEndsAt: new Date(Date.now() + 65 * 60_000).toISOString(),
      });
      expect(fields(soon)).toEqual([
        {
          field: 'windowStartsAt',
          code: 'PARTNER_WINDOW_TOO_SOON',
          params: { minutes: 15 },
        },
      ]);
      expect(
        fields(
          await p.ask(s.alice, s.homeA.id, partnerId, p.windowOf(10, 10.25)),
        ),
      ).toEqual([
        {
          field: 'windowEndsAt',
          code: 'PARTNER_WINDOW_LENGTH',
          params: { min: 30, max: 480 },
        },
      ]);
      expect(
        fields(
          await p.ask(s.alice, s.homeA.id, partnerId, {
            windowStartsAt: at(day(20), 10).toISOString(),
            windowEndsAt: at(day(20), 11).toISOString(),
          }),
        ),
      ).toEqual([
        {
          field: 'windowStartsAt',
          code: 'PARTNER_WINDOW_TOO_FAR',
          params: { days: 14 },
        },
      ]);
    });

    it('the lines it names are copied as announced: a later price list changes none of them', async () => {
      const priced = await p.partner(s.c, s.keeper);
      const list = await p
        .http('put', `/staff/partners/${priced}/prices`, s.keeper.token, {
          items: [
            {
              nameEn: 'Visit',
              nameAr: 'زيارة',
              price: '100',
              unit: 'visit_fee',
            },
            { nameEn: 'Room', nameAr: 'غرفة', price: '80', unit: 'per_item' },
          ],
        })
        .expect(200);
      const [visit, room] = (list.body as { priceItems: { id: string }[] })
        .priceItems;
      const body = await p.request(s.alice, s.homeA.id, priced, {
        items: [
          { priceItemId: visit.id, quantity: 1 },
          { priceItemId: room.id, quantity: 3 },
        ],
      });
      await p
        .http('put', `/staff/partners/${priced}/prices`, s.keeper.token, {
          items: [
            {
              nameEn: 'Visit',
              nameAr: 'زيارة',
              price: '250',
              unit: 'visit_fee',
            },
          ],
        })
        .expect(200);
      const read = (
        await p
          .http('get', `/partner-requests/${body.id}`, s.alice.token)
          .expect(200)
      ).body as RequestBody;
      expect(read.items).toEqual([
        {
          nameEn: 'Visit',
          nameAr: 'زيارة',
          price: '100.00',
          unit: 'visit_fee',
          quantity: 1,
        },
        {
          nameEn: 'Room',
          nameAr: 'غرفة',
          price: '80.00',
          unit: 'per_item',
          quantity: 3,
        },
      ]);
      // A line no longer announced cannot be named.
      expect(
        fields(
          await p.ask(s.alice, s.homeA.id, priced, {
            items: [{ priceItemId: room.id, quantity: 1 }],
          }),
        ),
      ).toEqual([
        {
          field: 'items.0.priceItemId',
          code: 'PARTNER_PRICE_ITEM_NOT_AVAILABLE',
        },
      ]);
    });

    it('a suspended partner takes no request', async () => {
      const gone = await p.partner(s.c, s.keeper);
      await p.inTx(s.c, (tx) =>
        tx.partner.update({
          where: { id: gone },
          data: {
            status: 'suspended',
            suspendedReason: 'safety',
            suspendedAt: new Date(),
            suspendedById: s.manager.id,
          },
        }),
      );
      const res = await p.ask(s.alice, s.homeA.id, gone);
      expect([res.status, err(res).code]).toEqual([409, 'PARTNER_SUSPENDED']);
    });
  });

  describe('the live limit', () => {
    it('holds when two requests at the limit are asked at once: one is made, the other refused', async () => {
      const carol = await p.owner(s.c, s.homeB.id);
      await p.consent(carol);
      await p
        .http('patch', '/staff/partner-settings', s.manager.token, {
          maxLiveRequests: 2,
        })
        .expect(200);
      try {
        await p.request(carol, s.homeB.id, partnerId);
        const [x, y] = await Promise.all([
          p.ask(carol, s.homeB.id, partnerId, p.windowOf(13, 14)),
          p.ask(carol, s.homeB.id, partnerId, p.windowOf(15, 16)),
        ]);
        expect([x.status, y.status].sort()).toEqual([201, 409]);
        expect(err([x, y].find((r) => r.status === 409)!)).toMatchObject({
          code: 'PARTNER_REQUEST_LIMIT_REACHED',
          params: { max: 2 },
        });
      } finally {
        await p
          .http('patch', '/staff/partner-settings', s.manager.token, {
            maxLiveRequests: 20,
          })
          .expect(200);
      }
    });
  });

  describe('a request is its requester’s alone', () => {
    it('the household’s primary and another resident get the same not-found', async () => {
      const member = await p.family(s.c, s.homeA.id, s.alice);
      await p.canInvite(s.c, s.alice, member.memberId, true);
      await p.consent(member);
      const mine = await p.request(member, s.homeA.id, partnerId);
      for (const who of [s.alice, s.bob]) {
        const res = await p.http(
          'get',
          `/partner-requests/${mine.id}`,
          who.token,
        );
        expect([res.status, err(res).code]).toEqual([
          404,
          'PARTNER_REQUEST_NOT_FOUND',
        ]);
      }
    });
  });

  describe('the desk', () => {
    it('shows the partner its requests with exactly what a request needs', async () => {
      const body = await p.request(s.alice, s.homeA.id, partnerId, {
        note: 'Ring twice',
      });
      const res = await p.desk(token, '/lookup').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const shown = (res.body as { requests: DeskRequestBody[] }).requests.find(
        (r) => r.id === body.id,
      )!;
      expect(shown).toMatchObject({
        status: 'pending',
        consentWithdrawn: false,
        unitCode: s.homeA.code,
        note: 'Ring twice',
      });
      expect(shown.firstName).toBeTruthy();
      const text = JSON.stringify(res.body);
      for (const forbidden of [s.alice.id, 'phone', 'email', 'fullName'])
        expect(text).not.toContain(forbidden);
    });

    it('accepting tells the requester; pressing twice changes nothing', async () => {
      const body = await p.request(s.alice, s.homeA.id, partnerId);
      const first = await p
        .desk(token, `/requests/${body.id}/accept`, { staffCount: 2 })
        .expect(200);
      const second = await p
        .desk(token, `/requests/${body.id}/accept`, { staffCount: 4 })
        .expect(200);
      expect((first.body as DeskRequestBody).status).toBe('accepted');
      expect(second.body).toMatchObject({ status: 'accepted', staffCount: 2 });
      const told = await p.notifications(
        s.c,
        s.alice.id,
        'partner_request.accepted',
      );
      expect(told.filter((n) => n.targetId === body.id)).toHaveLength(1);
      expect(told[0].params).toEqual({});
    });

    it('declines with a code from its list; proposes another window, which the requester accepts or declines', async () => {
      const declined = await p.request(s.alice, s.homeA.id, partnerId);
      const bad = await p.desk(token, `/requests/${declined.id}/decline`, {
        reasonCode: 'too_busy',
      });
      expect(fields(bad)).toEqual([
        expect.objectContaining({
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
        }),
      ]);
      await p
        .desk(token, `/requests/${declined.id}/decline`, {
          reasonCode: 'unavailable',
        })
        .expect(200);
      expect(
        (await p.notifications(s.c, s.alice.id, 'partner_request.declined')).at(
          -1,
        )?.params,
      ).toEqual({ reason: 'unavailable' });

      const taken = await p.request(s.alice, s.homeA.id, partnerId);
      const window = p.windowOf(14, 16, 3);
      await p
        .desk(token, `/requests/${taken.id}/propose`, {
          ...window,
          staffCount: 3,
        })
        .expect(200);
      const accepted = (
        await p
          .http(
            'post',
            `/partner-requests/${taken.id}/accept-proposal`,
            s.alice.token,
          )
          .expect(200)
      ).body as RequestBody;
      expect(accepted).toMatchObject({
        status: 'accepted',
        agreedStartsAt: window.windowStartsAt,
        agreedEndsAt: window.windowEndsAt,
        staffCount: 3,
        proposedStartsAt: null,
      });

      const refused = await p.request(s.alice, s.homeA.id, partnerId);
      await p
        .desk(token, `/requests/${refused.id}/propose`, window)
        .expect(200);
      expect(
        (
          await p
            .http(
              'post',
              `/partner-requests/${refused.id}/decline-proposal`,
              s.alice.token,
            )
            .expect(200)
        ).body,
      ).toMatchObject({
        status: 'cancelled',
        closedBy: 'resident',
        closeReason: 'proposal_declined',
      });
    });

    it('another partner’s request is not found on this desk', async () => {
      const other = await p.partner(s.c, s.keeper);
      const theirs = await p.request(s.alice, s.homeA.id, other);
      const res = await p.desk(token, `/requests/${theirs.id}/accept`);
      expect([res.status, err(res).code]).toEqual([
        404,
        'PARTNER_REQUEST_NOT_FOUND',
      ]);
    });

    it('a withdrawn consent hides the requester at once and the request takes no action', async () => {
      const dana = await p.owner(s.c, s.homeA.id);
      await p.consent(dana);
      const body = await p.request(dana, s.homeA.id, partnerId, {
        note: 'Gate 2',
      });
      await p
        .http('post', '/me/consents/revoke', dana.token, {
          code: 'partner_share_home_services',
        })
        .expect(200);
      const shown = (
        (await p.desk(token, '/lookup').expect(200)).body as {
          requests: DeskRequestBody[];
        }
      ).requests.find((r) => r.id === body.id)!;
      expect(shown).toMatchObject({
        consentWithdrawn: true,
        unitCode: null,
        firstName: null,
        note: null,
        items: [],
      });
      const res = await p.desk(token, `/requests/${body.id}/accept`);
      expect([res.status, err(res).code]).toEqual([
        409,
        'PARTNER_REQUEST_CONSENT_WITHDRAWN',
      ]);
      const relayed = await p.http(
        'get',
        `/staff/partner-requests/${body.id}`,
        s.keeper.token,
      );
      expect(relayed.body).toMatchObject({
        consentWithdrawn: true,
        note: null,
      });
    });

    it('every lookup is audited by ids and counts, as the system', async () => {
      await p.desk(token, '/lookup').expect(200);
      const rows = await p.inTx(s.c, (tx) =>
        tx.auditLog.findMany({
          where: { action: 'partner_desk.looked_up', targetId: partnerId },
          orderBy: { occurredAt: 'desc' },
          take: 1,
        }),
      );
      expect(rows[0]).toMatchObject({ actorType: 'system', actorId: null });
      expect(rows[0].metadata).toEqual({
        deskLinkId: expect.any(String) as string,
        requestCount: expect.any(Number) as number,
        withheldCount: expect.any(Number) as number,
      });
    });
  });

  describe('the relay', () => {
    it('a partner without a desk link has its requests told to partners.manage; the relay acts as its partner', async () => {
      const phoned = await p.partner(s.c, s.keeper);
      const body = await p.request(s.alice, s.homeA.id, phoned);
      const told = await p.notifications(
        s.c,
        s.keeper.id,
        'partner_request.awaiting_relay',
      );
      expect(told.find((n) => n.targetId === body.id)?.params).toEqual({
        category: 'home_services',
      });
      const relayed = await p
        .http(
          'post',
          `/staff/partner-requests/${body.id}/accept`,
          s.keeper.token,
          {
            staffCount: 1,
          },
        )
        .expect(200);
      expect(relayed.body).toMatchObject({ status: 'accepted' });
      const events = await p.inTx(s.c, (tx) =>
        tx.partnerRequestEvent.findMany({
          where: { requestId: body.id, kind: 'accepted' },
        }),
      );
      expect(events).toEqual([
        expect.objectContaining({
          actor: 'relay',
          actorAccountId: s.keeper.id,
        }),
      ]);
    });
  });

  describe('the resident’s moves and the clock', () => {
    it('done once the window started, no-show once it ended: too early before', async () => {
      const body = await p.request(s.alice, s.homeA.id, partnerId);
      await p.desk(token, `/requests/${body.id}/accept`).expect(200);
      const early = await p.http(
        'post',
        `/partner-requests/${body.id}/done`,
        s.alice.token,
      );
      expect([early.status, err(early).code]).toEqual([
        409,
        'PARTNER_REQUEST_TOO_EARLY',
      ]);
      await shiftWindow(body.id, 'started');
      const noShowEarly = await p.http(
        'post',
        `/partner-requests/${body.id}/no-show`,
        s.alice.token,
      );
      expect(err(noShowEarly).code).toBe('PARTNER_REQUEST_TOO_EARLY');
      await p
        .http('post', `/partner-requests/${body.id}/done`, s.alice.token)
        .expect(200);
      expect((await p.row(s.c, body.id)).closedBy).toBe('resident');
    });

    it('a request nobody accepted expires when its window starts; an accept that won stays', async () => {
      const lost = await p.request(s.alice, s.homeA.id, partnerId);
      const won = await p.request(s.alice, s.homeA.id, partnerId);
      await p.desk(token, `/requests/${won.id}/accept`).expect(200);
      await shiftWindow(lost.id, 'started');
      await shiftWindow(won.id, 'started');
      await p.sweep(PARTNER_EXPIRE_SWEEP);
      expect((await p.row(s.c, lost.id)).status).toBe('expired');
      expect((await p.row(s.c, won.id)).status).toBe('accepted');
      expect(
        (
          await p.notifications(s.c, s.alice.id, 'partner_request.expired')
        ).some((n) => n.targetId === lost.id),
      ).toBe(true);
    });

    it('two answers at once, on the desk and through the relay: one acceptance, recorded once', async () => {
      for (let i = 0; i < 3; i++) {
        const body = await p.request(s.alice, s.homeA.id, partnerId);
        const [desk, relay] = await Promise.all([
          p.desk(token, `/requests/${body.id}/accept`, { staffCount: 2 }),
          p.http(
            'post',
            `/staff/partner-requests/${body.id}/accept`,
            s.keeper.token,
            {
              staffCount: 3,
            },
          ),
        ]);
        expect([desk.status, relay.status]).toEqual([200, 200]);
        const row = await p.row(s.c, body.id);
        expect(row.status).toBe('accepted');
        const events = await p.inTx(s.c, (tx) =>
          tx.partnerRequestEvent.findMany({
            where: { requestId: body.id, kind: 'accepted' },
          }),
        );
        expect(events).toHaveLength(1);
        expect(row.staffCount).toBe(events[0].actor === 'relay' ? 3 : 2);
      }
    });

    it('the partner accepting and the resident cancelling at once: never accepted after a cancel', async () => {
      for (let i = 0; i < 3; i++) {
        const body = await p.request(s.alice, s.homeA.id, partnerId);
        const [accept, cancel] = await Promise.all([
          p.desk(token, `/requests/${body.id}/accept`),
          p.http('post', `/partner-requests/${body.id}/cancel`, s.alice.token, {
            reasonCode: 'found_another',
          }),
        ]);
        // The resident may cancel an accepted request too: it always ends
        // cancelled, and the desk either won first or was refused.
        expect(cancel.status).toBe(200);
        const row = await p.row(s.c, body.id);
        expect(row.status).toBe('cancelled');
        const kinds = (
          await p.inTx(s.c, (tx) =>
            tx.partnerRequestEvent.findMany({
              where: { requestId: body.id, kind: { not: 'created' } },
              orderBy: [{ at: 'asc' }, { id: 'asc' }],
            }),
          )
        ).map((e) => e.kind);
        // Never an orphan pass: one issued is one cancelled.
        expect(kinds.includes('pass_issued')).toBe(
          kinds.includes('pass_cancelled'),
        );
        const moves = kinds.filter((k) => !k.startsWith('pass_'));
        if (accept.status === 200)
          expect(moves).toEqual(['accepted', 'cancelled']);
        else {
          expect(err(accept).code).toBe('PARTNER_REQUEST_INVALID_TRANSITION');
          expect(moves).toEqual(['cancelled']);
        }
      }
    });
  });

  describe('the partner’s email', () => {
    it('says a request waits, with no resident data and no link', async () => {
      await p.request(s.alice, s.homeA.id, partnerId, {
        note: 'EMAIL-PII-NOTE',
      });
      const rows = await h.moduleRef
        .get(GlobalDbService)
        .outboxMessage.findMany({
          where: {
            tenantId: s.c.tenantId,
            templateKey: 'partner_desk.new_request',
          },
        });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.recipient).toBe('desk@sparkle.example');
        expect(row.recipientAccountId).toBeNull();
        expect(Object.keys(row.params as object)).toEqual(['compoundName']);
        expect(JSON.stringify(row)).not.toContain('EMAIL-PII-NOTE');
      }
    });
  });

  describe('in the resident’s lists (ADR 0058)', () => {
    interface Item {
      type: string;
      id: string;
      number: string | null;
      status: string;
      unitId: string | null;
      kind: string | null;
    }
    const items = async (path: string, as = s.alice) =>
      (
        (await p.http('get', path, as.token).expect(200)).body as {
          data: Item[];
        }
      ).data.filter((i) => i.type === 'partner_request');

    it('a request is among the requester’s own, open then closed, never another resident’s', async () => {
      const body = await p.request(s.alice, s.homeA.id, partnerId);
      const mine = await items('/me/requests?limit=100&state=open');
      expect(mine.find((i) => i.id === body.id)).toEqual(
        expect.objectContaining({
          number: body.number,
          status: 'pending',
          unitId: s.homeA.id,
          kind: 'home_services',
        }),
      );
      expect(
        (await items('/me/requests?limit=100', s.bob)).map((i) => i.id),
      ).not.toContain(body.id);
      await p
        .http('post', `/partner-requests/${body.id}/cancel`, s.alice.token, {
          reasonCode: 'no_longer_needed',
        })
        .expect(200);
      expect(
        (await items('/me/requests?limit=100&state=open')).map((i) => i.id),
      ).not.toContain(body.id);
      expect(
        (await items('/me/requests?limit=100&state=closed')).find(
          (i) => i.id === body.id,
        ),
      ).toMatchObject({ status: 'cancelled' });
    });

    it('the search finds it by its reference and by the partner’s name, for its requester alone', async () => {
      const body = await p.request(s.alice, s.homeA.id, partnerId);
      const digits = body.number.replace(/^SR-0*/, '');
      for (const q of [body.number, `sr${digits}`, 'sparkle', 'سباركل'])
        expect(
          (await items(`/me/search?q=${encodeURIComponent(q)}`)).map(
            (i) => i.id,
          ),
        ).toContain(body.id);
      expect(
        (await items(`/me/search?q=${body.number}`, s.bob)).map((i) => i.id),
      ).not.toContain(body.id);
    });
  });
});
