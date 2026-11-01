import { GlobalDbService } from '../../src/core/database/global-db.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { UNIT_IMPORTS_SWEEP } from '../../src/community/units/unit-imports.service';
import { err } from '../api/request';
import type { Compound } from '../setup/community';
import { daysLater } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { nationalIdFor, uniquePhone, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  type HttpHarness,
} from '../setup/http-app';
import { unitsHelpers, type Who } from '../setup/units';

type Import = {
  id: string;
  kind: 'units' | 'residents';
  status: 'valid' | 'invalid' | 'applied' | 'expired';
  rowCount: number;
  errorCount: number;
  errors: { line: number; field: string; code: string }[];
  appliedCount: number | null;
};

const RESIDENT_HEADER =
  'full_name,phone,email,id_document_type,id_document_number,unit,occupancy_type,resides';

/**
 * ADR 0072: sheets of units and of residents, checked whole and applied
 * once, every row or none, as asset sheets are (ADR 0064). A residents
 * sheet's file is let go once the import can no longer be applied, and no
 * email goes to anyone imported.
 */
describe('Unit register — imports', () => {
  let h: HttpHarness;
  let u: ReturnType<typeof unitsHelpers>;
  let c: Compound;
  let manager: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    u = unitsHelpers(h);
    ({ c, manager } = await u.setUp('Import Court'));
  }, 90_000);

  afterAll(() => h.close());

  const files = () => fileHelpers(h);
  async function sheet(text: string): Promise<string> {
    const body = Buffer.from(text, 'utf8');
    const id = await files().uploaded(
      manager.token,
      'data_import',
      'text/csv',
      body,
    );
    await files().finalize(manager.token, id).expect(200);
    return id;
  }
  /** Uploads the sheet, then checks it: `check(kind, text).expect(status)`. */
  const check = (kind: 'units' | 'residents', text: string) => ({
    expect: async (status: number) =>
      u
        .http('post', '/staff/unit-imports', manager.token, {
          kind,
          fileId: await sheet(text),
        })
        .expect(status),
  });
  const apply = (id: string) =>
    u.http('post', `/staff/unit-imports/${id}/apply`, manager.token);
  const stored = (id: string) =>
    u.x.asManager(c, () =>
      u.x.prisma.tenant.unitImport.findUniqueOrThrow({ where: { id } }),
    );
  /** Marked deleted, or already purged by the files' sweep. */
  const fileDeleted = async (fileId: string) => {
    const f = await u.x.asManager(c, () =>
      u.x.prisma.tenant.storedFile.findUnique({ where: { id: fileId } }),
    );
    return f === null || f.deletedAt !== null;
  };

  const person = (unit: string, type = 'owner', resides = '') => {
    const email = uniqueEmail('imp');
    return {
      email,
      line: [
        `Imported ${uniqueSuffix()}`,
        uniquePhone(),
        email,
        'national_id',
        nationalIdFor(),
        unit,
        type,
        resides,
      ].join(','),
    };
  };

  it('a units sheet applies once: every unit, in its building, audited as imported', async () => {
    const p = `IM${uniqueSuffix()}`;
    const text = [
      '﻿code,building,floor,unit_type,area_sqm',
      `${p}-1,Tower ${p},3,apartment,120.5`,
      `${p}-2,Tower ${p},,,`,
    ].join('\r\n');
    const checked = (await check('units', text).expect(201)).body as Import;
    expect(checked).toMatchObject({
      kind: 'units',
      status: 'valid',
      rowCount: 2,
      errorCount: 0,
      errors: [],
      appliedCount: null,
    });
    const applied = (await apply(checked.id).expect(201)).body as Import;
    expect(applied).toMatchObject({ status: 'applied', appliedCount: 2 });
    const units = await u.x.asManager(c, () =>
      u.x.prisma.tenant.unit.findMany({
        where: { code: { startsWith: p } },
        orderBy: { code: 'asc' },
      }),
    );
    expect(units.map((x) => [x.code, x.building, x.floor, x.unitType])).toEqual(
      [
        [`${p}-1`, `Tower ${p}`, 3, 'apartment'],
        [`${p}-2`, `Tower ${p}`, null, null],
      ],
    );
    expect(units[0].buildingId).toBe(units[1].buildingId);
    expect(units[0].areaSqm?.toFixed(2)).toBe('120.50');
    const [audit] = await u.audits.tenant(c.tenantId, {
      action: 'unit.created',
      targetId: units[0].id,
    });
    expect(audit).toMatchObject({
      metadata: { imported: true },
      changes: { code: { from: null, to: `${p}-1` } },
    });
    expect(err(await apply(checked.id).expect(409))).toMatchObject({
      code: 'UNIT_IMPORT_NOT_VALID',
      params: { status: 'applied' },
    });
  });

  it('a units sheet’s problems: where and what, never the cell', async () => {
    const taken = await u.newUnit(manager);
    const p = `BAD${uniqueSuffix()}`;
    const header = await check('units', 'code,colour\r\nX-1,red').expect(201);
    expect((header.body as Import).errors).toEqual([
      { line: 1, field: 'colour', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const text = [
      'code,floor,unit_type,area_sqm',
      `,1,,`,
      `${p},500,castle,0`,
      `${p},,,`,
      `${taken.code},,,`,
    ].join('\r\n');
    const res = (await check('units', text).expect(201)).body as Import;
    expect(res).toMatchObject({ status: 'invalid', errorCount: 6 });
    expect(res.errors).toEqual([
      { line: 2, field: 'code', code: 'FIELD_REQUIRED' },
      { line: 3, field: 'floor', code: 'INVALID_NUMBER' },
      { line: 3, field: 'unit_type', code: 'INVALID_VALUE' },
      { line: 3, field: 'area_sqm', code: 'INVALID_NUMBER' },
      { line: 4, field: 'code', code: 'DUPLICATE_VALUE' },
      { line: 5, field: 'code', code: 'DUPLICATE_VALUE' },
    ]);
    expect(JSON.stringify(res)).not.toContain('castle');
    expect(err(await apply(res.id).expect(409)).params).toEqual({
      status: 'invalid',
    });
  });

  it('a sheet that no longer holds when applied becomes invalid, and nothing is created', async () => {
    const p = `LATE${uniqueSuffix()}`;
    const checked = (
      await check('units', `code\r\n${p}-1\r\n${p}-2`).expect(201)
    ).body as Import;
    await u.newUnit(manager, { code: `${p}-2` });
    const res = (await apply(checked.id).expect(201)).body as Import;
    expect(res).toMatchObject({
      status: 'invalid',
      errors: [{ line: 3, field: 'code', code: 'DUPLICATE_VALUE' }],
    });
    expect(
      await u.x.asManager(c, () =>
        u.x.prisma.tenant.unit.count({ where: { code: `${p}-1` } }),
      ),
    ).toBe(0);
  });

  it('a residents sheet applies once: an account and a place each, no email to anyone; the sheet is let go', async () => {
    const home = await u.newUnit(manager);
    const flat = await u.newUnit(manager);
    const owner = person(home.code);
    const tenant = person(flat.code, 'tenant');
    const checked = (
      await check(
        'residents',
        [RESIDENT_HEADER, owner.line, tenant.line].join('\r\n'),
      ).expect(201)
    ).body as Import;
    expect(checked).toMatchObject({ kind: 'residents', status: 'valid' });
    const fileId = (await stored(checked.id)).fileId!;
    expect(await fileDeleted(fileId)).toBe(false);
    const applied = (await apply(checked.id).expect(201)).body as Import;
    expect(applied).toMatchObject({ status: 'applied', appliedCount: 2 });
    expect((await stored(checked.id)).fileId).toBeNull();
    expect(await fileDeleted(fileId)).toBe(true);
    const [a, b] = await Promise.all(
      [home.id, flat.id].map((unitId) => u.x.occupancies(c, unitId)),
    );
    expect(a.map((o) => [o.occupancyType, o.status, o.isPrimary])).toEqual([
      ['owner', 'active', true],
    ]);
    expect(b.map((o) => [o.occupancyType, o.resides])).toEqual([
      ['tenant', true],
    ]);
    const outbox = h.moduleRef.get(GlobalDbService).outboxMessage;
    expect(
      await outbox.count({
        where: { recipient: { in: [owner.email, tenant.email] } },
      }),
    ).toBe(0);
  });

  it('a residents sheet’s problems; an invalid one lets its sheet go at once', async () => {
    const home = await u.newUnit(manager);
    const existing = await u.x.resident(c, [home.id]);
    const one = person(home.code);
    const text = [
      RESIDENT_HEADER,
      one.line,
      // The same email again.
      person(home.code).line.replace(/[^,]+@example\.test/, one.email),
      // A resident's phone already.
      [
        'Second Person',
        existing.phone,
        uniqueEmail('imp'),
        'national_id',
        '123',
        'NO-SUCH-UNIT',
        'tenant',
        'false',
      ].join(','),
    ].join('\r\n');
    const res = (await check('residents', text).expect(201)).body as Import;
    expect(res.status).toBe('invalid');
    expect(res.errors).toEqual([
      { line: 3, field: 'email', code: 'DUPLICATE_VALUE' },
      { line: 4, field: 'phone', code: 'DUPLICATE_VALUE' },
      { line: 4, field: 'id_document_number', code: 'INVALID_NATIONAL_ID' },
      { line: 4, field: 'unit', code: 'UNIT_NOT_AVAILABLE' },
      { line: 4, field: 'resides', code: 'INVALID_VALUE' },
    ]);
    const row = await stored(res.id);
    expect(row.fileId).toBeNull();
    expect(JSON.stringify(res)).not.toContain(existing.phone);
  });

  it('a valid import expires after a day; a residents sheet goes with it', async () => {
    const home = await u.newUnit(manager);
    const checked = (
      await check(
        'residents',
        [RESIDENT_HEADER, person(home.code).line].join('\r\n'),
      ).expect(201)
    ).body as Import;
    const fileId = (await stored(checked.id)).fileId!;
    await h.moduleRef.get(SweepRunner).run(UNIT_IMPORTS_SWEEP, daysLater(2));
    expect(await stored(checked.id)).toMatchObject({
      status: 'expired',
      fileId: null,
    });
    expect(await fileDeleted(fileId)).toBe(true);
    expect(err(await apply(checked.id).expect(409))).toMatchObject({
      code: 'UNIT_IMPORT_NOT_VALID',
      params: { status: 'expired' },
    });
    const [audit] = await u.audits.tenant(c.tenantId, {
      action: 'unit_import.expired',
      targetId: checked.id,
    });
    expect(audit).toMatchObject({ metadata: { kind: 'residents' } });
  });

  it('a sheet a spreadsheet would not write is refused whole (422), with no import left', async () => {
    const res = await check('units', 'code\r\n"open quote').expect(422);
    expect(err(res)).toMatchObject({
      code: 'UNIT_IMPORT_UNREADABLE',
      params: { problem: 'unterminated_quote' },
    });
  });

  describe('races', () => {
    it.each([1, 2, 3])(
      'two applies at once: applied once, the other refused (%i)',
      async () => {
        const p = `RACE${uniqueSuffix()}`;
        const checked = (
          await check('units', `code\r\n${p}-1\r\n${p}-2`).expect(201)
        ).body as Import;
        const results = await Promise.all([
          apply(checked.id),
          apply(checked.id),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(
          await u.x.asManager(c, () =>
            u.x.prisma.tenant.unit.count({
              where: { code: { startsWith: p } },
            }),
          ),
        ).toBe(2);
      },
    );
  });
});
