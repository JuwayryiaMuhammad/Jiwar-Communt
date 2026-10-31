import type { Response } from 'supertest';
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
    'GET /market/settings': () =>
      call(world(), 'GET', '/market/settings', { token: manager() }),
    'PATCH /market/settings': () =>
      call(world(), 'PATCH', '/market/settings', {
        token: manager(),
        body: { maxLivePerAccount: 50 },
      }),
  };
}
