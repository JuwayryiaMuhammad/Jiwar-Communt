import type { Response } from 'supertest';
import { day } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/** A real call for the no-store route of ADR 0070's guest rooms: A's owner books a night. */
export function stayCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  return {
    'POST /units/{unitId}/stays': async () => {
      const w = world();
      const room = await call(w, 'POST', '/staff/facilities', {
        token: w.a.tokens.manager,
        body: {
          mode: 'stay',
          nameEn: 'No-store guest room',
          nameAr: 'غرفة ضيوف',
          capacity: 1,
          checkInTime: '14:00',
          checkOutTime: '12:00',
          weeklyQuota: 20,
        },
      }).expect(201);
      return call(w, 'POST', `/units/${w.a.homeUnitId}/stays`, {
        token: w.a.tokens.owner,
        body: {
          facilityId: (room.body as { id: string }).id,
          fromOn: day(8),
          toOn: day(9),
        },
      });
    },
  };
}
