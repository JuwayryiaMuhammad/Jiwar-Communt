import type { Response } from 'supertest';
import { at, day } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 360,
  endMinute: 1320,
}));

/**
 * A real call for each no-store route of ADR 0070's companions, in compound
 * A: a hall of one booking a slot with room for guests, where A's owner books
 * and A's family member comes along, and A's tenant joins by the link.
 */
export function companionCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const w = () => world();
  const as = (
    persona: 'owner' | 'family' | 'tenant' | 'manager',
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: object,
  ) => call(w(), method, path, { token: w().a.tokens[persona], body });
  const id = (res: Response) => (res.body as { id: string }).id;

  let hallId: Promise<string> | null = null;
  const hall = () =>
    (hallId ??= (async () => {
      const res = await as('manager', 'POST', '/staff/facilities', {
        mode: 'bookable',
        nameEn: 'No-store companions hall',
        nameAr: 'قاعة',
        slotMinutes: 60,
        capacity: 1,
        maxGuests: 3,
        weeklyQuota: 20,
      }).expect(201);
      await call(w(), 'PUT', `/staff/facilities/${id(res)}/hours`, {
        token: w().a.tokens.manager,
        body: { windows: ALL_WEEK },
      }).expect(200);
      return id(res);
    })());
  let hour = 7;
  /** A new booking of the hall by A's owner, each its own slot. */
  const booking = async (startsAt = at(day(5), hour++)) =>
    id(
      await as('owner', 'POST', `/units/${w().a.homeUnitId}/bookings`, {
        facilityId: await hall(),
        startsAt: startsAt.toISOString(),
      }).expect(201),
    );
  /** The family member invited to a new booking: the booking and the place. */
  const invited = async () => {
    const b = await booking();
    const res = await as('owner', 'POST', `/bookings/${b}/companions`, {
      memberId: w().a.familyMemberId,
    }).expect(201);
    return {
      bookingId: b,
      companionId: (res.body as { companion: { id: string } }).companion.id,
    };
  };
  let shared: Promise<{ bookingId: string; token: string }> | null = null;
  const link = () =>
    (shared ??= (async () => {
      const b = await booking();
      const res = await as('owner', 'POST', `/bookings/${b}/share-link`).expect(
        201,
      );
      return { bookingId: b, token: (res.body as { token: string }).token };
    })());
  return {
    'POST /bookings/{id}/companions': async () =>
      as('owner', 'POST', `/bookings/${await booking()}/companions`, {
        memberId: w().a.familyMemberId,
      }),
    'GET /bookings/{id}/companions': async () =>
      as('owner', 'GET', `/bookings/${(await link()).bookingId}/companions`),
    'POST /bookings/{id}/share-link': async () =>
      as('owner', 'POST', `/bookings/${await booking()}/share-link`),
    'DELETE /bookings/{id}/companions/{companionId}': async () => {
      const p = await invited();
      return call(
        w(),
        'DELETE',
        `/bookings/${p.bookingId}/companions/${p.companionId}`,
        { token: w().a.tokens.owner, query: { reasonCode: 'other' } },
      );
    },
    'POST /bookings/{id}/companions/me/leave': async () => {
      const p = await invited();
      await as(
        'family',
        'POST',
        `/me/companion-bookings/${p.companionId}/accept`,
      ).expect(200);
      return as(
        'family',
        'POST',
        `/bookings/${p.bookingId}/companions/me/leave`,
      );
    },
    'POST /booking-invites/preview': async () =>
      as('tenant', 'POST', '/booking-invites/preview', {
        token: (await link()).token,
      }),
    'POST /booking-invites/accept': async () =>
      as('tenant', 'POST', '/booking-invites/accept', {
        token: (await link()).token,
      }),
    'GET /me/companion-bookings': () =>
      as('family', 'GET', '/me/companion-bookings'),
    'POST /me/companion-bookings/{companionId}/accept': async () =>
      as(
        'family',
        'POST',
        `/me/companion-bookings/${(await invited()).companionId}/accept`,
      ),
    'POST /me/companion-bookings/{companionId}/decline': async () =>
      as(
        'family',
        'POST',
        `/me/companion-bookings/${(await invited()).companionId}/decline`,
      ),
  };
}
