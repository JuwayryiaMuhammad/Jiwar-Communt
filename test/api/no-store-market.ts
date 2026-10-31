import type { Response } from 'supertest';
import { day } from '../setup/compound-clock';
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
    'GET /market/settings': () =>
      call(world(), 'GET', '/market/settings', { token: manager() }),
    'PATCH /market/settings': () =>
      call(world(), 'PATCH', '/market/settings', {
        token: manager(),
        body: { maxLivePerAccount: 50 },
      }),
  };
}
