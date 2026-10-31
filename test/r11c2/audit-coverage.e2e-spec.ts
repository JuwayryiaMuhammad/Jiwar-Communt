import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { GROUP_OFFERS_SWEEP } from '../../src/partners/group-offers/group-offers.service';
import { at, dbClock, day } from '../setup/compound-clock';
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

    it('market_shop.opened, .approved, .suspended, .reinstated, .rejected and .closed — the category, the codes, who closed it; never its words', async () => {
      const open = async (by: typeof s.alice, nameEn: string) =>
        (
          (
            await m
              .http('post', '/market/shops', by.token, {
                nameEn,
                nameAr: 'متجر',
                description: MARKER,
                category: 'food',
              })
              .expect(201)
          ).body as { id: string }
        ).id;
      const act = (id: string, action: string, reasonCode?: string) =>
        m
          .http(
            'post',
            `/market/shop-review/${id}/${action}`,
            s.marketHandler.token,
            reasonCode ? { reasonCode } : {},
          )
          .expect(204);
      const shop = await open(s.alice, 'Audit bakery');
      expect(await single('market_shop.opened', shop)).toMatchObject({
        actorId: s.alice.id,
        metadata: { category: 'food' },
      });
      await act(shop, 'approve');
      expect(await single('market_shop.approved', shop)).toMatchObject({
        actorId: s.marketHandler.id,
      });
      await act(shop, 'suspend', 'complaints');
      expect(await single('market_shop.suspended', shop)).toMatchObject({
        metadata: { reasonCode: 'complaints' },
      });
      await act(shop, 'approve');
      expect(await single('market_shop.reinstated', shop)).toMatchObject({
        actorId: s.marketHandler.id,
      });
      await m.http('post', '/me/market/shop/close', s.alice.token).expect(204);
      expect(await single('market_shop.closed', shop)).toMatchObject({
        actorId: s.alice.id,
        metadata: { by: 'owner' },
      });
      const turned = await open(s.bob, 'Audit odd jobs');
      await act(turned, 'reject', 'duplicate');
      expect(await single('market_shop.rejected', turned)).toMatchObject({
        metadata: { reasonCode: 'duplicate' },
      });
    });

    it('market_listing.reported, .under_review and market_report.closed — the codes, the count of units, the outcome; never the note', async () => {
      const listing = await m.live(s.alice, s.marketHandler, {
        title: 'Reported thing',
      });
      await m.marketSettings(s.manager, { reportHideThreshold: 1 });
      try {
        const report = (
          (
            await m
              .http('post', `/market/listings/${listing}/report`, s.bob.token, {
                reasonCode: 'scam',
                note: MARKER,
              })
              .expect(201)
          ).body as { id: string }
        ).id;
        expect(await single('market_listing.reported', listing)).toMatchObject({
          actorId: s.bob.id,
          metadata: { reportId: report, reasonCode: 'scam' },
        });
        expect(
          await single('market_listing.under_review', listing),
        ).toMatchObject({ metadata: { units: 1 } });
        await m
          .http(
            'post',
            `/market/reports/${report}/close`,
            s.marketHandler.token,
            {
              reasonCode: 'no_action',
            },
          )
          .expect(204);
        expect(await single('market_report.closed', report)).toMatchObject({
          actorId: s.marketHandler.id,
          metadata: {
            listingId: listing,
            outcome: 'no_action',
            removed: false,
          },
        });
      } finally {
        await m.marketSettings(s.manager, { reportHideThreshold: 3 });
      }
    });

    it('partner_offer.published and .withdrawn — the partner and the days', async () => {
      const partnerId = await m.partner(s.c);
      const offer = (
        (
          await m
            .http(
              'post',
              `/staff/partners/${partnerId}/offers`,
              s.manager.token,
              {
                titleEn: 'Spring offer',
                titleAr: 'عرض الربيع',
                bodyEn: MARKER,
                bodyAr: MARKER,
                validFromOn: day(0),
                validToOn: day(7),
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      expect(await single('partner_offer.published', offer)).toMatchObject({
        actorId: s.manager.id,
        metadata: { partnerId, validFromOn: day(0), validToOn: day(7) },
      });
      await m
        .http(
          'post',
          `/staff/partner-offers/${offer}/withdraw`,
          s.manager.token,
        )
        .expect(204);
      expect(await single('partner_offer.withdrawn', offer)).toMatchObject({
        actorId: s.manager.id,
        metadata: { partnerId },
      });
    });

    it('group_offer.created, .opened, .joined, .left, .confirmed, .failed and .cancelled — terms, units, quantities and counts', async () => {
      const publish = async (over: Record<string, unknown> = {}) =>
        (
          (
            await m
              .http('post', '/staff/group-offers', s.manager.token, {
                titleEn: 'Audit filters',
                titleAr: 'فلاتر',
                bodyEn: MARKER,
                bodyAr: MARKER,
                listPrice: '100',
                groupPrice: '80',
                minParticipants: 2,
                closesAt: at(day(5), 20).toISOString(),
                ...over,
              })
              .expect(201)
          ).body as { id: string }
        ).id;
      const join = (by: typeof s.alice, id: string, unitId: string) =>
        m
          .http('post', `/market/group-offers/${id}/join`, by.token, {
            unitId,
            quantity: 1,
          })
          .expect(201);
      const ok = await publish({
        interestClosesAt: at(day(2), 20).toISOString(),
      });
      expect(await single('group_offer.created', ok)).toMatchObject({
        actorId: s.manager.id,
        metadata: {
          status: 'interest',
          listPrice: '100.00',
          groupPrice: '80.00',
          minParticipants: 2,
        },
      });
      await m
        .http('post', `/staff/group-offers/${ok}/open`, s.manager.token)
        .expect(204);
      expect(await single('group_offer.opened', ok)).toMatchObject({
        metadata: { by: 'staff' },
      });
      await join(s.alice, ok, s.homeA.id);
      await join(s.bob, ok, s.homeB.id);
      await m
        .http('post', `/market/group-offers/${ok}/leave`, s.bob.token)
        .expect(200);
      expect(
        (
          await read.tenant(s.c.tenantId, {
            action: 'group_offer.joined',
            targetId: ok,
          })
        )
          .map((r) => r.actorId)
          .sort(),
      ).toEqual([s.alice.id, s.bob.id].sort());
      covered.add('group_offer.joined');
      expect(await single('group_offer.left', ok)).toMatchObject({
        actorId: s.bob.id,
        metadata: { unitId: s.homeB.id, quantity: 1 },
      });
      await join(s.bob, ok, s.homeB.id);
      await m.timeMachine(s.c, ok);
      await m.sweep_(GROUP_OFFERS_SWEEP, dbClock());
      expect(await single('group_offer.confirmed', ok)).toMatchObject({
        actorType: 'system',
        metadata: { households: 2, quantity: 2 },
      });
      const thin = await publish();
      await m.timeMachine(s.c, thin);
      await m.sweep_(GROUP_OFFERS_SWEEP, dbClock());
      expect(await single('group_offer.failed', thin)).toMatchObject({
        metadata: { households: 0, quantity: 0 },
      });
      const off = await publish();
      await m
        .http('post', `/staff/group-offers/${off}/cancel`, s.manager.token, {
          reasonCode: 'partner_withdrew',
        })
        .expect(204);
      expect(await single('group_offer.cancelled', off)).toMatchObject({
        metadata: { reasonCode: 'partner_withdrew' },
      });
    });

    it('engagement.prayer_settings_changed — the place and the method, from and to', async () => {
      await m
        .http('patch', '/community/prayer-settings', s.manager.token, {
          latitude: '30.044420',
          longitude: '31.235712',
          prayerMethod: 'umm_al_qura',
        })
        .expect(200);
      expect(
        await single('engagement.prayer_settings_changed', s.c.tenantId),
      ).toMatchObject({
        actorId: s.manager.id,
        changes: {
          latitude: { from: null, to: '30.044420' },
          longitude: { from: null, to: '31.235712' },
          prayerMethod: { from: 'egyptian', to: 'umm_al_qura' },
        },
      });
    });

    it('bus_route.created, .updated and bus_departure.added, .removed — the route, the weekdays and the minute', async () => {
      const line = (
        (
          await m
            .http('post', '/community/bus-routes', s.manager.token, {
              nameEn: 'Audit line',
              nameAr: 'خط',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      expect(await single('bus_route.created', line)).toMatchObject({
        actorId: s.manager.id,
      });
      await m
        .http('patch', `/community/bus-routes/${line}`, s.manager.token, {
          active: false,
        })
        .expect(200);
      expect(await single('bus_route.updated', line)).toMatchObject({
        metadata: { active: false, renamed: false },
      });
      const dep = (
        (
          await m
            .http(
              'post',
              `/community/bus-routes/${line}/departures`,
              s.manager.token,
              {
                weekdays: [0, 1],
                time: '07:30',
                fromStop: 'Gate',
                toStop: 'Metro',
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      expect(await single('bus_departure.added', dep)).toMatchObject({
        metadata: { routeId: line, weekdays: 3, departsMinute: 450 },
      });
      await m
        .http('delete', `/community/bus-departures/${dep}`, s.manager.token)
        .expect(204);
      expect(await single('bus_departure.removed', dep)).toMatchObject({
        metadata: { routeId: line },
      });
    });

    it('gallery_album.created, .published and gallery_photo.added, .reported, .hidden, .restored — ids, counts and codes', async () => {
      const albumId = (
        (
          await m
            .http('post', '/community/gallery/albums', s.manager.token, {
              titleEn: 'Audit album',
              titleAr: 'ألبوم',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      expect(await single('gallery_album.created', albumId)).toMatchObject({
        actorId: s.manager.id,
        metadata: { eventId: null },
      });
      const photo = (
        (
          await m
            .http(
              'post',
              `/community/gallery/albums/${albumId}/photos`,
              s.manager.token,
              {
                fileId: await m.galleryPhoto(s.manager),
                caption: MARKER,
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      expect(await single('gallery_photo.added', photo)).toMatchObject({
        metadata: { albumId },
      });
      await m
        .http(
          'post',
          `/community/gallery/albums/${albumId}/publish`,
          s.manager.token,
        )
        .expect(204);
      expect(await single('gallery_album.published', albumId)).toMatchObject({
        metadata: { photos: 1 },
      });
      await m
        .http('post', `/gallery/photos/${photo}/report`, s.bob.token, {
          reasonCode: 'privacy',
        })
        .expect(204);
      expect(await single('gallery_photo.reported', photo)).toMatchObject({
        actorId: s.bob.id,
        metadata: { reason: 'privacy' },
      });
      expect(await single('gallery_photo.hidden', photo)).toMatchObject({
        metadata: { reasonCode: 'privacy_report', by: 'report' },
      });
      await m
        .http(
          'post',
          `/community/gallery/photos/${photo}/restore`,
          s.manager.token,
        )
        .expect(204);
      expect(await single('gallery_photo.restored', photo)).toMatchObject({
        actorId: s.manager.id,
        metadata: { was: 'privacy_report' },
      });
    });

    it('visitor_pass.reinvited — the earlier pass and the unit; never the visitor', async () => {
      const first = (
        (
          await m
            .http(
              'post',
              `/units/${s.homeA.id}/visitor-passes`,
              s.alice.token,
              {
                kind: 'one_time',
                partySize: 1,
                validFrom: at(day(1), 10).toISOString(),
                validUntil: at(day(1), 12).toISOString(),
                visitorName: MARKER,
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      const next = (
        (
          await m
            .http('post', `/visitor-passes/${first}/reinvite`, s.alice.token, {
              validFrom: at(day(2), 10).toISOString(),
              validUntil: at(day(2), 12).toISOString(),
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      expect(await single('visitor_pass.reinvited', next)).toMatchObject({
        actorId: s.alice.id,
        metadata: { fromPassId: first, unitId: s.homeA.id },
      });
    });

    it('market.settings_changed — the settings, from and to', async () => {
      const before = (
        await read.tenant(s.c.tenantId, {
          action: 'market.settings_changed',
          targetId: s.c.tenantId,
        })
      ).length;
      await m.marketSettings(s.manager, { expiryDays: 21 });
      const rows = await read.tenant(s.c.tenantId, {
        action: 'market.settings_changed',
        targetId: s.c.tenantId,
      });
      expect(rows).toHaveLength(before + 1);
      covered.add('market.settings_changed');
      expect(rows[rows.length - 1]).toMatchObject({
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
