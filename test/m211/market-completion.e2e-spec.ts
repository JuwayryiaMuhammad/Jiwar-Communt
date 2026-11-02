import { Client } from 'pg';
import { GROUP_OFFERS_SWEEP } from '../../src/partners/group-offers/group-offers.service';
import { auditReaders } from '../setup/audit';
import { at, daysLater, dbClock, day } from '../setup/compound-clock';
import { queuedBehind } from '../setup/held-lock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp, type Who } from '../setup/market';
import { required } from '../setup/test-env';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

type Offer = Record<string, unknown> & {
  id: string;
  status: string;
  finalPrice: string | null;
  myReconfirmNeeded: boolean;
  joined: number;
};

/**
 * ADR 0083: the market's rules on every new or edited listing (and a new
 * shop) — commercial listings blocked, the allowed categories, a limit per
 * unit — and a group offer's contract, with each participant re-confirming
 * a final price above the group price or dropping out.
 */
describe('Market completion — the rules and group offers’ contracts', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  describe('the rules', () => {
    let s: MarketSetUp;

    beforeAll(async () => {
      s = await m.setUp();
      await m.marketSettings(s.manager, { requiresReview: false });
    });

    it('the settings say what is allowed, audited', async () => {
      const after = (
        await m.marketSettings(s.manager, {
          commercialBlocked: true,
          allowedCategories: ['furniture', 'books', 'services'],
          maxLivePerUnit: 3,
        })
      ).body as Record<string, unknown>;
      expect(after).toMatchObject({
        commercialBlocked: true,
        allowedCategories: ['furniture', 'books', 'services'],
        maxLivePerUnit: 3,
      });
      expect(
        (
          await m.http('patch', '/market/settings', s.manager.token, {
            allowedCategories: [],
          })
        ).status,
      ).toBe(400);
      const changed = await auditReaders(h).tenant(s.c.tenantId, {
        action: 'market.settings_changed',
      });
      expect(changed[changed.length - 1]?.changes).toMatchObject({
        commercialBlocked: { from: false, to: true },
        maxLivePerUnit: { from: 10, to: 3 },
      });
      await m.marketSettings(s.manager, {
        commercialBlocked: false,
        allowedCategories: ['furniture', 'electronics', 'books', 'services'],
        maxLivePerUnit: 10,
      });
    });

    it('commercial listings blocked: no service, nothing under a shop, no new shop; what is open stays and cannot be edited', async () => {
      const service = await m.listing(s.bob, {
        kind: 'service',
        category: 'services',
        title: 'Math tutoring',
        price: undefined,
      });
      await m.marketSettings(s.manager, { commercialBlocked: true });
      expect(
        code(
          await m.listRaw(s.alice, {
            kind: 'service',
            category: 'services',
            title: 'Piano lessons',
            price: undefined,
          }),
        ),
      ).toEqual({ status: 409, code: 'MARKET_COMMERCIAL_BLOCKED' });
      expect(
        code(
          await m.http('post', '/market/shops', s.alice.token, {
            nameEn: 'Alice Bakes',
            nameAr: 'مخبوزات أليس',
            description: 'Cakes to order.',
            category: 'furniture',
          }),
        ),
      ).toEqual({ status: 409, code: 'MARKET_COMMERCIAL_BLOCKED' });
      expect(
        code(
          await m.http('patch', `/market/listings/${service.id}`, s.bob.token, {
            title: 'Math and physics tutoring',
          }),
        ),
      ).toEqual({ status: 409, code: 'MARKET_COMMERCIAL_BLOCKED' });
      expect((await m.row(s.c, service.id)).status).toBe('live');
      // A plain sale is not commercial.
      await m.listing(s.alice);
      await m.marketSettings(s.manager, { commercialBlocked: false });
    });

    it('only the allowed categories, on a new listing and on an edit', async () => {
      const table = await m.listing(s.alice);
      await m.marketSettings(s.manager, {
        allowedCategories: ['furniture', 'books'],
      });
      const refused = await m.listRaw(s.alice, { category: 'electronics' });
      expect(code(refused)).toEqual({
        status: 409,
        code: 'MARKET_CATEGORY_NOT_ALLOWED',
      });
      expect((refused.body as { params?: unknown }).params).toEqual({
        category: 'electronics',
      });
      expect(
        code(
          await m.http('patch', `/market/listings/${table.id}`, s.alice.token, {
            category: 'electronics',
          }),
        ),
      ).toEqual({ status: 409, code: 'MARKET_CATEGORY_NOT_ALLOWED' });
      await m
        .http('patch', `/market/listings/${table.id}`, s.alice.token, {
          category: 'books',
        })
        .expect(200);
      await m.marketSettings(s.manager, {
        allowedCategories: ['furniture', 'electronics', 'books', 'services'],
      });
    });

    it('a limit per unit, whoever of its people lists; race: two of a household at the last place, one refused', async () => {
      const home = await m.unit(s.c, 'D');
      const owner = await m.owner(s.c, home.id);
      const tenant = await m.tenant(s.c, home.id);
      await m.marketSettings(s.manager, { maxLivePerUnit: 1 });
      await m.listing(owner, { fromUnitId: home.id });
      expect(code(await m.listRaw(tenant, { fromUnitId: home.id }))).toEqual({
        status: 409,
        code: 'MARKET_UNIT_LISTING_LIMIT_REACHED',
      });

      const other = await m.unit(s.c, 'D');
      const a = await m.owner(s.c, other.id);
      const b = await m.tenant(s.c, other.id);
      const answers = await queuedBehind(
        {
          sql: 'SELECT pg_advisory_xact_lock(hashtext($1))',
          params: [`neighbour-unit-quota:${s.c.tenantId}:${other.id}`],
        },
        [
          () => m.listRaw(a, { fromUnitId: other.id }),
          () => m.listRaw(b, { fromUnitId: other.id }),
        ],
      );
      expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        answers.map((r) => (r.body as { code?: string }).code).filter(Boolean),
      ).toEqual(['MARKET_UNIT_LISTING_LIMIT_REACHED']);
      await m.marketSettings(s.manager, { maxLivePerUnit: 10 });
    });
  });

  describe('group offers’ contracts', () => {
    let s: MarketSetUp;
    let carol: Who;
    let carolUnit: string;

    beforeAll(async () => {
      s = await m.setUp();
      carolUnit = (await m.unit(s.c, 'C')).id;
      carol = await m.owner(s.c, carolUnit);
    });

    const sweep = () => m.sweep_(GROUP_OFFERS_SWEEP, dbClock());
    const offerAs = async (who: Who, id: string) =>
      (await m.http('get', `/market/group-offers/${id}`, who.token).expect(200))
        .body as Offer;
    /** Published, joined by Alice, Bob and Carol, and confirmed. */
    async function confirmed(): Promise<Offer> {
      const offer = (
        await m
          .http('post', '/staff/group-offers', s.manager.token, {
            titleEn: 'Solar heaters',
            titleAr: 'سخانات شمسية',
            bodyEn: 'Installed on the roof.',
            bodyAr: 'تركيب على السطح.',
            listPrice: '1200',
            groupPrice: '950',
            minParticipants: 2,
            closesAt: at(day(5), 20).toISOString(),
          })
          .expect(201)
      ).body as Offer;
      for (const [who, unitId] of [
        [s.alice, s.homeA.id],
        [s.bob, s.homeB.id],
        [carol, carolUnit],
      ] as const)
        await m
          .http('post', `/market/group-offers/${offer.id}/join`, who.token, {
            unitId,
            quantity: 1,
          })
          .expect(201);
      await m.timeMachine(s.c, offer.id);
      await sweep();
      expect((await offerAs(s.alice, offer.id)).status).toBe('confirmed');
      return offer;
    }
    const contract = (id: string, body: object) =>
      m.http(
        'post',
        `/staff/group-offers/${id}/contract`,
        s.manager.token,
        body,
      );
    const reconfirm = (who: Who, id: string) =>
      m.http('post', `/market/group-offers/${id}/reconfirm`, who.token);
    /** Moves a re-confirming offer's deadline into the past. */
    async function deadlinePassed(offerId: string) {
      const db = new Client({
        connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
      });
      await db.connect();
      try {
        await db.query('BEGIN');
        await db.query(`SET LOCAL session_replication_role = replica`);
        await db.query(
          `UPDATE group_offers SET reconfirm_closes_at = now() - interval '1 second'
            WHERE id = $1 AND tenant_id = $2`,
          [offerId, s.c.tenantId],
        );
        await db.query('COMMIT');
      } finally {
        await db.end();
      }
    }

    it('at or below the group price: contracted at once, the participants told', async () => {
      const offer = await confirmed();
      const done = (await contract(offer.id, { finalPrice: '900' }).expect(200))
        .body as Offer;
      expect(done).toMatchObject({
        status: 'contracted',
        finalPrice: '900.00',
        myReconfirmNeeded: false,
      });
      expect(
        (await m.notifications(s.c, carol.id, 'group_offer.contracted')).map(
          (n) => [n.targetId, n.params],
        ),
      ).toEqual([[offer.id, { finalPrice: '900.00' }]]);
      expect(code(await contract(offer.id, { finalPrice: '900' }))).toEqual({
        status: 409,
        code: 'GROUP_OFFER_PHASE',
      });
    });

    it('above it: each participant re-confirms or leaves; whoever did not by the deadline is dropped, and the offer is contracted with those who stayed', async () => {
      const offer = await confirmed();
      const held = (
        await contract(offer.id, {
          finalPrice: '1000',
          reconfirmHours: 24,
        }).expect(200)
      ).body as Offer;
      expect(held).toMatchObject({
        status: 'reconfirming',
        finalPrice: '1000.00',
      });
      expect(
        (
          await m.notifications(
            s.c,
            s.bob.id,
            'group_offer.reconfirm_requested',
          )
        ).map((n) => n.params),
      ).toEqual([{ finalPrice: '1000.00', joinedPrice: '950.00' }]);
      expect((await offerAs(s.alice, offer.id)).myReconfirmNeeded).toBe(true);
      expect(
        (await reconfirm(s.alice, offer.id).expect(200)).body as Offer,
      ).toMatchObject({ myReconfirmNeeded: false });
      expect(code(await reconfirm(s.alice, offer.id))).toEqual({
        status: 409,
        code: 'GROUP_OFFER_RECONFIRM_NOT_NEEDED',
      });
      // Carol declines: she leaves before the deadline.
      await m
        .http('post', `/market/group-offers/${offer.id}/leave`, carol.token)
        .expect(200);
      await reconfirm(s.bob, offer.id).expect(200);

      await deadlinePassed(offer.id);
      await sweep();
      expect(await offerAs(s.alice, offer.id)).toMatchObject({
        status: 'contracted',
        joined: 2,
      });
      expect(
        await m.notifications(s.c, carol.id, 'group_offer.dropped'),
      ).toEqual([]);
    });

    it('too few re-confirm: the silent are dropped and told, and the offer fails', async () => {
      const offer = await confirmed();
      await contract(offer.id, { finalPrice: '1100' }).expect(200);
      await reconfirm(s.alice, offer.id).expect(200);
      await deadlinePassed(offer.id);
      await sweep();
      expect(await offerAs(s.alice, offer.id)).toMatchObject({
        status: 'failed',
        joined: 1,
      });
      for (const who of [s.bob, carol])
        expect(
          (await m.notifications(s.c, who.id, 'group_offer.dropped')).map(
            (n) => n.targetId,
          ),
        ).toContain(offer.id);
      const rows = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.groupOfferParticipant.findMany({
          where: { offerId: offer.id, kind: 'join' },
          select: { accountId: true, dropped: true, reconfirmedAt: true },
        }),
      );
      expect(
        rows
          .map((r) => [r.accountId, r.dropped, r.reconfirmedAt !== null])
          .sort(),
      ).toEqual(
        [
          [s.alice.id, false, true],
          [s.bob.id, true, false],
          [carol.id, true, false],
        ].sort(),
      );
    });

    it('race: a re-confirmation and the close — whichever the database’s clock puts first; the dropped never count, the re-confirmed never drop', async () => {
      // Before the deadline: the re-confirmation wins, the close waits.
      const early = await confirmed();
      await contract(early.id, { finalPrice: '1000' }).expect(200);
      // The sweep is asked as if past the deadline, so it takes the
      // offer's row; the database's clock still says it is not.
      const [kept, noClose] = await queuedBehind<unknown>(
        {
          sql: 'SELECT id FROM group_offers WHERE id = $1 FOR UPDATE',
          params: [early.id],
        },
        [
          () => reconfirm(carol, early.id),
          () => m.sweep_(GROUP_OFFERS_SWEEP, daysLater(4)),
        ],
      );
      expect((kept as { status: number }).status).toBe(200);
      expect(noClose).toBe(0);
      expect((await offerAs(carol, early.id)).status).toBe('reconfirming');

      // Past the deadline: the close drops whoever had not re-confirmed,
      // and a re-confirmation behind it is refused.
      const late = await confirmed();
      await contract(late.id, { finalPrice: '1000' }).expect(200);
      await reconfirm(s.alice, late.id).expect(200);
      await reconfirm(s.bob, late.id).expect(200);
      await deadlinePassed(late.id);
      const [closed, refused] = await queuedBehind<unknown>(
        {
          sql: 'SELECT id FROM group_offers WHERE id = $1 FOR UPDATE',
          params: [late.id],
        },
        [() => sweep(), () => reconfirm(carol, late.id)],
      );
      expect(closed as number).toBeGreaterThanOrEqual(1);
      expect(code(refused as { status: number; body: unknown })).toEqual({
        status: 409,
        code: 'GROUP_OFFER_PHASE',
      });
      const carolRow = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.groupOfferParticipant.findFirstOrThrow({
          where: { offerId: late.id, accountId: carol.id, kind: 'join' },
        }),
      );
      expect([carolRow.dropped, carolRow.reconfirmedAt]).toEqual([true, null]);
      expect((await offerAs(s.alice, late.id)).status).toBe('contracted');
    });
  });
});
