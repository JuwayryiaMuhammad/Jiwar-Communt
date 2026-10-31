import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { R11C2_COVERAGE } from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp } from '../setup/market';

const MARKER = 'AUDIT-r11c2-secret';

/**
 * One scenario per entry of community's catalog (ADR 0014, 0071): actor,
 * target and metadata — kinds, codes, ids and counts, never a seller's
 * words or anything that names a person.
 */
const covered = new Set<string>();

describe('Audit coverage — community', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: MarketSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    read = auditReaders(h);
    s = await m.setUp();
  }, 90_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  describe('the market', () => {
    it('market_listing.created, .updated, .approved and .sold — kind, category, state and counts; the words as changed only', async () => {
      const photo = await m.photo(s.alice);
      const { id } = await m.listing(s.alice, {
        title: `${MARKER} title`,
        body: MARKER,
        photoFileIds: [photo],
      });
      expect(await single('market_listing.created', id)).toMatchObject({
        actorId: s.alice.id,
        metadata: {
          kind: 'sell',
          category: 'furniture',
          status: 'pending_review',
          unitId: null,
          photos: 1,
        },
      });
      await m.review(s.marketHandler, id, 'approve').expect(204);
      expect(await single('market_listing.approved', id)).toMatchObject({
        actorId: s.marketHandler.id,
        metadata: { from: 'pending_review' },
      });
      await m
        .http('patch', `/market/listings/${id}`, s.alice.token, {
          body: `${MARKER} again`,
          negotiable: true,
        })
        .expect(200);
      expect(await single('market_listing.updated', id)).toMatchObject({
        actorId: s.alice.id,
        metadata: { backToReview: true },
        changes: {
          body: { changed: true },
          negotiable: { from: false, to: true },
        },
      });
      await m.review(s.marketHandler, id, 'approve').expect(204);
      await m
        .http('post', `/market/listings/${id}/sold`, s.alice.token)
        .expect(204);
      expect(await single('market_listing.sold', id)).toMatchObject({
        actorId: s.alice.id,
        metadata: { kind: 'sell' },
      });
    });

    it('market_listing.rejected and .removed — the code', async () => {
      const turned = (await m.listing(s.bob, { title: 'Turned down' })).id;
      await m
        .review(s.marketHandler, turned, 'reject', 'incomplete')
        .expect(204);
      expect(await single('market_listing.rejected', turned)).toMatchObject({
        actorId: s.marketHandler.id,
        metadata: { reasonCode: 'incomplete' },
      });
      const off = await m.live(s.bob, s.marketHandler, { title: 'Taken off' });
      await m
        .review(s.marketHandler, off, 'remove', 'prohibited_item')
        .expect(204);
      expect(await single('market_listing.removed', off)).toMatchObject({
        actorId: s.marketHandler.id,
        metadata: { reasonCode: 'prohibited_item' },
      });
    });

    it('market_listing.withdrawn and .expired — by whom, and the system’s code; the sweep is the system', async () => {
      const mine = await m.live(s.bob, s.marketHandler, { title: 'Withdrawn' });
      await m
        .http('post', `/market/listings/${mine}/withdraw`, s.bob.token)
        .expect(204);
      expect(await single('market_listing.withdrawn', mine)).toMatchObject({
        actorId: s.bob.id,
        metadata: { kind: 'sell', by: 'seller' },
      });
      const old = await m.live(s.bob, s.marketHandler, { title: 'Old one' });
      await m.expire(s.c, old);
      await m.sweep();
      expect(await single('market_listing.expired', old)).toMatchObject({
        actorType: 'system',
        metadata: { kind: 'sell' },
      });
    });

    it('market.settings_changed — the settings, from and to', async () => {
      await m.marketSettings(s.manager, { expiryDays: 21 });
      expect(
        await single('market.settings_changed', s.c.tenantId),
      ).toMatchObject({
        actorId: s.manager.id,
        changes: { expiryDays: { from: 30, to: 21 } },
      });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of community has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11C2_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11C2_COVERAGE].sort());
    });
  });
});
