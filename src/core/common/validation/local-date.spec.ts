import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, validate, ValidateIf } from 'class-validator';
import { IsLocalDate, isRealDate } from './local-date';
import { toFieldErrors } from './validation-errors';

class Window {
  @IsString()
  @IsLocalDate()
  startsOn: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @IsLocalDate()
  endsOn?: string | null;
}

async function check(plain: object) {
  return toFieldErrors(await validate(plainToInstance(Window, plain)));
}

describe('local dates', () => {
  it('takes a day that exists, 29 February of a leap year too', async () => {
    for (const day of ['2026-10-29', '2028-02-29', '2026-12-31', '2026-01-01'])
      expect(await check({ startsOn: day, endsOn: day })).toEqual([]);
  });

  it('refuses a day shaped right that does not exist: INVALID_FORMAT', async () => {
    for (const day of ['2026-02-30', '2026-02-29', '2026-04-31', '2100-02-29'])
      expect(await check({ startsOn: day, endsOn: day })).toEqual([
        { field: 'startsOn', code: 'INVALID_FORMAT' },
        { field: 'endsOn', code: 'INVALID_FORMAT' },
      ]);
  });

  it('refuses what is not shaped as a day: INVALID_FORMAT', async () => {
    for (const bad of [
      '2026-13-01',
      '2026-1-1',
      '2026-10-29T00:00:00Z',
      'soon',
    ])
      expect(await check({ startsOn: bad })).toEqual([
        { field: 'startsOn', code: 'INVALID_FORMAT' },
      ]);
  });

  it('reports a non-string as its type, and leaves null or nothing alone', async () => {
    expect(await check({ startsOn: 20261029 })).toEqual([
      { field: 'startsOn', code: 'INVALID_TYPE' },
    ]);
    expect(await check({ startsOn: '2026-10-29', endsOn: null })).toEqual([]);
    expect(await check({ startsOn: '2026-10-29' })).toEqual([]);
  });

  it('isRealDate agrees, and refuses what is not a string', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate(undefined)).toBe(false);
    expect(isRealDate(20261029)).toBe(false);
  });
});
