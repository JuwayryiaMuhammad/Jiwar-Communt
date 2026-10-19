import type { FieldError } from '../../core/common/errors';
import {
  checkGeofence,
  exitLasted,
  isOutside,
  metresOutside,
  walkExits,
  type Geofence,
} from './geofence';

// A square of about 222 m a side around a Cairo compound.
const SQUARE: [number, number][] = [
  [30.0, 31.0],
  [30.0, 31.0023],
  [30.002, 31.0023],
  [30.002, 31.0],
];
const square: Geofence = { polygon: SQUARE };
const circle: Geofence = { circle: { lat: 30.001, lng: 31.001, radiusM: 100 } };
const MINUTE = 60_000;
const T0 = new Date('2026-11-05T08:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

describe('geofence (ADR 0056)', () => {
  describe('checkGeofence', () => {
    const check = (input: { circle?: unknown; polygon?: unknown }) => {
      const fields: FieldError[] = [];
      return { fence: checkGeofence(input, fields, 'geofence'), fields };
    };

    it('a circle or a simple polygon, normalized', () => {
      expect(check({ circle: { lat: 30, lng: 31, radiusM: 50 } })).toEqual({
        fence: { circle: { lat: 30, lng: 31, radiusM: 50 } },
        fields: [],
      });
      expect(check({ polygon: SQUARE })).toEqual({
        fence: { polygon: SQUARE },
        fields: [],
      });
    });

    it('exactly one of them', () => {
      expect(check({}).fields).toEqual([
        { field: 'geofence.circle', code: 'FIELD_REQUIRED' },
      ]);
      expect(
        check({ circle: { lat: 30, lng: 31, radiusM: 50 }, polygon: SQUARE })
          .fields,
      ).toEqual([{ field: 'geofence.circle', code: 'FIELD_NOT_ALLOWED' }]);
    });

    it('a circle within its bounds', () => {
      expect(
        check({ circle: { lat: 91, lng: 181, radiusM: 9 } }).fields,
      ).toEqual([
        {
          field: 'geofence.circle.lat',
          code: 'INVALID_NUMBER',
          params: { min: -90, max: 90 },
        },
        {
          field: 'geofence.circle.lng',
          code: 'INVALID_NUMBER',
          params: { min: -180, max: 180 },
        },
        {
          field: 'geofence.circle.radiusM',
          code: 'INVALID_NUMBER',
          params: { min: 10, max: 5000 },
        },
      ]);
      expect(
        check({ circle: { lat: 30, lng: 31, radiusM: 50.5 } }).fields,
      ).toHaveLength(1);
    });

    it('a polygon of 3 to 50 well-formed vertices, its edges never crossing', () => {
      expect(check({ polygon: SQUARE.slice(0, 2) }).fields).toEqual([
        {
          field: 'geofence.polygon',
          code: 'INVALID_LENGTH',
          params: { min: 3, max: 50 },
        },
      ]);
      expect(
        check({
          polygon: Array.from({ length: 51 }, (_, i) => [
            30 + Math.sin(i) / 1000,
            31 + Math.cos(i) / 1000,
          ]),
        }).fields[0].code,
      ).toBe('INVALID_LENGTH');
      expect(check({ polygon: [[30, 31], [30, 31.1], [30.1]] }).fields).toEqual(
        [{ field: 'geofence.polygon', code: 'INVALID_FORMAT' }],
      );
      // A bow tie: two edges cross.
      const bowTie = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]];
      expect(check({ polygon: bowTie }).fields).toEqual([
        { field: 'geofence.polygon', code: 'INVALID_VALUE' },
      ]);
      // No area: three points on a line.
      expect(
        check({
          polygon: [
            [30, 31],
            [30.001, 31.001],
            [30.002, 31.002],
          ],
        }).fields,
      ).toEqual([{ field: 'geofence.polygon', code: 'INVALID_VALUE' }]);
    });
  });

  describe('metresOutside and isOutside', () => {
    it('a circle: inside is 0, outside its distance past the radius', () => {
      expect(metresOutside(circle, { lat: 30.001, lng: 31.001 })).toBe(0);
      // About 111 m north of the centre: 11 m past the radius.
      const north = metresOutside(circle, { lat: 30.002, lng: 31.001 });
      expect(north).toBeGreaterThanOrEqual(10);
      expect(north).toBeLessThanOrEqual(12);
    });

    it('a polygon: inside or on an edge is 0, outside the distance to the nearest edge', () => {
      expect(metresOutside(square, { lat: 30.001, lng: 31.001 })).toBe(0);
      expect(metresOutside(square, { lat: 30.0, lng: 31.001 })).toBe(0);
      // About 111 m south of the bottom edge.
      const south = metresOutside(square, { lat: 29.999, lng: 31.001 });
      expect(south).toBeGreaterThanOrEqual(110);
      expect(south).toBeLessThanOrEqual(112);
    });

    it('outside only past its accuracy; too imprecise says nothing', () => {
      const p = { lat: 30.002, lng: 31.001 };
      expect(isOutside(circle, { ...p, accuracyM: null })).toBe(true);
      expect(isOutside(circle, { ...p, accuracyM: 20 })).toBe(false);
      expect(isOutside(circle, { ...p, accuracyM: 101 })).toBeNull();
    });
  });

  describe('walkExits', () => {
    const out = (m: number) => ({ at: at(m), outside: true });
    const inn = (m: number) => ({ at: at(m), outside: false });
    const vague = (m: number) => ({ at: at(m), outside: null });

    it('an outside point opens an exit, the next inside closes it; vague points pass', () => {
      expect(
        walkExits(null, [inn(0), out(1), vague(2), out(3), inn(5), out(6)]),
      ).toEqual([
        { leftAt: at(1), backAt: at(5), lastOutsideAt: at(3) },
        { leftAt: at(6), backAt: null, lastOutsideAt: at(6) },
      ]);
    });

    it('continues the open exit it was left with', () => {
      expect(walkExits({ leftAt: at(0) }, [out(2), inn(4)])).toEqual([
        { leftAt: at(0), backAt: at(4), lastOutsideAt: at(2) },
      ]);
      expect(walkExits({ leftAt: at(0) }, [vague(2)])).toEqual([
        { leftAt: at(0), backAt: null, lastOutsideAt: at(0) },
      ]);
      expect(walkExits(null, [inn(1), vague(2)])).toEqual([]);
    });

    it('lasted: to its return, else to its latest point outside', () => {
      const t = 3 * MINUTE;
      expect(
        exitLasted({ leftAt: at(0), backAt: at(3), lastOutsideAt: at(1) }, t),
      ).toBe(true);
      expect(
        exitLasted(
          { leftAt: at(0), backAt: at(2.99), lastOutsideAt: at(2) },
          t,
        ),
      ).toBe(false);
      expect(
        exitLasted({ leftAt: at(0), backAt: null, lastOutsideAt: at(3) }, t),
      ).toBe(true);
      expect(
        exitLasted({ leftAt: at(0), backAt: null, lastOutsideAt: at(2) }, t),
      ).toBe(false);
    });
  });
});
