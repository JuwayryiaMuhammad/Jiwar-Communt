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
 * A real call for each no-store route of ADR 0070's waitlist, in compound A:
 * a court of one booking a slot that A's owner fills, and A's tenant waits
 * for — and, for the claim, is offered when the owner cancels.
 */
export function waitlistCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const w = () => world();
  const as = (
    persona: 'owner' | 'tenant' | 'manager',
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: object,
  ) => call(w(), method, path, { token: w().a.tokens[persona], body });
  const id = (res: Response) => (res.body as { id: string }).id;
  let courtId: Promise<string> | null = null;
  const court = () =>
    (courtId ??= (async () => {
      const res = await as('manager', 'POST', '/staff/facilities', {
        mode: 'bookable',
        nameEn: 'No-store waitlist court',
        nameAr: 'ملعب',
        slotMinutes: 60,
        capacity: 1,
        weeklyQuota: 20,
      }).expect(201);
      await as('manager', 'PUT', `/staff/facilities/${id(res)}/hours`, {
        windows: ALL_WEEK,
      }).expect(200);
      return id(res);
    })());
  let hour = 7;
  /** A slot of the court the owner fills: its booking and its start. */
  const full = async () => {
    const startsAt = at(day(6), hour++);
    const res = await as(
      'owner',
      'POST',
      `/units/${w().a.homeUnitId}/bookings`,
      { facilityId: await court(), startsAt: startsAt.toISOString() },
    ).expect(201);
    return { bookingId: id(res), startsAt };
  };
  const join = (facilityId: string, startsAt: Date) =>
    as('tenant', 'POST', `/facilities/${facilityId}/waitlist`, {
      unitId: w().a.rentedUnitId,
      startsAt: startsAt.toISOString(),
    });
  return {
    'POST /facilities/{id}/waitlist': async () =>
      join(await court(), (await full()).startsAt),
    'GET /me/waitlist': () => as('tenant', 'GET', '/me/waitlist'),
    'POST /booking-waitlist/{id}/leave': async () => {
      const { startsAt } = await full();
      const entry = id(await join(await court(), startsAt).expect(201));
      return as('tenant', 'POST', `/booking-waitlist/${entry}/leave`);
    },
    'POST /booking-waitlist/{id}/claim': async () => {
      const slot = await full();
      const entry = id(await join(await court(), slot.startsAt).expect(201));
      await as('owner', 'POST', `/bookings/${slot.bookingId}/cancel`, {
        reasonCode: 'no_longer_needed',
      }).expect(204);
      return as('tenant', 'POST', `/booking-waitlist/${entry}/claim`);
    },
  };
}
