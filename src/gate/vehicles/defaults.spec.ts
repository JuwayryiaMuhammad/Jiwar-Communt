import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VEHICLE_SETTING_RANGES } from './defaults';

const migration = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261023090300_vehicles/migration.sql',
  ),
  'utf8',
);
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('vehicle settings (ADR 0045)', () => {
  it('each setting has the default and the range of its column', () => {
    for (const [name, range] of Object.entries(VEHICLE_SETTING_RANGES)) {
      const column = snake(name);
      expect(migration).toContain(
        `"${column}" INTEGER NOT NULL DEFAULT ${range.default}`,
      );
      expect(migration).toContain(
        `"${column}" BETWEEN ${range.min} AND ${range.max}`,
      );
    }
  });

  it('four vehicles per unit, visitor parking of twelve hours, three bookings at once', () => {
    expect(VEHICLE_SETTING_RANGES.maxVehiclesPerUnit.default).toBe(4);
    expect(VEHICLE_SETTING_RANGES.visitorParkingMaxHours.default).toBe(12);
    expect(VEHICLE_SETTING_RANGES.maxActiveVisitorParkingBookings.default).toBe(
      3,
    );
  });
});
