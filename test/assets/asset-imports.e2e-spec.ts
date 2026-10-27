import { err } from '../api/request';
import { fileHelpers } from '../setup/files';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { uniqueSuffix } from '../setup/fixtures';
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
 * ADR 0064: an asset sheet, checked whole and applied once, every row or
 * none. Problems name a line, a column and a code, never what the cell
 * held; a sheet that is not clean CSV leaves nothing behind.
 */
describe('Assets — imports', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(0);
  }, 90_000);

  afterAll(() => h.close());

  const files = () => fileHelpers(h);
  async function sheet(
    text: string | Buffer,
    token = s.manager.token,
  ): Promise<string> {
    const body = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
    const id = await files().uploaded(token, 'data_import', 'text/csv', body);
    await files().finalize(token, id).expect(200);
    return id;
  }
  const check = (fileId: string) =>
    a.http('post', '/maintenance/asset-imports', s.manager.token, { fileId });
  const apply = (id: string) =>
    a.http('post', `/maintenance/asset-imports/${id}/apply`, s.manager.token);
  const unitCode = async () =>
    (
      await a.inTenant(s.c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: s.unit.id } }),
      )
    ).code;

  it('a valid sheet applies once: roots, parts under earlier rows, each event `imported`', async () => {
    const room = await a.area(s);
    const p = `IMP-${uniqueSuffix()}`;
    const text = [
      '﻿code,type,name_ar,name_en,area,unit,parent,commissioned_on,serves_buildings',
      `${p}-1,pump,مضخة,Pump 1,${room.code},,,2021-03-01,${s.building}`,
      `${p}-1a,pump,محرك,Motor,,,${p}-1,,`,
      `${p}-2,generator,مولد,Generator,,${await unitCode()},,,`,
    ].join('\r\n');
    const checked = (await check(await sheet(text)).expect(201)).body as Import;
    expect(checked).toMatchObject({
      status: 'valid',
      rowCount: 3,
      errorCount: 0,
      errors: [],
    });
    const applied = (await apply(checked.id).expect(201)).body as Import;
    expect(applied).toMatchObject({ status: 'applied', appliedCount: 3 });
    await apply(checked.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'ASSET_IMPORT_NOT_VALID',
          params: { status: 'applied' },
        }),
      );
    const rows = await a.inTenant(s.c, (tx) =>
      tx.asset.findMany({
        where: { code: { startsWith: p } },
        orderBy: { code: 'asc' },
      }),
    );
    expect(
      rows.map((r) => [r.code, r.depth, r.commonAreaId, r.unitId]),
    ).toEqual([
      [`${p}-1`, 1, room.id, null],
      [`${p}-1a`, 2, room.id, null],
      [`${p}-2`, 1, null, s.unit.id],
    ]);
    expect(rows[1].parentId).toBe(rows[0].id);
    const events = await a.inTenant(s.c, (tx) =>
      tx.assetEvent.findMany({
        where: { assetId: { in: rows.map((r) => r.id) } },
      }),
    );
    expect(events.map((e) => e.kind)).toEqual([
      'imported',
      'imported',
      'imported',
    ]);
  });

  it('an invalid sheet keeps its problems by line and column, never the text, and is never applied', async () => {
    const text = [
      'code,type,name_ar,name_en,area',
      'SECRET-CELL!,boiler,اسم,Name,NOPE',
    ].join('\n');
    const checked = (await check(await sheet(text)).expect(201)).body as Import;
    expect(checked).toMatchObject({
      status: 'invalid',
      errorCount: 3,
      errors: [
        { line: 2, field: 'code', code: 'INVALID_FORMAT' },
        { line: 2, field: 'type', code: 'ASSET_TYPE_NOT_AVAILABLE' },
        { line: 2, field: 'area', code: 'COMMON_AREA_NOT_AVAILABLE' },
      ],
    });
    expect(JSON.stringify(checked)).not.toMatch(/SECRET|boiler|NOPE/);
    await apply(checked.id)
      .expect(409)
      .expect((r) => expect(err(r).params).toEqual({ status: 'invalid' }));
  });

  it('a sheet that is not clean CSV is refused whole and leaves no import', async () => {
    const before = await a.inTenant(s.c, (tx) => tx.assetImport.count());
    await check(
      await sheet(
        Buffer.concat([Buffer.from('code,type\n'), Buffer.from([0xc3, 0x28])]),
      ),
    )
      .expect(422)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'ASSET_IMPORT_UNREADABLE',
          params: { problem: 'not_utf8' },
        }),
      );
    await check(await sheet('code,type,name_ar,name_en\n"open,pump,a,b'))
      .expect(422)
      .expect((r) =>
        expect(err(r).params).toEqual({
          problem: 'unterminated_quote',
          line: 2,
        }),
      );
    expect(await a.inTenant(s.c, (tx) => tx.assetImport.count())).toBe(before);
  });

  it('what changed since the check makes it invalid at apply, and creates nothing', async () => {
    const room = await a.area(s);
    const code = `IMP-${uniqueSuffix()}`;
    const checked = (
      await check(
        await sheet(
          `code,type,name_ar,name_en,area\n${code},pump,مضخة,Pump,${room.code}\n`,
        ),
      ).expect(201)
    ).body as Import;
    expect(checked.status).toBe('valid');
    await a
      .http('patch', `/maintenance/areas/${room.id}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    const applied = (await apply(checked.id).expect(201)).body as Import;
    expect(applied).toMatchObject({
      status: 'invalid',
      appliedCount: null,
      errors: [{ line: 2, field: 'area', code: 'COMMON_AREA_NOT_AVAILABLE' }],
    });
    expect(
      await a.inTenant(s.c, (tx) => tx.asset.count({ where: { code } })),
    ).toBe(0);
  });

  it('two applies at once: one applies, the other is told it is no longer valid', async () => {
    for (let round = 0; round < 3; round++) {
      const room = await a.area(s);
      const code = `IMP-${uniqueSuffix()}`;
      const checked = (
        await check(
          await sheet(
            `code,type,name_ar,name_en,area\n${code},pump,مضخة,Pump,${room.code}\n`,
          ),
        ).expect(201)
      ).body as Import;
      const results = await Promise.all([apply(checked.id), apply(checked.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await a.inTenant(s.c, (tx) => tx.asset.count({ where: { code } })),
      ).toBe(1);
    }
  });

  it('a file of another purpose, another’s file, or one already used is not available', async () => {
    const photo = await files().ready(s.manager.token, 'community_attachment');
    await a
      .http('post', '/maintenance/asset-imports', s.manager.token, {
        fileId: photo,
      })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'fileId', code: 'FILE_NOT_AVAILABLE' },
        ]),
      );
    const used = await sheet('code,type,name_ar,name_en\n');
    await a
      .http('post', '/maintenance/asset-imports', s.manager.token, {
        fileId: used,
      })
      .expect(201);
    await a
      .http('post', '/maintenance/asset-imports', s.manager.token, {
        fileId: used,
      })
      .expect(400);
    // The supervisor keeps the register too.
    await a
      .http('post', '/maintenance/asset-imports', s.supervisor.token, {
        fileId: await sheet('code\n', s.supervisor.token),
      })
      .expect(201);
  });
});
