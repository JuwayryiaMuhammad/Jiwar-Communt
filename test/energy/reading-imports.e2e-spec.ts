import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import {
  energyHelpers,
  type EnergySetUp,
  type MeterRead,
} from '../setup/energy';
import { fileHelpers } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Import = {
  id: string;
  status: 'valid' | 'invalid' | 'applied';
  rowCount: number;
  errorCount: number;
  errors: { line: number; field: string; code: string }[];
  appliedCount: number | null;
};

/**
 * ADR 0066: a sheet of meter readings, checked whole against the meters
 * and their live readings, applied once under the meters' FOR UPDATE —
 * every row or none. Problems name a line, a column and a code.
 */
describe('Energy — reading imports', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let s: EnergySetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    s = await e.setUp(0);
  }, 90_000);

  afterAll(() => h.close());

  const files = () => fileHelpers(h);
  async function sheet(lines: string[], token = s.manager.token) {
    const id = await files().uploaded(
      token,
      'data_import',
      'text/csv',
      Buffer.from(lines.join('\r\n'), 'utf8'),
    );
    await files().finalize(token, id).expect(200);
    return id;
  }
  const check = async (lines: string[]) =>
    (
      await e
        .http('post', '/maintenance/meter-reading-imports', s.manager.token, {
          fileId: await sheet(lines),
        })
        .expect(201)
    ).body as Import;
  const apply = (id: string) =>
    e.http(
      'post',
      `/maintenance/meter-reading-imports/${id}/apply`,
      s.manager.token,
    );
  const post = (m: MeterRead, readOn: string, value: string) =>
    e.http('post', `/maintenance/meters/${m.id}/readings`, s.manager.token, {
      readOn,
      value,
    });
  const live = async (m: MeterRead) =>
    (
      (
        await e
          .http('get', `/maintenance/meters/${m.id}/readings`, s.manager.token)
          .expect(200)
      ).body as { data: { readOn: string; value: string; source: string }[] }
    ).data;

  it('a valid sheet applies once: every row a reading of its meter, by import', async () => {
    const a = await e.meter(s);
    const b = await e.meter(s, { kind: 'electricity' });
    const checked = await check([
      '﻿meter,read_on,value,reset',
      `${a.code},${day(-20)},100,`,
      `${a.code},${day(-10)},150,no`,
      `${b.code},${day(-5)},7,yes`,
    ]);
    expect(checked).toMatchObject({
      status: 'valid',
      rowCount: 3,
      errorCount: 0,
      errors: [],
    });
    const applied = (await apply(checked.id).expect(200)).body as Import;
    expect(applied).toMatchObject({ status: 'applied', appliedCount: 3 });
    expect(err(await apply(checked.id).expect(409))).toMatchObject({
      code: 'METER_READING_IMPORT_NOT_VALID',
      params: { status: 'applied' },
    });
    expect((await live(a)).map((r) => [r.readOn, r.value, r.source])).toEqual([
      [day(-10), '150.0000', 'import'],
      [day(-20), '100.0000', 'import'],
    ]);
  });

  it('problems by line and column, never the cell: meters, days, values, the day taken, the register’s order', async () => {
    const m = await e.meter(s);
    await post(m, day(-20), '100').expect(201);
    await post(m, day(-10), '150').expect(201);
    const retired = await e.meter(s);
    await e
      .http(
        'post',
        `/maintenance/meters/${retired.id}/retire`,
        s.manager.token,
        { reasonCode: 'removed' },
      )
      .expect(200);
    const checked = await check([
      'meter,read_on,value',
      `NO-SUCH-METER,${day(-3)},1`,
      `${retired.code},${day(-3)},1`,
      `${m.code},2026-02-30,1`,
      `${m.code},${day(1)},1`,
      `${m.code},${day(-4)},abc`,
      `${m.code},${day(-10)},160`,
      `${m.code},${day(-15)},90`,
      `${m.code},${day(-12)},155`,
      `${m.code},${day(-5)},200`,
      `${m.code},${day(-5)},210`,
    ]);
    expect(checked.status).toBe('invalid');
    expect(checked.errors).toEqual([
      { line: 2, field: 'meter', code: 'METER_NOT_AVAILABLE' },
      { line: 3, field: 'meter', code: 'METER_NOT_AVAILABLE' },
      { line: 4, field: 'read_on', code: 'INVALID_FORMAT' },
      { line: 5, field: 'read_on', code: 'INVALID_VALUE' },
      { line: 6, field: 'value', code: 'INVALID_FORMAT' },
      { line: 7, field: 'read_on', code: 'READING_EXISTS' },
      { line: 8, field: 'value', code: 'READING_BELOW_PREVIOUS' },
      { line: 9, field: 'value', code: 'READING_ABOVE_NEXT' },
      { line: 11, field: 'read_on', code: 'DUPLICATE_VALUE' },
    ]);
    expect(JSON.stringify(checked)).not.toContain('NO-SUCH-METER');
    expect(err(await apply(checked.id).expect(409)).code).toBe(
      'METER_READING_IMPORT_NOT_VALID',
    );
  });

  it('a header it does not know, or one it lacks; a sheet that is not CSV leaves nothing', async () => {
    expect((await check(['meter,value,colour', 'X,1,red'])).errors).toEqual([
      { line: 1, field: 'colour', code: 'FIELD_NOT_ALLOWED' },
      { line: 1, field: 'read_on', code: 'FIELD_REQUIRED' },
    ]);
    const bad = await sheet(['meter,read_on,value', '"unterminated,1,1']);
    expect(
      err(
        await e
          .http('post', '/maintenance/meter-reading-imports', s.manager.token, {
            fileId: bad,
          })
          .expect(422),
      ),
    ).toMatchObject({
      code: 'METER_READING_IMPORT_UNREADABLE',
      params: { problem: 'unterminated_quote' },
    });
  });

  it('what changed since the check turns it invalid at the apply, and nothing is written', async () => {
    const m = await e.meter(s);
    const checked = await check([
      'meter,read_on,value',
      `${m.code},${day(-9)},10`,
      `${m.code},${day(-3)},20`,
    ]);
    expect(checked.status).toBe('valid');
    await post(m, day(-3), '25').expect(201);
    expect((await apply(checked.id).expect(200)).body).toMatchObject({
      status: 'invalid',
      errors: [{ line: 3, field: 'read_on', code: 'READING_EXISTS' }],
    });
    expect(await live(m)).toHaveLength(1);
  });

  describe('races', () => {
    it('one import applied twice at once: applied once', async () => {
      for (let round = 0; round < 3; round++) {
        const m = await e.meter(s);
        const checked = await check([
          'meter,read_on,value',
          `${m.code},${day(-2)},5`,
        ]);
        const results = await Promise.all([
          apply(checked.id),
          apply(checked.id),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await live(m)).toHaveLength(1);
      }
    });

    it('an import racing a reading of its meter and day: one lands, the other is told', async () => {
      for (let round = 0; round < 3; round++) {
        const m = await e.meter(s);
        const checked = await check([
          'meter,read_on,value',
          `${m.code},${day(-2)},5`,
        ]);
        const [applied, manual] = await Promise.all([
          apply(checked.id),
          post(m, day(-2), '6'),
        ]);
        expect(applied.status).toBe(200);
        const status = (applied.body as Import).status;
        if (status === 'applied') {
          expect(manual.status).toBe(409);
          expect(err(manual).code).toBe('READING_EXISTS');
        } else {
          expect(status).toBe('invalid');
          expect(manual.status).toBe(201);
        }
        expect(await live(m)).toHaveLength(1);
      }
    });
  });
});
