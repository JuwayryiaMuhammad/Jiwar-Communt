import { plainToInstance } from 'class-transformer';
import { IsDate, IsOptional, validate } from 'class-validator';
import { instantOf, IsInstant, ToInstant } from './instant';
import { toFieldErrors } from './validation-errors';

class Window {
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @IsOptional()
  @ToInstant()
  @IsDate()
  endsAt?: Date;

  @IsOptional()
  @IsInstant()
  since?: string;
}

async function check(plain: object) {
  const dto = plainToInstance(Window, plain);
  return { dto, fields: toFieldErrors(await validate(dto)) };
}

describe('instants', () => {
  it('takes a date-time with Z or an offset, as the instant it names', async () => {
    for (const [text, iso] of [
      ['2026-10-22T19:00:00Z', '2026-10-22T19:00:00.000Z'],
      ['2026-10-22T22:00:00+03:00', '2026-10-22T19:00:00.000Z'],
      ['2026-10-22T22:00+03:00', '2026-10-22T19:00:00.000Z'],
      ['2026-10-22T19:00:00.123z', '2026-10-22T19:00:00.123Z'],
      ['2026-10-22T14:00:00-05:00', '2026-10-22T19:00:00.000Z'],
      // The edges of a day and of the offsets RFC 3339 writes.
      ['2026-10-22T23:59:59.999999999Z', '2026-10-22T23:59:59.999Z'],
      ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
      ['2026-10-22T10:00+14:00', '2026-10-21T20:00:00.000Z'],
    ]) {
      const { dto, fields } = await check({ startsAt: text, since: text });
      expect(fields).toEqual([]);
      expect(dto.startsAt.toISOString()).toBe(iso);
    }
  });

  it('refuses a time without an offset, a date alone, a number or nonsense: INVALID_FORMAT', async () => {
    for (const bad of [
      '2026-10-22T22:00:00',
      '2026-10-22T22:00',
      '2026-10-22',
      '2026-10-22 22:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-10-22T22:00:00+0300',
      1_792_000_000_000,
      'soon',
    ]) {
      const { fields } = await check({ startsAt: bad, since: bad });
      expect(fields).toEqual([
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        { field: 'since', code: 'INVALID_FORMAT' },
      ]);
    }
  });

  it('refuses a day or a time that does not exist, which Date.parse would roll over: INVALID_FORMAT', async () => {
    for (const bad of [
      // A day shaped right that is none: Date.parse gives 2 March, 1 May…
      '2099-02-30T08:00Z',
      '2026-04-31T10:00:00+03:00',
      '2027-02-29T00:00:00Z',
      // …or the next day for T24:00.
      '2026-10-22T24:00Z',
      '2026-10-22T10:60Z',
      '2026-10-22T10:00:60Z',
      // An offset beyond RFC 3339's hours or minutes.
      '2026-10-22T10:00+25:00',
      '2026-10-22T10:00-03:60',
    ]) {
      const { fields } = await check({ startsAt: bad, since: bad });
      expect(fields).toEqual([
        { field: 'startsAt', code: 'INVALID_FORMAT' },
        { field: 'since', code: 'INVALID_FORMAT' },
      ]);
      expect(instantOf(bad)).toBeNull();
    }
  });

  it('leaves an optional field out', async () => {
    const { dto, fields } = await check({ startsAt: '2026-10-22T19:00:00Z' });
    expect(fields).toEqual([]);
    expect(dto.endsAt).toBeUndefined();
  });
});
