import type { Response } from 'supertest';
import { at, day } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of the market (ADR 0071), in A: each
 * that changes a listing works on one of its own, listed by A's owner.
 */
export function marketCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  let n = 0;
  const owner = () => world().a.tokens.owner;
  const manager = () => world().a.tokens.manager;
  const body = () => ({
    kind: 'sell',
    category: 'books',
    title: `No-store book ${++n}`,
    body: 'A paperback.',
    price: '20',
  });
  const listed = async (): Promise<string> =>
    (
      (
        await call(world(), 'POST', '/market/listings', {
          token: owner(),
          body: body(),
        }).expect(201)
      ).body as { id: string }
    ).id;
  const offer = () => ({
    titleEn: `Offer ${++n}`,
    titleAr: 'عرض',
    bodyEn: 'Words.',
    bodyAr: 'كلمات.',
    validFromOn: day(0),
    validToOn: day(5),
  });
  const group = (interest = false) => ({
    titleEn: `Group ${++n}`,
    titleAr: 'عرض جماعي',
    bodyEn: 'Words.',
    bodyAr: 'كلمات.',
    listPrice: '100',
    groupPrice: '80',
    minParticipants: 2,
    ...(interest ? { interestClosesAt: at(day(2), 12).toISOString() } : {}),
    closesAt: at(day(5), 12).toISOString(),
  });
  /** A new group offer of A's: in its interest phase, or open. */
  const grouped = async (interest = false): Promise<string> =>
    (
      (
        await call(world(), 'POST', '/staff/group-offers', {
          token: manager(),
          body: group(interest),
        }).expect(201)
      ).body as { id: string }
    ).id;
  const departure = () => ({
    weekdays: [0, 3],
    time: '08:15',
    fromStop: 'Gate 1',
    toStop: 'Metro',
  });
  const busRoute = async (): Promise<string> =>
    (
      (
        await call(world(), 'POST', '/community/bus-routes', {
          token: manager(),
          body: { nameEn: `Line ${++n}`, nameAr: 'خط' },
        }).expect(201)
      ).body as { id: string }
    ).id;
  /** A new album of A's with one photo, published or not. */
  const galleryPhoto = async (published: boolean) => {
    const albumId = (
      (
        await call(world(), 'POST', '/community/gallery/albums', {
          token: manager(),
          body: { titleEn: `Album ${++n}`, titleAr: 'ألبوم' },
        }).expect(201)
      ).body as { id: string }
    ).id;
    const res = await call(
      world(),
      'POST',
      `/community/gallery/albums/${albumId}/photos`,
      {
        token: manager(),
        body: {
          fileId: await fileHelpers(world().h).ready(
            manager(),
            'gallery_photo',
          ),
        },
      },
    );
    const photoId = (res.body as { id: string }).id;
    if (published)
      await call(
        world(),
        'POST',
        `/community/gallery/albums/${albumId}/publish`,
        {
          token: manager(),
        },
      ).expect(204);
    return { albumId, photoId, res };
  };
  /** A's landlord runs the shops these calls open, one at a time. */
  const shopOwner = () => world().a.tokens.landlord;
  const shop = () => ({
    nameEn: `Shop ${++n}`,
    nameAr: 'متجر',
    description: 'Things.',
    category: 'other',
  });
  /** A waiting shop of the landlord's: any open one closed first. */
  const opened = async (): Promise<string> => {
    await call(world(), 'POST', '/me/market/shop/close', {
      token: shopOwner(),
    });
    return (
      (
        await call(world(), 'POST', '/market/shops', {
          token: shopOwner(),
          body: shop(),
        }).expect(201)
      ).body as { id: string }
    ).id;
  };
  const live = async (): Promise<string> => {
    const id = await listed();
    await call(world(), 'POST', `/market/review/${id}/approve`, {
      token: manager(),
    }).expect(204);
    return id;
  };
  return {
    'POST /market/listings': () =>
      call(world(), 'POST', '/market/listings', {
        token: owner(),
        body: body(),
      }),
    'GET /market/listings': () =>
      call(world(), 'GET', '/market/listings', { token: owner() }),
    'GET /market/listings/{id}': async () =>
      call(world(), 'GET', `/market/listings/${await live()}`, {
        token: world().a.tokens.tenant,
      }),
    'PATCH /market/listings/{id}': async () =>
      call(world(), 'PATCH', `/market/listings/${await listed()}`, {
        token: owner(),
        body: { negotiable: true },
      }),
    'POST /market/listings/{id}/withdraw': async () =>
      call(world(), 'POST', `/market/listings/${await listed()}/withdraw`, {
        token: owner(),
      }),
    'POST /market/listings/{id}/sold': async () =>
      call(world(), 'POST', `/market/listings/${await live()}/sold`, {
        token: owner(),
      }),
    'POST /market/listings/{id}/conversations': async () =>
      call(world(), 'POST', `/market/listings/${await live()}/conversations`, {
        token: world().a.tokens.tenant,
        body: { body: 'Still for sale?' },
      }),
    'GET /me/market/listings': () =>
      call(world(), 'GET', '/me/market/listings', { token: owner() }),
    'GET /market/review': () =>
      call(world(), 'GET', '/market/review', { token: manager() }),
    'GET /market/review/{id}': async () =>
      call(world(), 'GET', `/market/review/${await listed()}`, {
        token: manager(),
      }),
    'POST /market/review/{id}/approve': async () =>
      call(world(), 'POST', `/market/review/${await listed()}/approve`, {
        token: manager(),
      }),
    'POST /market/review/{id}/reject': async () =>
      call(world(), 'POST', `/market/review/${await listed()}/reject`, {
        token: manager(),
        body: { reasonCode: 'incomplete' },
      }),
    'POST /market/review/{id}/remove': async () =>
      call(world(), 'POST', `/market/review/${await live()}/remove`, {
        token: manager(),
        body: { reasonCode: 'duplicate' },
      }),
    'POST /market/shops': async () => {
      await call(world(), 'POST', '/me/market/shop/close', {
        token: world().a.tokens.family,
      });
      return call(world(), 'POST', '/market/shops', {
        token: world().a.tokens.family,
        body: shop(),
      });
    },
    'GET /market/shops': () =>
      call(world(), 'GET', '/market/shops', { token: owner() }),
    // A waiting shop is its owner's alone to read.
    'GET /market/shops/{id}': async () =>
      call(world(), 'GET', `/market/shops/${await opened()}`, {
        token: shopOwner(),
      }),
    'GET /me/market/shop': async () => {
      await opened();
      return call(world(), 'GET', '/me/market/shop', { token: shopOwner() });
    },
    'POST /me/market/shop/close': async () => {
      await opened();
      return call(world(), 'POST', '/me/market/shop/close', {
        token: shopOwner(),
      });
    },
    'GET /market/shop-review': () =>
      call(world(), 'GET', '/market/shop-review', { token: manager() }),
    'POST /market/shop-review/{id}/approve': async () =>
      call(world(), 'POST', `/market/shop-review/${await opened()}/approve`, {
        token: manager(),
      }),
    'POST /market/shop-review/{id}/reject': async () =>
      call(world(), 'POST', `/market/shop-review/${await opened()}/reject`, {
        token: manager(),
        body: { reasonCode: 'incomplete' },
      }),
    'POST /market/shop-review/{id}/suspend': async () => {
      const id = await opened();
      await call(world(), 'POST', `/market/shop-review/${id}/approve`, {
        token: manager(),
      }).expect(204);
      return call(world(), 'POST', `/market/shop-review/${id}/suspend`, {
        token: manager(),
        body: { reasonCode: 'inactive' },
      });
    },
    'POST /market/listings/{id}/report': async () =>
      call(world(), 'POST', `/market/listings/${await live()}/report`, {
        token: world().a.tokens.tenant,
        body: { reasonCode: 'other' },
      }),
    'GET /market/reports': () =>
      call(world(), 'GET', '/market/reports', { token: manager() }),
    'POST /market/reports/{id}/close': async () => {
      const res = await call(
        world(),
        'POST',
        `/market/listings/${await live()}/report`,
        { token: world().a.tokens.tenant, body: { reasonCode: 'other' } },
      ).expect(201);
      return call(
        world(),
        'POST',
        `/market/reports/${(res.body as { id: string }).id}/close`,
        { token: manager(), body: { reasonCode: 'no_action' } },
      );
    },
    'POST /staff/partners/{id}/offers': () =>
      call(world(), 'POST', `/staff/partners/${world().aPartnerId}/offers`, {
        token: manager(),
        body: offer(),
      }),
    'GET /staff/partner-offers': () =>
      call(world(), 'GET', '/staff/partner-offers', { token: manager() }),
    'POST /staff/partner-offers/{id}/withdraw': async () => {
      const res = await call(
        world(),
        'POST',
        `/staff/partners/${world().aPartnerId}/offers`,
        { token: manager(), body: offer() },
      ).expect(201);
      return call(
        world(),
        'POST',
        `/staff/partner-offers/${(res.body as { id: string }).id}/withdraw`,
        { token: manager() },
      );
    },
    'GET /market/offers': () =>
      call(world(), 'GET', '/market/offers', { token: owner() }),
    'POST /staff/group-offers': () =>
      call(world(), 'POST', '/staff/group-offers', {
        token: manager(),
        body: group(),
      }),
    'GET /staff/group-offers': () =>
      call(world(), 'GET', '/staff/group-offers', { token: manager() }),
    'POST /staff/group-offers/{id}/open': async () =>
      call(world(), 'POST', `/staff/group-offers/${await grouped(true)}/open`, {
        token: manager(),
      }),
    'POST /staff/group-offers/{id}/cancel': async () =>
      call(world(), 'POST', `/staff/group-offers/${await grouped()}/cancel`, {
        token: manager(),
        body: { reasonCode: 'other' },
      }),
    'GET /market/group-offers': () =>
      call(world(), 'GET', '/market/group-offers', { token: owner() }),
    'GET /market/group-offers/{id}': async () =>
      call(world(), 'GET', `/market/group-offers/${await grouped()}`, {
        token: owner(),
      }),
    'POST /market/group-offers/{id}/interest': async () =>
      call(
        world(),
        'POST',
        `/market/group-offers/${await grouped(true)}/interest`,
        { token: owner(), body: { unitId: world().a.homeUnitId } },
      ),
    'POST /market/group-offers/{id}/join': async () =>
      call(world(), 'POST', `/market/group-offers/${await grouped()}/join`, {
        token: owner(),
        body: { unitId: world().a.homeUnitId, quantity: 1 },
      }),
    'POST /market/group-offers/{id}/leave': async () => {
      const id = await grouped();
      await call(world(), 'POST', `/market/group-offers/${id}/join`, {
        token: owner(),
        body: { unitId: world().a.homeUnitId, quantity: 1 },
      }).expect(201);
      return call(world(), 'POST', `/market/group-offers/${id}/leave`, {
        token: owner(),
      });
    },
    'GET /prayer-times': async () => {
      await call(world(), 'PATCH', '/community/prayer-settings', {
        token: manager(),
        body: { latitude: '30.044420', longitude: '31.235712' },
      }).expect(200);
      return call(world(), 'GET', '/prayer-times', { token: owner() });
    },
    'GET /community/prayer-settings': () =>
      call(world(), 'GET', '/community/prayer-settings', { token: manager() }),
    'PATCH /community/prayer-settings': () =>
      call(world(), 'PATCH', '/community/prayer-settings', {
        token: manager(),
        body: { latitude: '30.044420', longitude: '31.235712' },
      }),
    'GET /buses': () => call(world(), 'GET', '/buses', { token: owner() }),
    'GET /community/bus-routes': () =>
      call(world(), 'GET', '/community/bus-routes', { token: manager() }),
    'POST /community/bus-routes': () =>
      call(world(), 'POST', '/community/bus-routes', {
        token: manager(),
        body: { nameEn: `Line ${++n}`, nameAr: 'خط' },
      }),
    'PATCH /community/bus-routes/{id}': async () =>
      call(world(), 'PATCH', `/community/bus-routes/${await busRoute()}`, {
        token: manager(),
        body: { nameEn: 'Renamed' },
      }),
    'POST /community/bus-routes/{id}/departures': async () =>
      call(
        world(),
        'POST',
        `/community/bus-routes/${await busRoute()}/departures`,
        { token: manager(), body: departure() },
      ),
    'DELETE /community/bus-departures/{id}': async () => {
      const res = await call(
        world(),
        'POST',
        `/community/bus-routes/${await busRoute()}/departures`,
        { token: manager(), body: departure() },
      ).expect(201);
      return call(
        world(),
        'DELETE',
        `/community/bus-departures/${(res.body as { id: string }).id}`,
        { token: manager() },
      );
    },
    'GET /gallery/albums': () =>
      call(world(), 'GET', '/gallery/albums', { token: owner() }),
    'GET /gallery/albums/{id}': async () => {
      const { albumId } = await galleryPhoto(true);
      return call(world(), 'GET', `/gallery/albums/${albumId}`, {
        token: owner(),
      });
    },
    'POST /gallery/photos/{id}/report': async () => {
      const { photoId } = await galleryPhoto(true);
      return call(world(), 'POST', `/gallery/photos/${photoId}/report`, {
        token: owner(),
        body: { reasonCode: 'other' },
      });
    },
    'GET /community/gallery/albums': () =>
      call(world(), 'GET', '/community/gallery/albums', { token: manager() }),
    'POST /community/gallery/albums': () =>
      call(world(), 'POST', '/community/gallery/albums', {
        token: manager(),
        body: { titleEn: `Album ${++n}`, titleAr: 'ألبوم' },
      }),
    'POST /community/gallery/albums/{id}/photos': async () =>
      (await galleryPhoto(false)).res,
    'POST /community/gallery/albums/{id}/publish': async () => {
      const { albumId } = await galleryPhoto(false);
      return call(
        world(),
        'POST',
        `/community/gallery/albums/${albumId}/publish`,
        {
          token: manager(),
        },
      );
    },
    'POST /community/gallery/photos/{id}/hide': async () => {
      const { photoId } = await galleryPhoto(true);
      return call(
        world(),
        'POST',
        `/community/gallery/photos/${photoId}/hide`,
        {
          token: manager(),
          body: { reasonCode: 'other' },
        },
      );
    },
    'POST /community/gallery/photos/{id}/restore': async () => {
      const { photoId } = await galleryPhoto(true);
      return call(
        world(),
        'POST',
        `/community/gallery/photos/${photoId}/restore`,
        { token: manager() },
      );
    },
    'POST /visitor-passes/{id}/reinvite': async () => {
      const first = await call(
        world(),
        'POST',
        `/units/${world().a.homeUnitId}/visitor-passes`,
        {
          token: owner(),
          body: {
            kind: 'one_time',
            partySize: 1,
            validFrom: at(day(1), 10).toISOString(),
            validUntil: at(day(1), 12).toISOString(),
            visitorName: 'Again Visitor',
          },
        },
      ).expect(201);
      return call(
        world(),
        'POST',
        `/visitor-passes/${(first.body as { id: string }).id}/reinvite`,
        {
          token: owner(),
          body: {
            validFrom: at(day(2), 10).toISOString(),
            validUntil: at(day(2), 12).toISOString(),
          },
        },
      );
    },
    'GET /emergency-guides': () =>
      call(world(), 'GET', '/emergency-guides', { token: owner() }),
    'GET /market/settings': () =>
      call(world(), 'GET', '/market/settings', { token: manager() }),
    'PATCH /market/settings': () =>
      call(world(), 'PATCH', '/market/settings', {
        token: manager(),
        body: { maxLivePerAccount: 50 },
      }),
  };
}
